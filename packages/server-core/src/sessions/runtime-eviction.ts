/**
 * Idle runtime eviction policy for SessionManager (electinfo/ops#549).
 *
 * A session's "runtime" is its backend agent subprocess (claude / pi-agent-server)
 * plus its McpClientPool (one stdio child per enabled MCP source) and, for
 * subprocess backends, the HTTP pool server. It is created lazily on the first
 * message and, before this module existed, was only torn down on a runtime-config
 * change — so every session touched since server start kept ~0.6–1 GiB resident
 * until the process restarted.
 *
 * This module holds the pure, unit-testable parts of the policy:
 *   - env resolution for the idle threshold and the optional live-runtime cap,
 *   - the "is this runtime busy?" predicate,
 *   - time-boxed holds for SDK tools whose work lives inside the subprocess
 *     between turns (ScheduleWakeup, Monitor, CronCreate),
 *   - candidate selection for idle and LRU eviction.
 *
 * SessionManager owns the side effects (timer, locking, disposal).
 */

/** Default idle threshold before a session's runtime is disposed. */
export const DEFAULT_SESSION_IDLE_DISPOSE_MS = 20 * 60_000

/** Never sweep more often than this, nor less often than SWEEP_MAX_INTERVAL_MS. */
const SWEEP_MIN_INTERVAL_MS = 5_000
const SWEEP_MAX_INTERVAL_MS = 60_000

/**
 * Background tasks/shells only pin a runtime while the session shows some sign
 * of life. After this long with no event at all, a "running" entry is assumed
 * to be a lost completion notification rather than real work.
 */
export const BACKGROUND_WORK_STALE_MS = 24 * 60 * 60_000

/** Slack added on top of a tool-declared deadline before the hold expires. */
export const RUNTIME_HOLD_GRACE_MS = 5 * 60_000

/** SDK limits (see @anthropic-ai/claude-agent-sdk sdk-tools.d.ts). */
const MONITOR_DEFAULT_TIMEOUT_MS = 300_000
const MONITOR_MAX_TIMEOUT_MS = 1_800_000
const WAKEUP_MIN_DELAY_S = 60
const WAKEUP_MAX_DELAY_S = 3_600
/** Session crons auto-expire after 7 days in the SDK. */
const CRON_MAX_LIFETIME_MS = 7 * 24 * 60 * 60_000

function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

/**
 * `CRAFT_SESSION_IDLE_DISPOSE_MS`: idle time before a runtime is disposed.
 * `0` disables idle eviction. Invalid values fall back to the default.
 */
export function resolveIdleDisposeMs(env: Record<string, string | undefined> = process.env): number {
  return parseNonNegativeInt(env.CRAFT_SESSION_IDLE_DISPOSE_MS) ?? DEFAULT_SESSION_IDLE_DISPOSE_MS
}

/**
 * `CRAFT_MAX_LIVE_RUNTIMES`: soft cap on concurrently live runtimes. When
 * exceeded, the least recently active non-busy runtimes are disposed even if
 * they have not reached the idle threshold. `0` (default) disables the cap.
 * Busy runtimes are never evicted, so the live count can exceed the cap.
 */
export function resolveMaxLiveRuntimes(env: Record<string, string | undefined> = process.env): number {
  return parseNonNegativeInt(env.CRAFT_MAX_LIVE_RUNTIMES) ?? 0
}

/** Sweep often enough to honour the threshold within ~25%, bounded to [5s, 60s]. */
export function resolveSweepIntervalMs(idleDisposeMs: number): number {
  const quarter = Math.floor(idleDisposeMs / 4)
  return Math.min(SWEEP_MAX_INTERVAL_MS, Math.max(SWEEP_MIN_INTERVAL_MS, quarter))
}

/**
 * Hold a runtime alive while an SDK tool's work lives inside the subprocess
 * between turns. Returns the hold key and its expiry, `{ clear }` to drop a
 * hold, or undefined when the tool is irrelevant. Called for `tool_start`
 * events; the SDK emits an empty-input start first, which is ignored.
 */
export function runtimeHoldForToolStart(
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown> | undefined,
  now: number,
): { key: string; until: number } | { clear: string } | undefined {
  if (!input || Object.keys(input).length === 0) return undefined

  switch (toolName) {
    case 'ScheduleWakeup': {
      if (input.stop === true) return { clear: 'wakeup' }
      const raw = typeof input.delaySeconds === 'number' ? input.delaySeconds : WAKEUP_MAX_DELAY_S
      const delayS = Math.min(WAKEUP_MAX_DELAY_S, Math.max(WAKEUP_MIN_DELAY_S, raw))
      return { key: 'wakeup', until: now + delayS * 1000 + RUNTIME_HOLD_GRACE_MS }
    }
    case 'Monitor': {
      const raw = typeof input.timeout_ms === 'number' ? input.timeout_ms : MONITOR_DEFAULT_TIMEOUT_MS
      const timeout = Math.min(MONITOR_MAX_TIMEOUT_MS, Math.max(0, raw))
      return { key: `monitor:${toolUseId}`, until: now + timeout + RUNTIME_HOLD_GRACE_MS }
    }
    case 'CronCreate':
      // Crons are keyed by an id only known from the tool result; hold for the
      // SDK's maximum lifetime. A cron-bearing session is rare and deliberate.
      return { key: 'cron', until: now + CRON_MAX_LIFETIME_MS }
    default:
      return undefined
  }
}

/** Snapshot of everything that keeps a runtime from being evicted. */
export interface RuntimeBusyState {
  isProcessing: boolean
  stopRequested?: boolean
  /** An in-flight runtime refresh / dispose holds the per-session lock. */
  hasRefreshLock: boolean
  queuedMessages: number
  /** The backend reports an in-flight stream. */
  agentProcessing: boolean
  pendingPermissionRequests: number
  pendingAuthRequest: boolean
  pendingAutoRetry: boolean
  runningBackgroundTasks: number
  liveBackgroundShells: number
  /** Expiry timestamps of tool holds (ScheduleWakeup, Monitor, CronCreate). */
  holdUntil: Iterable<number>
  /** Time since the last runtime activity; gates background-work staleness. */
  idleForMs?: number
}

/** Why a runtime must stay up, or null when it may be disposed. */
export function getRuntimeBusyReason(s: RuntimeBusyState, now: number): string | null {
  if (s.isProcessing || s.stopRequested) return 'turn running'
  if (s.hasRefreshLock) return 'runtime refresh in flight'
  if (s.queuedMessages > 0) return 'queued messages'
  if (s.agentProcessing) return 'backend stream in flight'
  if (s.pendingPermissionRequests > 0) return 'pending permission prompt'
  if (s.pendingAuthRequest) return 'pending auth request'
  if (s.pendingAutoRetry) return 'pending source-activation retry'
  const backgroundFresh = (s.idleForMs ?? 0) < BACKGROUND_WORK_STALE_MS
  if (backgroundFresh && s.runningBackgroundTasks > 0) return 'background task running'
  if (backgroundFresh && s.liveBackgroundShells > 0) return 'background shell running'
  for (const until of s.holdUntil) {
    if (until > now) return 'tool hold (wakeup/monitor/cron)'
  }
  return null
}

export interface EvictionCandidate {
  id: string
  lastActivityAt: number
  busyReason: string | null
}

/**
 * Pick runtimes to dispose: every non-busy runtime idle for `idleDisposeMs`
 * (when > 0), then — if `maxLiveRuntimes` > 0 and still exceeded — the least
 * recently active non-busy runtimes until the count fits (or none remain).
 */
export function selectRuntimeEvictions(
  live: EvictionCandidate[],
  now: number,
  idleDisposeMs: number,
  maxLiveRuntimes: number,
): Array<{ id: string; reason: 'idle' | 'lru' }> {
  const out: Array<{ id: string; reason: 'idle' | 'lru' }> = []
  const evicted = new Set<string>()

  if (idleDisposeMs > 0) {
    for (const c of live) {
      if (c.busyReason === null && now - c.lastActivityAt >= idleDisposeMs) {
        out.push({ id: c.id, reason: 'idle' })
        evicted.add(c.id)
      }
    }
  }

  if (maxLiveRuntimes > 0) {
    let remaining = live.length - evicted.size
    if (remaining > maxLiveRuntimes) {
      const lru = live
        .filter(c => c.busyReason === null && !evicted.has(c.id))
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
      for (const c of lru) {
        if (remaining <= maxLiveRuntimes) break
        out.push({ id: c.id, reason: 'lru' })
        remaining--
      }
    }
  }

  return out
}

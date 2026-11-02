/**
 * Idle runtime reaper — decides when a loaded session's live runtime (the
 * Claude CLI subprocess kept alive between turns + the per-session MCP pool
 * and its stdio servers) can be torn down to free memory.
 *
 * Without it a session's runtime lives until the session is deleted or the
 * server restarts, so a long-running headless server's memory grows with every
 * session touched since boot rather than with the active set. The transcript is
 * on disk and the next message resumes the same SDK session (`sdkSessionId`)
 * through the normal lazy `getOrCreateAgent` path, so reaping an idle runtime
 * loses nothing the user can see.
 *
 * The predicate is deliberately conservative: anything that could still be
 * running, waiting on the user, or holding live state inside the subprocess
 * keeps the runtime alive.
 */

export const IDLE_RUNTIME_REAP_ENV = 'CRAFT_IDLE_RUNTIME_REAP_MINUTES'
export const DEFAULT_IDLE_RUNTIME_REAP_MINUTES = 60

/**
 * Resolve the idle threshold in minutes from the environment.
 * Unset/blank → default (60). `0` disables the reaper. Anything that is not a
 * non-negative finite number falls back to the default.
 */
export function resolveIdleRuntimeReapMinutes(env: Record<string, string | undefined> = process.env): number {
  const raw = env[IDLE_RUNTIME_REAP_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_IDLE_RUNTIME_REAP_MINUTES
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IDLE_RUNTIME_REAP_MINUTES
  return value
}

/** How often to sweep: every 5 minutes, or faster for short thresholds (never below 30s). */
export function idleRuntimeSweepIntervalMs(thresholdMinutes: number): number {
  const thresholdMs = thresholdMinutes * 60_000
  return Math.min(5 * 60_000, Math.max(30_000, Math.floor(thresholdMs / 2)))
}

/** Snapshot of everything the predicate looks at, gathered from a ManagedSession. */
export interface IdleReapCandidate {
  /** Agent, pool server or MCP pool is live — otherwise there is nothing to reap. */
  hasRuntime: boolean
  /** Session-level turn in flight. */
  isProcessing: boolean
  /** Backend reports a turn in flight (covers the gap before/after `isProcessing` flips). */
  agentProcessing: boolean
  /** Stop requested, auth retry, source-activation auto-retry, or a runtime refresh in flight. */
  transitionInFlight: boolean
  queuedMessages: number
  pendingPermissions: number
  pendingAuth: boolean
  pendingPlan: boolean
  /** Background tasks of ANY kind (agent, workflow, shell, monitor, ...) still `running`. */
  runningBackgroundTasks: number
  /** Cron jobs / scheduled wakeups armed inside the live CLI. */
  armedSchedules: number
  /** A browser instance is owned by / bound to this session. `unknown` = could not tell → keep. */
  liveBrowser: boolean | 'unknown'
  /** ms timestamp of the last turn start/end, agent event, or runtime creation. */
  lastActivityAt: number
}

export type IdleReapSkipReason =
  | 'no-runtime'
  | 'not-idle-long-enough'
  | 'processing'
  | 'transition-in-flight'
  | 'queued-messages'
  | 'pending-permission'
  | 'pending-auth'
  | 'pending-plan'
  | 'background-task'
  | 'armed-schedule'
  | 'live-browser'

export type IdleReapDecision =
  | { reap: true; idleMs: number }
  | { reap: false; reason: IdleReapSkipReason; idleMs: number }

/**
 * Pure reap predicate. Reap iff the runtime is live, has been idle for at least
 * `thresholdMs`, and nothing is running, queued, pending or attached.
 * `thresholdMs <= 0` never reaps (the reaper is disabled).
 */
export function evaluateIdleReap(c: IdleReapCandidate, nowMs: number, thresholdMs: number): IdleReapDecision {
  const idleMs = Math.max(0, nowMs - c.lastActivityAt)
  const skip = (reason: IdleReapSkipReason): IdleReapDecision => ({ reap: false, reason, idleMs })
  if (!c.hasRuntime) return skip('no-runtime')
  if (c.isProcessing || c.agentProcessing) return skip('processing')
  if (c.transitionInFlight) return skip('transition-in-flight')
  if (c.queuedMessages > 0) return skip('queued-messages')
  if (c.pendingPermissions > 0) return skip('pending-permission')
  if (c.pendingAuth) return skip('pending-auth')
  if (c.pendingPlan) return skip('pending-plan')
  if (c.runningBackgroundTasks > 0) return skip('background-task')
  if (c.armedSchedules > 0) return skip('armed-schedule')
  if (c.liveBrowser !== false) return skip('live-browser')
  if (!(thresholdMs > 0) || idleMs < thresholdMs) return skip('not-idle-long-enough')
  return { reap: true, idleMs }
}

// ---------------------------------------------------------------------------
// Scheduled work armed inside the CLI (CronCreate / ScheduleWakeup)
// ---------------------------------------------------------------------------

/**
 * A cron job or wakeup the session's CLI armed. These live only inside the
 * subprocess and are invisible to the background-task registry, so the server
 * tracks them from the tool calls it sees. `untilMs` undefined = recurring (cron),
 * kept until a CronDelete is seen or the runtime goes away.
 */
export interface ArmedSchedule {
  kind: 'cron' | 'wakeup'
  armedAt: number
  untilMs?: number
}

/** Grace added after a wakeup's due time before it stops counting as armed. */
export const WAKEUP_GRACE_MS = 5 * 60_000
const WAKEUP_MAX_DELAY_S = 3600
const WAKEUP_MIN_DELAY_S = 60

/**
 * Tracks scheduler tool calls seen for one live runtime. tool_start fires twice
 * per call (empty input, then full input), so every update is keyed by toolUseId
 * and idempotent — the later call wins.
 */
export class ArmedScheduleTracker {
  private readonly schedules = new Map<string, ArmedSchedule>()
  private readonly seenDeletes = new Set<string>()

  /** Record a tool call; returns true when it was a scheduler tool. */
  note(toolName: string, toolUseId: string, input: Record<string, unknown> | undefined, nowMs: number): boolean {
    const name = toolName.replace(/^mcp__.+?__/, '')
    if (name === 'CronCreate') {
      const existing = this.schedules.get(toolUseId)
      this.schedules.set(toolUseId, { kind: 'cron', armedAt: existing?.armedAt ?? nowMs })
      return true
    }
    if (name === 'CronDelete') {
      // The deleted job's id is only in CronCreate's result: drop one cron entry
      // (the oldest) so creates minus deletes stays the count of live jobs.
      if (this.seenDeletes.has(toolUseId)) return true
      this.seenDeletes.add(toolUseId)
      let oldestKey: string | undefined
      let oldestAt = Infinity
      for (const [key, s] of this.schedules) {
        if (s.kind === 'cron' && s.armedAt < oldestAt) { oldestAt = s.armedAt; oldestKey = key }
      }
      if (oldestKey) this.schedules.delete(oldestKey)
      return true
    }
    if (name === 'ScheduleWakeup') {
      if (input?.stop === true) {
        for (const [key, s] of this.schedules) if (s.kind === 'wakeup') this.schedules.delete(key)
        return true
      }
      const armedAt = this.schedules.get(toolUseId)?.armedAt ?? nowMs
      const raw = Number(input?.delaySeconds)
      const delayS = Number.isFinite(raw) && input?.delaySeconds !== undefined
        ? Math.min(WAKEUP_MAX_DELAY_S, Math.max(WAKEUP_MIN_DELAY_S, raw))
        : WAKEUP_MAX_DELAY_S
      this.schedules.set(toolUseId, { kind: 'wakeup', armedAt, untilMs: armedAt + delayS * 1000 + WAKEUP_GRACE_MS })
      return true
    }
    return false
  }

  /** A scheduler call that errored armed nothing. */
  noteResult(toolUseId: string, isError: boolean): void {
    if (isError) this.schedules.delete(toolUseId)
  }

  /** Schedules still armed at `nowMs`. Crons (recurring or one-shot) count until a CronDelete. */
  countArmed(nowMs: number): number {
    let armed = 0
    for (const s of this.schedules.values()) {
      if (s.untilMs === undefined || s.untilMs > nowMs) armed++
    }
    return armed
  }
}

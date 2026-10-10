import { describe, expect, it } from 'bun:test'
import {
  BACKGROUND_WORK_STALE_MS,
  DEFAULT_SESSION_IDLE_DISPOSE_MS,
  RUNTIME_HOLD_GRACE_MS,
  getRuntimeBusyReason,
  resolveIdleDisposeMs,
  resolveMaxLiveRuntimes,
  resolveSweepIntervalMs,
  runtimeHoldForToolStart,
  selectRuntimeEvictions,
  type RuntimeBusyState,
} from './runtime-eviction.ts'

// Pure policy for idle runtime eviction (electinfo/ops#549).

const idleState = (over: Partial<RuntimeBusyState> = {}): RuntimeBusyState => ({
  isProcessing: false,
  hasRefreshLock: false,
  queuedMessages: 0,
  agentProcessing: false,
  pendingPermissionRequests: 0,
  pendingAuthRequest: false,
  pendingAutoRetry: false,
  runningBackgroundTasks: 0,
  liveBackgroundShells: 0,
  holdUntil: [],
  ...over,
})

describe('env resolution', () => {
  it('defaults the idle threshold and leaves the LRU cap off', () => {
    expect(resolveIdleDisposeMs({})).toBe(DEFAULT_SESSION_IDLE_DISPOSE_MS)
    expect(resolveMaxLiveRuntimes({})).toBe(0)
  })

  it('accepts explicit values, including 0 to disable', () => {
    expect(resolveIdleDisposeMs({ CRAFT_SESSION_IDLE_DISPOSE_MS: '60000' })).toBe(60_000)
    expect(resolveIdleDisposeMs({ CRAFT_SESSION_IDLE_DISPOSE_MS: '0' })).toBe(0)
    expect(resolveMaxLiveRuntimes({ CRAFT_MAX_LIVE_RUNTIMES: '12' })).toBe(12)
  })

  it('falls back to defaults on garbage', () => {
    expect(resolveIdleDisposeMs({ CRAFT_SESSION_IDLE_DISPOSE_MS: 'soon' })).toBe(DEFAULT_SESSION_IDLE_DISPOSE_MS)
    expect(resolveIdleDisposeMs({ CRAFT_SESSION_IDLE_DISPOSE_MS: '-5' })).toBe(DEFAULT_SESSION_IDLE_DISPOSE_MS)
    expect(resolveMaxLiveRuntimes({ CRAFT_MAX_LIVE_RUNTIMES: '' })).toBe(0)
  })

  it('bounds the sweep interval to [5s, 60s]', () => {
    expect(resolveSweepIntervalMs(DEFAULT_SESSION_IDLE_DISPOSE_MS)).toBe(60_000)
    expect(resolveSweepIntervalMs(1_000)).toBe(5_000)
    expect(resolveSweepIntervalMs(100_000)).toBe(25_000)
  })
})

describe('getRuntimeBusyReason', () => {
  const now = 1_000_000

  it('is null for a quiet runtime', () => {
    expect(getRuntimeBusyReason(idleState(), now)).toBeNull()
  })

  it.each([
    ['turn running', { isProcessing: true }],
    ['turn running', { stopRequested: true }],
    ['runtime refresh in flight', { hasRefreshLock: true }],
    ['queued messages', { queuedMessages: 1 }],
    ['backend stream in flight', { agentProcessing: true }],
    ['pending permission prompt', { pendingPermissionRequests: 1 }],
    ['pending auth request', { pendingAuthRequest: true }],
    ['pending source-activation retry', { pendingAutoRetry: true }],
    ['background task running', { runningBackgroundTasks: 2 }],
    ['background shell running', { liveBackgroundShells: 1 }],
    ['tool hold (wakeup/monitor/cron)', { holdUntil: [now + 1] }],
  ] as Array<[string, Partial<RuntimeBusyState>]>)('reports %s', (reason, over) => {
    expect(getRuntimeBusyReason(idleState(over), now)).toBe(reason)
  })

  it('stops counting background work after a day without any activity', () => {
    const stale = idleState({ runningBackgroundTasks: 1, liveBackgroundShells: 1, idleForMs: BACKGROUND_WORK_STALE_MS })
    expect(getRuntimeBusyReason(stale, now)).toBeNull()
    // Turns and prompts are never treated as stale.
    expect(getRuntimeBusyReason({ ...stale, pendingPermissionRequests: 1 }, now)).toBe('pending permission prompt')
  })

  it('ignores expired holds', () => {
    expect(getRuntimeBusyReason(idleState({ holdUntil: [now - 1, now] }), now)).toBeNull()
  })
})

describe('runtimeHoldForToolStart', () => {
  const now = 5_000_000

  it('ignores the empty-input first tool_start and unrelated tools', () => {
    expect(runtimeHoldForToolStart('ScheduleWakeup', 't1', {}, now)).toBeUndefined()
    expect(runtimeHoldForToolStart('Bash', 't1', { command: 'ls' }, now)).toBeUndefined()
  })

  it('holds for a ScheduleWakeup delay (clamped to the SDK range) plus grace', () => {
    expect(runtimeHoldForToolStart('ScheduleWakeup', 't1', { delaySeconds: 1200 }, now))
      .toEqual({ key: 'wakeup', until: now + 1_200_000 + RUNTIME_HOLD_GRACE_MS })
    expect(runtimeHoldForToolStart('ScheduleWakeup', 't1', { delaySeconds: 99_999 }, now))
      .toEqual({ key: 'wakeup', until: now + 3_600_000 + RUNTIME_HOLD_GRACE_MS })
    expect(runtimeHoldForToolStart('ScheduleWakeup', 't1', { delaySeconds: 1 }, now))
      .toEqual({ key: 'wakeup', until: now + 60_000 + RUNTIME_HOLD_GRACE_MS })
  })

  it('clears the wakeup hold when the loop is stopped', () => {
    expect(runtimeHoldForToolStart('ScheduleWakeup', 't1', { stop: true }, now)).toEqual({ clear: 'wakeup' })
  })

  it('holds a Monitor for its timeout (default 5 min, capped at 30 min)', () => {
    expect(runtimeHoldForToolStart('Monitor', 'm1', { description: 'x', command: 'tail -f' }, now))
      .toEqual({ key: 'monitor:m1', until: now + 300_000 + RUNTIME_HOLD_GRACE_MS })
    expect(runtimeHoldForToolStart('Monitor', 'm2', { description: 'x', timeout_ms: 9_999_999 }, now))
      .toEqual({ key: 'monitor:m2', until: now + 1_800_000 + RUNTIME_HOLD_GRACE_MS })
  })

  it('holds a session cron for the SDK maximum lifetime', () => {
    const hold = runtimeHoldForToolStart('CronCreate', 'c1', { cron: '*/5 * * * *', prompt: 'p' }, now)
    expect(hold).toEqual({ key: 'cron', until: now + 7 * 24 * 60 * 60_000 })
  })
})

describe('selectRuntimeEvictions', () => {
  const now = 10_000_000
  const idleMs = 20 * 60_000

  it('evicts only non-busy runtimes past the idle threshold', () => {
    const picks = selectRuntimeEvictions([
      { id: 'old', lastActivityAt: now - idleMs, busyReason: null },
      { id: 'fresh', lastActivityAt: now - idleMs + 1, busyReason: null },
      { id: 'old-busy', lastActivityAt: now - 10 * idleMs, busyReason: 'turn running' },
    ], now, idleMs, 0)
    expect(picks).toEqual([{ id: 'old', reason: 'idle' }])
  })

  it('does nothing when both knobs are off', () => {
    expect(selectRuntimeEvictions([
      { id: 'a', lastActivityAt: 0, busyReason: null },
    ], now, 0, 0)).toEqual([])
  })

  it('enforces the cap by evicting least-recently-active idle runtimes first', () => {
    const picks = selectRuntimeEvictions([
      { id: 'newest', lastActivityAt: now - 1_000, busyReason: null },
      { id: 'busy', lastActivityAt: now - 9_000, busyReason: 'turn running' },
      { id: 'oldest', lastActivityAt: now - 8_000, busyReason: null },
      { id: 'middle', lastActivityAt: now - 5_000, busyReason: null },
    ], now, idleMs, 2)
    expect(picks).toEqual([
      { id: 'oldest', reason: 'lru' },
      { id: 'middle', reason: 'lru' },
    ])
  })

  it('counts idle evictions toward the cap and never evicts busy runtimes to fit', () => {
    const picks = selectRuntimeEvictions([
      { id: 'stale', lastActivityAt: now - idleMs * 2, busyReason: null },
      { id: 'b1', lastActivityAt: now - 1, busyReason: 'turn running' },
      { id: 'b2', lastActivityAt: now - 2, busyReason: 'background task running' },
    ], now, idleMs, 1)
    expect(picks).toEqual([{ id: 'stale', reason: 'idle' }])
  })
})

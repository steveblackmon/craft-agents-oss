import { describe, expect, it } from 'bun:test'
import {
  ArmedScheduleTracker,
  DEFAULT_IDLE_RUNTIME_REAP_MINUTES,
  WAKEUP_GRACE_MS,
  evaluateIdleReap,
  idleRuntimeSweepIntervalMs,
  resolveIdleRuntimeReapMinutes,
  type IdleReapCandidate,
} from './idle-runtime-reaper.ts'

const MIN = 60_000
const NOW = 1_800_000_000_000
const THRESHOLD = 60 * MIN

function idleCandidate(overrides: Partial<IdleReapCandidate> = {}): IdleReapCandidate {
  return {
    hasRuntime: true,
    isProcessing: false,
    agentProcessing: false,
    transitionInFlight: false,
    queuedMessages: 0,
    pendingPermissions: 0,
    pendingAuth: false,
    pendingPlan: false,
    runningBackgroundTasks: 0,
    armedSchedules: 0,
    liveBrowser: false,
    lastActivityAt: NOW - 61 * MIN,
    ...overrides,
  }
}

describe('evaluateIdleReap', () => {
  it('reaps a live runtime idle past the threshold with nothing pending', () => {
    const d = evaluateIdleReap(idleCandidate(), NOW, THRESHOLD)
    expect(d).toEqual({ reap: true, idleMs: 61 * MIN })
  })

  it('reaps exactly at the threshold', () => {
    expect(evaluateIdleReap(idleCandidate({ lastActivityAt: NOW - THRESHOLD }), NOW, THRESHOLD).reap).toBe(true)
  })

  // Every guard on its own must keep the runtime. Each row flips exactly one input.
  const guards: Array<[string, Partial<IdleReapCandidate>, string]> = [
    ['no live runtime', { hasRuntime: false }, 'no-runtime'],
    ['idle less than the threshold', { lastActivityAt: NOW - 59 * MIN }, 'not-idle-long-enough'],
    ['activity after the sweep began (clock ahead)', { lastActivityAt: NOW + 1 }, 'not-idle-long-enough'],
    ['session processing', { isProcessing: true }, 'processing'],
    ['backend processing', { agentProcessing: true }, 'processing'],
    ['stop/auth-retry/refresh in flight', { transitionInFlight: true }, 'transition-in-flight'],
    ['queued messages', { queuedMessages: 1 }, 'queued-messages'],
    ['pending permission', { pendingPermissions: 1 }, 'pending-permission'],
    ['pending auth', { pendingAuth: true }, 'pending-auth'],
    ['pending plan', { pendingPlan: true }, 'pending-plan'],
    ['running background task', { runningBackgroundTasks: 1 }, 'background-task'],
    ['armed cron/wakeup', { armedSchedules: 1 }, 'armed-schedule'],
    ['live browser', { liveBrowser: true }, 'live-browser'],
    ['browser state unknown', { liveBrowser: 'unknown' }, 'live-browser'],
  ]
  for (const [label, override, reason] of guards) {
    it(`keeps the runtime when: ${label}`, () => {
      const d = evaluateIdleReap(idleCandidate(override), NOW, THRESHOLD)
      expect(d.reap).toBe(false)
      expect(d.reap === false && d.reason).toBe(reason)
    })
  }

  it('never reaps when disabled (threshold 0)', () => {
    const ancient = idleCandidate({ lastActivityAt: 0 })
    expect(evaluateIdleReap(ancient, NOW, 0).reap).toBe(false)
    expect(evaluateIdleReap(ancient, NOW, -1).reap).toBe(false)
    expect(evaluateIdleReap(ancient, NOW, Number.NaN).reap).toBe(false)
  })
})

describe('resolveIdleRuntimeReapMinutes', () => {
  it('defaults to 60 when unset or blank', () => {
    expect(DEFAULT_IDLE_RUNTIME_REAP_MINUTES).toBe(60)
    expect(resolveIdleRuntimeReapMinutes({})).toBe(60)
    expect(resolveIdleRuntimeReapMinutes({ CRAFT_IDLE_RUNTIME_REAP_MINUTES: '  ' })).toBe(60)
  })
  it('honours an explicit value, including 0 (disabled)', () => {
    expect(resolveIdleRuntimeReapMinutes({ CRAFT_IDLE_RUNTIME_REAP_MINUTES: '15' })).toBe(15)
    expect(resolveIdleRuntimeReapMinutes({ CRAFT_IDLE_RUNTIME_REAP_MINUTES: '0' })).toBe(0)
    expect(resolveIdleRuntimeReapMinutes({ CRAFT_IDLE_RUNTIME_REAP_MINUTES: '0.5' })).toBe(0.5)
  })
  it('falls back to the default on garbage or negatives', () => {
    expect(resolveIdleRuntimeReapMinutes({ CRAFT_IDLE_RUNTIME_REAP_MINUTES: 'soon' })).toBe(60)
    expect(resolveIdleRuntimeReapMinutes({ CRAFT_IDLE_RUNTIME_REAP_MINUTES: '-5' })).toBe(60)
  })
})

describe('idleRuntimeSweepIntervalMs', () => {
  it('sweeps every 5 minutes for the default threshold', () => {
    expect(idleRuntimeSweepIntervalMs(60)).toBe(5 * MIN)
  })
  it('sweeps faster for short thresholds but never below 30s', () => {
    expect(idleRuntimeSweepIntervalMs(4)).toBe(2 * MIN)
    expect(idleRuntimeSweepIntervalMs(0.1)).toBe(30_000)
  })
})

describe('ArmedScheduleTracker', () => {
  it('ignores non-scheduler tools', () => {
    const t = new ArmedScheduleTracker()
    expect(t.note('Bash', 'tu1', { command: 'ls' }, NOW)).toBe(false)
    expect(t.countArmed(NOW)).toBe(0)
  })

  it('counts a cron as armed indefinitely, until a CronDelete', () => {
    const t = new ArmedScheduleTracker()
    t.note('CronCreate', 'c1', {}, NOW)
    t.note('CronCreate', 'c1', { cron: '0 * * * *', prompt: 'x' }, NOW + 1) // dual tool_start event
    expect(t.countArmed(NOW + 1000 * MIN)).toBe(1)
    t.note('CronCreate', 'c2', {}, NOW + 2)
    expect(t.countArmed(NOW + 1000 * MIN)).toBe(2)
    t.note('CronDelete', 'd1', {}, NOW + 3)
    t.note('CronDelete', 'd1', { id: 'abc' }, NOW + 4) // same call, second event: must not delete twice
    expect(t.countArmed(NOW + 1000 * MIN)).toBe(1)
    t.note('CronDelete', 'd2', { id: 'def' }, NOW + 5)
    expect(t.countArmed(NOW + 1000 * MIN)).toBe(0)
  })

  it('counts a wakeup until its due time plus grace', () => {
    const t = new ArmedScheduleTracker()
    t.note('ScheduleWakeup', 'w1', {}, NOW)
    t.note('ScheduleWakeup', 'w1', { delaySeconds: 600, prompt: 'p' }, NOW + 50) // full input wins, armedAt kept
    const due = NOW + 600_000 + WAKEUP_GRACE_MS
    expect(t.countArmed(due - 1)).toBe(1)
    expect(t.countArmed(due)).toBe(0)
  })

  it('clamps wakeup delays to [60, 3600] and treats a missing delay as the max', () => {
    const t = new ArmedScheduleTracker()
    t.note('ScheduleWakeup', 'w-long', { delaySeconds: 99_999 }, NOW)
    expect(t.countArmed(NOW + 3600_000 + WAKEUP_GRACE_MS - 1)).toBe(1)
    expect(t.countArmed(NOW + 3600_000 + WAKEUP_GRACE_MS)).toBe(0)
    const u = new ArmedScheduleTracker()
    u.note('ScheduleWakeup', 'w-none', {}, NOW)
    expect(u.countArmed(NOW + 3600_000 + WAKEUP_GRACE_MS - 1)).toBe(1)
  })

  it('a ScheduleWakeup stop clears pending wakeups but not crons', () => {
    const t = new ArmedScheduleTracker()
    t.note('ScheduleWakeup', 'w1', { delaySeconds: 600 }, NOW)
    t.note('CronCreate', 'c1', {}, NOW)
    t.note('ScheduleWakeup', 'w2', { stop: true }, NOW + 1)
    expect(t.countArmed(NOW + 2)).toBe(1)
  })

  it('recognises MCP-prefixed scheduler tool names', () => {
    const t = new ArmedScheduleTracker()
    expect(t.note('mcp__session__CronCreate', 'c1', {}, NOW)).toBe(true)
    expect(t.countArmed(NOW)).toBe(1)
  })
})

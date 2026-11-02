import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { ArmedScheduleTracker } from './idle-runtime-reaper.ts'

const MIN = 60_000
const NOW = 1_800_000_000_000

function inject(sm: SessionManager, id: string, root: string, agentExtra: Record<string, unknown> = {}) {
  const workspace = { id: 'ws_test', name: 'T', rootPath: root, createdAt: Date.now() }
  const managed = createManagedSession({ id, name: id }, workspace as never, { messagesLoaded: true }) as unknown as Record<string, any>
  managed.agent = { isProcessing: () => false, dispose: () => {}, ...agentExtra }
  managed.mcpPool = { getConnectedSlugs: () => ['x'], disconnectAll: async () => {} }
  managed.sdkSessionId = 'sdk-' + id
  managed.lastRuntimeActivityAt = NOW - 61 * MIN
  ;(sm as any).sessions.set(id, managed)
  return managed
}

describe('idle-reap round-2 regressions', () => {
  let root: string; let sm: SessionManager
  beforeEach(() => { delete process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES; root = mkdtempSync(join(tmpdir(), 'r2-')); sm = new SessionManager() })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('stale "running" task survives the reap and pins the NEXT runtime forever', async () => {
    const m = inject(sm, 's', root, { hasLiveQuery: () => false })
    m.backgroundTaskRegistry.set('t1', { taskId: 't1', startTime: NOW - 90 * MIN, status: 'running', kind: 'shell' })
    expect((await sm.sweepIdleRuntimes(NOW)).reaped).toEqual(['s'])        // first reap OK (round-1 fix)
    expect(m.backgroundTaskRegistry.get('t1').status).toBe('orphaned')       // dispose orphans tasks that died with the CLI
    // next message rebuilds a runtime with a live persistent query; then idle again
    m.agent = { isProcessing: () => true, isTurnInFlight: () => false, hasLiveQuery: () => true, dispose: () => {} }
    m.lastRuntimeActivityAt = NOW + 10 * MIN
    const r = await sm.sweepIdleRuntimes(NOW + 200 * MIN)
    expect(r.reaped).toEqual(['s'])   // stale entry was orphaned at dispose, so the idle runtime reaps again
  })

  it('an ERRORED CronDelete still drops a live cron from the tracker (under-count -> cron killed by reap)', () => {
    const t = new ArmedScheduleTracker()
    t.note('CronCreate', 'c1', { cron: '0 */2 * * *', prompt: 'x' }, NOW)
    t.note('CronDelete', 'd1', { id: 'wrong-id' }, NOW + 1)
    t.noteResult('d1', true)   // CronDelete failed: nothing was deleted in the CLI
    expect(t.countArmed(NOW + 2)).toBe(1) // errored delete restores the live cron
  })

  it('a SUCCESSFUL CronDelete still removes the cron (restore only on error)', () => {
    const t = new ArmedScheduleTracker()
    t.note('CronCreate', 'c1', { cron: '0 */2 * * *', prompt: 'x' }, NOW)
    t.note('CronDelete', 'd1', { id: 'job-1' }, NOW + 1)
    t.noteResult('d1', false)
    expect(t.countArmed(NOW + 2)).toBe(0)
  })
})

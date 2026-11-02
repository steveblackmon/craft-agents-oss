import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// SessionManager-level coverage for the idle runtime reaper (storeminder#2095):
// the sweep must read each guard from the real ManagedSession / SessionManager
// state, and a reap must go through disposeManagedAgentRuntime while keeping
// everything the next turn needs to resume (sdkSessionId, transcript).

const MIN = 60_000
const NOW = 1_800_000_000_000

interface RuntimeStubs {
  agentDisposed: number
  poolServerStopped: number
  poolDisconnected: number
}

function injectIdleSession(sm: SessionManager, id: string, workspaceRoot: string, opts: { idleMinutes?: number; disposeDelayMs?: number } = {}) {
  const stubs: RuntimeStubs = { agentDisposed: 0, poolServerStopped: 0, poolDisconnected: 0 }
  const workspace = { id: 'ws_test', name: 'Test Workspace', rootPath: workspaceRoot, createdAt: Date.now() }
  const managed = createManagedSession({ id, name: id }, workspace as never, { messagesLoaded: true }) as unknown as Record<string, any>
  managed.agent = {
    isProcessing: () => false,
    dispose: () => { stubs.agentDisposed++ },
  }
  managed.poolServer = {
    stop: async () => {
      if (opts.disposeDelayMs) await new Promise(r => setTimeout(r, opts.disposeDelayMs))
      stubs.poolServerStopped++
    },
  }
  managed.mcpPool = {
    getConnectedSlugs: () => ['grafana', 'vault'],
    disconnectAll: async () => { stubs.poolDisconnected++ },
  }
  managed.sdkSessionId = `sdk-${id}`
  managed.lastRuntimeActivityAt = NOW - (opts.idleMinutes ?? 61) * MIN
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  return { managed, stubs }
}

describe('SessionManager.sweepIdleRuntimes', () => {
  let tmpRoot: string
  let sm: SessionManager
  const prevEnv = process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES

  beforeEach(() => {
    delete process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-idle-reap-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES
    else process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES = prevEnv
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('reaps an idle session: CLI disposed, pool server stopped, MCP pool disconnected, resume state kept', async () => {
    const { managed, stubs } = injectIdleSession(sm, 'idle', tmpRoot)
    managed.messages.push({ id: 'm1', role: 'user', content: 'hi', timestamp: NOW - 70 * MIN })

    const result = await sm.sweepIdleRuntimes(NOW)

    expect(result.reaped).toEqual(['idle'])
    expect(stubs).toEqual({ agentDisposed: 1, poolServerStopped: 1, poolDisconnected: 1 })
    expect(managed.agent).toBeNull()
    expect(managed.poolServer).toBeUndefined()
    expect(managed.mcpPool).toBeUndefined()
    // What the next getOrCreateAgent needs to resume the same conversation:
    expect(managed.sdkSessionId).toBe('sdk-idle')
    expect(managed.messages).toHaveLength(1)
    // A second sweep finds nothing left to reap.
    expect((await sm.sweepIdleRuntimes(NOW + MIN)).reaped).toEqual([])
  })

  it('leaves sessions idle less than 60 minutes alone', async () => {
    const { stubs } = injectIdleSession(sm, 'recent', tmpRoot, { idleMinutes: 59 })
    expect((await sm.sweepIdleRuntimes(NOW)).reaped).toEqual([])
    expect(stubs.agentDisposed).toBe(0)
  })

  it('falls back to lastMessageAt when no runtime activity was recorded', async () => {
    const { managed } = injectIdleSession(sm, 'legacy', tmpRoot)
    managed.lastRuntimeActivityAt = undefined
    managed.lastMessageAt = NOW - 10 * MIN
    expect((await sm.sweepIdleRuntimes(NOW)).reaped).toEqual([])
    managed.lastMessageAt = NOW - 90 * MIN
    expect((await sm.sweepIdleRuntimes(NOW)).reaped).toEqual(['legacy'])
  })

  it('honours CRAFT_IDLE_RUNTIME_REAP_MINUTES=0 (disabled)', async () => {
    process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES = '0'
    const disabled = new SessionManager()
    const { stubs } = injectIdleSession(disabled, 'ancient', tmpRoot, { idleMinutes: 10_000 })
    expect((await disabled.sweepIdleRuntimes(NOW)).reaped).toEqual([])
    expect(stubs.agentDisposed).toBe(0)
  })

  it('honours a custom CRAFT_IDLE_RUNTIME_REAP_MINUTES', async () => {
    process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES = '15'
    const short = new SessionManager()
    injectIdleSession(short, 'sixteen', tmpRoot, { idleMinutes: 16 })
    injectIdleSession(short, 'fourteen', tmpRoot, { idleMinutes: 14 })
    expect((await short.sweepIdleRuntimes(NOW)).reaped).toEqual(['sixteen'])
  })

  // Each guard, set through the real SessionManager state, must keep the runtime.
  const guards: Array<[string, (sm: SessionManager, m: Record<string, any>) => void, string]> = [
    ['session processing', (_sm, m) => { m.isProcessing = true }, 'processing'],
    ['backend reports processing', (_sm, m) => { m.agent.isProcessing = () => true }, 'processing'],
    ['stop requested', (_sm, m) => { m.stopRequested = true }, 'transition-in-flight'],
    ['auth retry in progress', (_sm, m) => { m.authRetryInProgress = true }, 'transition-in-flight'],
    ['source-activation auto-retry armed', (_sm, m) => { m.autoRetryTimer = setTimeout(() => {}, 1); clearTimeout(m.autoRetryTimer) }, 'transition-in-flight'],
    ['runtime refresh in flight', (sm, m) => { (sm as any).agentRefreshLocks.set(m.id, Promise.resolve()) }, 'transition-in-flight'],
    ['queued message', (_sm, m) => { m.messageQueue.push({ message: 'later' }) }, 'queued-messages'],
    ['pending permission request', (sm, m) => { (sm as any).pendingPermissionRequests.set('req-1', { sessionId: m.id, type: 'bash' }) }, 'pending-permission'],
    ['pending auth request', (_sm, m) => { m.pendingAuthRequestId = 'auth-1' }, 'pending-auth'],
    ['plan awaiting the user', (_sm, m) => { m.lastMessageRole = 'plan' }, 'pending-plan'],
    ['accept-and-compact plan execution', (_sm, m) => { m.pendingPlanExecution = { planPath: '/x' } }, 'pending-plan'],
    ['running background shell', (_sm, m) => { m.backgroundTaskRegistry.set('t1', { taskId: 't1', startTime: NOW, status: 'running', kind: 'shell' }) }, 'background-task'],
    ['running background monitor/task', (_sm, m) => { m.backgroundTaskRegistry.set('t2', { taskId: 't2', startTime: NOW, status: 'running', kind: 'task' }) }, 'background-task'],
    ['running untracked sub-agent task', (_sm, m) => { m.backgroundTaskRegistry.set('t3', { taskId: 't3', startTime: NOW, status: 'running', untracked: true }) }, 'background-task'],
  ]
  for (const [label, arrange, reason] of guards) {
    it(`keeps the runtime when: ${label}`, async () => {
      const { managed, stubs } = injectIdleSession(sm, 'guarded', tmpRoot)
      arrange(sm, managed)
      const result = await sm.sweepIdleRuntimes(NOW)
      expect(result.reaped).toEqual([])
      expect(result.blocked).toEqual({ [reason]: 1 })
      expect(stubs.agentDisposed).toBe(0)
      expect(managed.mcpPool).toBeDefined()
    })
  }

  it('does not count a pending permission belonging to another session', async () => {
    injectIdleSession(sm, 'mine', tmpRoot)
    ;(sm as any).pendingPermissionRequests.set('req-1', { sessionId: 'someone-else' })
    expect((await sm.sweepIdleRuntimes(NOW)).reaped).toEqual(['mine'])
  })

  it('reaps once background tasks are terminal', async () => {
    const { managed } = injectIdleSession(sm, 'done-tasks', tmpRoot)
    managed.backgroundTaskRegistry.set('t1', { taskId: 't1', startTime: NOW - 90 * MIN, status: 'completed', kind: 'shell' })
    managed.backgroundTaskRegistry.set('t2', { taskId: 't2', startTime: NOW - 90 * MIN, status: 'orphaned', kind: 'agent' })
    expect((await sm.sweepIdleRuntimes(NOW)).reaped).toEqual(['done-tasks'])
  })

  it('keeps a session whose browser instance is live (local browser pane manager)', async () => {
    const { stubs } = injectIdleSession(sm, 'browsing', tmpRoot)
    injectIdleSession(sm, 'other', tmpRoot)
    ;(sm as any).browserPaneManager = {
      listInstances: () => [{ id: 'b1', ownerSessionId: 'browsing', boundSessionId: null }],
    }
    const result = await sm.sweepIdleRuntimes(NOW)
    expect(result.reaped).toEqual(['other'])
    expect(result.blocked).toEqual({ 'live-browser': 1 })
    expect(stubs.agentDisposed).toBe(0)
  })

  it('keeps a session bound (not owned) to a browser instance', async () => {
    injectIdleSession(sm, 'bound', tmpRoot)
    ;(sm as any).browserPaneManager = {
      listInstances: () => [{ id: 'b1', ownerSessionId: null, boundSessionId: 'bound' }],
    }
    expect((await sm.sweepIdleRuntimes(NOW)).blocked).toEqual({ 'live-browser': 1 })
  })

  it('keeps the runtime when the browser query throws (unknown)', async () => {
    injectIdleSession(sm, 'unknown', tmpRoot)
    ;(sm as any).browserPaneManager = { listInstances: () => { throw new Error('bridge down') } }
    expect((await sm.sweepIdleRuntimes(NOW)).blocked).toEqual({ 'live-browser': 1 })
  })

  it('keeps a session whose CLI armed a cron (seen via tool_start), reaps after CronDelete', async () => {
    const { managed } = injectIdleSession(sm, 'looping', tmpRoot)
    const pe = (sm as any).processEvent.bind(sm)
    await pe(managed, { type: 'tool_start', toolName: 'CronCreate', toolUseId: 'c1', input: { cron: '0 * * * *', prompt: 'tick' } })
    managed.lastRuntimeActivityAt = NOW - 61 * MIN // the event itself counted as activity; age it
    expect((await sm.sweepIdleRuntimes(NOW)).blocked).toEqual({ 'armed-schedule': 1 })
    await pe(managed, { type: 'tool_start', toolName: 'CronDelete', toolUseId: 'd1', input: { id: 'x' } })
    managed.lastRuntimeActivityAt = NOW - 61 * MIN
    expect((await sm.sweepIdleRuntimes(NOW)).reaped).toEqual(['looping'])
    // The schedules died with the CLI: a rebuilt runtime starts clean.
    expect(managed.armedSchedules).toBeUndefined()
  })

  it('agent events and turn transitions count as activity', async () => {
    const { managed } = injectIdleSession(sm, 'active', tmpRoot)
    const before = Date.now()
    managed.lastRuntimeActivityAt = 0
    await (sm as any).processEvent(managed, { type: 'text_delta', text: 'x', turnId: 't' })
    expect(managed.lastRuntimeActivityAt).toBeGreaterThanOrEqual(before)
    managed.lastRuntimeActivityAt = 0
    ;(sm as any).setProcessing(managed, false)
    expect(managed.lastRuntimeActivityAt).toBeGreaterThanOrEqual(before)
  })

  it('a message arriving mid-reap waits on the refresh lock instead of racing teardown', async () => {
    const { managed } = injectIdleSession(sm, 'racy', tmpRoot, { disposeDelayMs: 30 })
    const sweep = sm.sweepIdleRuntimes(NOW)
    // Let the sweep reach disposeManagedAgentRuntime's first await.
    await new Promise(r => setTimeout(r, 5))
    const lock = (sm as any).agentRefreshLocks.get('racy') as Promise<void> | undefined
    expect(lock).toBeDefined()
    // While held, a concurrent sweep must not double-reap.
    expect((await sm.sweepIdleRuntimes(NOW)).reaped).toEqual([])
    await lock
    expect(managed.mcpPool).toBeUndefined()
    expect((await sweep).reaped).toEqual(['racy'])
    expect((sm as any).agentRefreshLocks.has('racy')).toBe(false)
  })
})

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as backend from '@craft-agent/shared/agent/backend'
import type { McpClientPool } from '@craft-agent/shared/mcp'
import { SessionManager, createManagedSession, setSessionPlatform } from './SessionManager.ts'

// Idle runtime eviction (electinfo/ops#549): a session's agent subprocess and
// its stdio MCP servers are released after the idle threshold, on archive and
// on delete — and the next message rebuilds them with tools available.
//
// Isolated: setSessionPlatform is process-global, and the backend factory is
// stubbed. The MCP side is real: each session spawns a stdio fixture server
// (`__fixtures__/pid-mcp-server.ts`) through the real McpClientPool, so the
// tests observe actual child processes being reaped and respawned.

setSessionPlatform({
  appRootPath: '/tmp/idle-runtime-test',
  resourcesPath: '/tmp/idle-runtime-test/resources',
  isPackaged: false,
  appVersion: 'test',
  isDebugMode: false,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  imageProcessor: {
    async getMetadata() { return null },
    async process() { throw new Error('Unexpected image processing in idle-runtime test') },
  },
})

const FIXTURE = join(import.meta.dir, '__fixtures__', 'pid-mcp-server.ts')
const SOURCE_SLUG = 'pidfix'
const WHOAMI = `mcp__${SOURCE_SLUG}__whoami`
const TWENTY_ONE_MIN = 21 * 60_000

interface StubAgent {
  pool: McpClientPool
  disposed: boolean
  [key: string]: unknown
}

let prevLocalMcp: string | undefined
let prevMaxLive: string | undefined
beforeAll(() => {
  prevLocalMcp = process.env.CRAFT_LOCAL_MCP_ENABLED
  prevMaxLive = process.env.CRAFT_MAX_LIVE_RUNTIMES
  process.env.CRAFT_LOCAL_MCP_ENABLED = 'true'
})
afterAll(() => {
  if (prevLocalMcp === undefined) delete process.env.CRAFT_LOCAL_MCP_ENABLED
  else process.env.CRAFT_LOCAL_MCP_ENABLED = prevLocalMcp
  if (prevMaxLive === undefined) delete process.env.CRAFT_MAX_LIVE_RUNTIMES
  else process.env.CRAFT_MAX_LIVE_RUNTIMES = prevMaxLive
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await sleep(50)
  }
  return !isAlive(pid)
}

async function whoami(pool: McpClientPool | undefined): Promise<number> {
  if (!pool) throw new Error('no MCP pool on session')
  const result = await pool.callTool(WHOAMI, {})
  if (result.isError) throw new Error(`whoami failed: ${result.content}`)
  return Number(result.content)
}

describe('idle runtime eviction', () => {
  let tmpRoot: string
  let sm: SessionManager
  let created: StubAgent[]
  let disposeDelayMs: number
  const spies: Array<{ mockRestore(): void }> = []
  const managers: SessionManager[] = []

  function newManager(): SessionManager {
    const manager = new SessionManager()
    spies.push(spyOn(manager as any, 'sendEvent').mockImplementation(() => {}))
    spies.push(spyOn(manager as any, 'persistSession').mockImplementation(() => {}))
    spies.push(spyOn(manager as any, 'flushSession').mockResolvedValue(undefined))
    managers.push(manager)
    return manager
  }

  function addSession(manager: SessionManager, id: string, withSource = true) {
    const workspace = { id: 'ws_test', name: 'Test', rootPath: tmpRoot, createdAt: 0 }
    const managed = createManagedSession(
      { id, name: id },
      workspace as never,
      { messagesLoaded: true },
    ) as any
    if (withSource) managed.enabledSourceSlugs = [SOURCE_SLUG]
    ;(manager as any).sessions.set(id, managed)
    return managed
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-idle-runtime-'))
    const dir = join(tmpRoot, 'sources', SOURCE_SLUG)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      id: SOURCE_SLUG,
      slug: SOURCE_SLUG,
      name: 'PID fixture',
      type: 'mcp',
      provider: 'custom',
      enabled: true,
      mcp: { transport: 'stdio', command: process.execPath, args: [FIXTURE], authType: 'none' },
    }))
    writeFileSync(join(dir, 'guide.md'), '# pid fixture\n')

    created = []
    disposeDelayMs = 0
    // Stub backend: like BaseAgent, it syncs the session's McpClientPool on
    // setSourceServers. It deliberately does NOT close the pool on dispose (as
    // PiAgent does), so these tests prove SessionManager releases the MCP
    // children itself.
    spies.push(spyOn(backend, 'createBackendFromResolvedContext').mockImplementation(((args: any) => {
      const pool = args.coreConfig.mcpPool as McpClientPool
      const agent: StubAgent = {
        pool,
        disposed: false,
        postInit: async () => ({}),
        getSummarizeCallback: () => async () => null,
        setAllSources: () => {},
        setSourceServers: async (mcp: any, api: any) => { await pool.sync(mcp, api) },
        applyBridgeUpdates: async () => {},
        getModel: () => 'stub-model',
        isProcessing: () => false,
        chat: async function* () { yield { type: 'complete' } },
        dispose: () => { agent.disposed = true },
        disposeForRestart: async () => {
          if (disposeDelayMs > 0) await sleep(disposeDelayMs)
          agent.disposed = true
        },
      }
      created.push(agent)
      return agent
    }) as any))

    sm = newManager()
  })

  afterEach(async () => {
    for (const manager of managers.splice(0)) {
      for (const managed of (manager as any).sessions.values()) {
        await managed.mcpPool?.disconnectAll().catch(() => {})
      }
      manager.cleanup()
    }
    for (const spy of spies.splice(0)) spy.mockRestore()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('disposes an idle runtime, reaps its stdio MCP child, and rebuilds it with tools on the next message', async () => {
    const managed = addSession(sm, 's-idle')

    await sm.sendMessage('s-idle', 'first')
    expect(created).toHaveLength(1)
    expect(managed.mcpPool.isConnected(SOURCE_SLUG)).toBe(true)
    const firstPid = await whoami(managed.mcpPool)
    expect(isAlive(firstPid)).toBe(true)

    // Not idle long enough: kept.
    expect(await sm.sweepIdleRuntimes()).toEqual([])
    expect(managed.agent).toBe(created[0])

    managed.lastRuntimeActivityAt = Date.now() - TWENTY_ONE_MIN
    expect(await sm.sweepIdleRuntimes()).toEqual(['s-idle'])
    expect(created[0]!.disposed).toBe(true)
    expect(managed.agent).toBeNull()
    expect(managed.mcpPool).toBeUndefined()
    expect(await waitForExit(firstPid)).toBe(true)

    // Lazy rebuild on the next message — fresh subprocess, MCP tools back.
    await sm.sendMessage('s-idle', 'second')
    expect(created).toHaveLength(2)
    expect(managed.agent).toBe(created[1])
    expect(managed.mcpPool.getProxyToolDefs().map((d: { name: string }) => d.name)).toContain(WHOAMI)
    const secondPid = await whoami(managed.mcpPool)
    expect(secondPid).not.toBe(firstPid)
    expect(isAlive(secondPid)).toBe(true)
  })

  it('a message that lands mid-dispose waits for the dispose and then rebuilds', async () => {
    const managed = addSession(sm, 's-race')
    await sm.sendMessage('s-race', 'first')
    disposeDelayMs = 300
    managed.lastRuntimeActivityAt = Date.now() - TWENTY_ONE_MIN

    const sweep = sm.sweepIdleRuntimes()
    await sleep(20) // dispose is now in flight and holds the refresh lock
    await sm.sendMessage('s-race', 'during dispose')
    expect(await sweep).toEqual(['s-race'])

    expect(created).toHaveLength(2)
    expect(created[0]!.disposed).toBe(true)
    expect(managed.agent).toBe(created[1])
    expect(managed.mcpPool.isConnected(SOURCE_SLUG)).toBe(true)
  })

  it('keeps runtimes with a running turn, background work, holds or prompts', async () => {
    const busy = {
      turn: (m: any) => { m.isProcessing = true },
      queue: (m: any) => { m.messageQueue.push({ message: 'later' }) },
      task: (m: any) => { m.backgroundTaskRegistry.set('t1', { taskId: 't1', startTime: 0, status: 'running' }) },
      shell: (m: any) => { (sm as any).noteRuntimeActivity(m, { type: 'shell_backgrounded', shellId: 'sh1', toolUseId: 'u1' }) },
      wakeup: (m: any) => { (sm as any).noteRuntimeActivity(m, { type: 'tool_start', toolName: 'ScheduleWakeup', toolUseId: 'u2', input: { delaySeconds: 1800, reason: 'r', prompt: 'p' } }) },
      monitor: (m: any) => { (sm as any).noteRuntimeActivity(m, { type: 'tool_start', toolName: 'Monitor', toolUseId: 'u3', input: { description: 'd', timeout_ms: 1_800_000, command: 'tail -f x' } }) },
      permission: (m: any) => { (sm as any).pendingPermissionRequests.set('req1', { sessionId: m.id }) },
    } as const
    for (const [name, makeBusy] of Object.entries(busy)) {
      const m = addSession(sm, `busy-${name}`, false)
      m.agent = { isProcessing: () => false, dispose: mock(() => {}) }
      m.mcpPool = { disconnectAll: mock(async () => {}) }
      makeBusy(m)
      m.lastRuntimeActivityAt = Date.now() - TWENTY_ONE_MIN * 10
    }
    const quiet = addSession(sm, 'quiet', false)
    quiet.agent = { isProcessing: () => false, dispose: mock(() => {}) }
    quiet.mcpPool = { disconnectAll: mock(async () => {}) }
    quiet.lastRuntimeActivityAt = Date.now() - TWENTY_ONE_MIN

    expect(await sm.sweepIdleRuntimes()).toEqual(['quiet'])
    for (const name of Object.keys(busy)) {
      expect((sm as any).sessions.get(`busy-${name}`).agent).not.toBeNull()
    }
  })

  it('releases a background shell once its completion notification arrives', async () => {
    const m = addSession(sm, 'shell', false)
    m.agent = { isProcessing: () => false, dispose: () => {} }
    ;(sm as any).noteRuntimeActivity(m, { type: 'shell_backgrounded', shellId: 'bash_1', toolUseId: 'u1' })
    m.lastRuntimeActivityAt = Date.now() - TWENTY_ONE_MIN
    expect(await sm.sweepIdleRuntimes()).toEqual([])

    ;(sm as any).noteRuntimeActivity(m, { type: 'task_completed', taskId: 'bash_1', status: 'completed' })
    expect(m.liveBackgroundShells.size).toBe(0)
    // The completion itself is activity; the idle clock restarts from it.
    expect(await sm.sweepIdleRuntimes()).toEqual([])
    m.lastRuntimeActivityAt = Date.now() - TWENTY_ONE_MIN
    expect(await sm.sweepIdleRuntimes()).toEqual(['shell'])
  })

  it('orphans still-running background tasks when their runtime is disposed', async () => {
    const m = addSession(sm, 'orphan', false)
    m.agent = { isProcessing: () => false, dispose: () => {} }
    m.backgroundTaskRegistry.set('t1', { taskId: 't1', startTime: 0, status: 'running' })
    await (sm as any).disposeManagedAgentRuntime(m, 'test')
    expect(m.backgroundTaskRegistry.get('t1').status).toBe('orphaned')
  })

  it('archive releases an idle runtime and its MCP child; the session resumes after unarchive', async () => {
    const managed = addSession(sm, 's-archive')
    await sm.sendMessage('s-archive', 'first')
    const pid = await whoami(managed.mcpPool)

    await sm.archiveSession('s-archive')
    expect(managed.isArchived).toBe(true)
    expect(managed.agent).toBeNull()
    expect(managed.mcpPool).toBeUndefined()
    expect(await waitForExit(pid)).toBe(true)

    await sm.unarchiveSession('s-archive')
    await sm.sendMessage('s-archive', 'back again')
    expect(created).toHaveLength(2)
    expect(await whoami(managed.mcpPool)).not.toBe(pid)
  })

  it('archive keeps a busy runtime for the idle sweep to reap later', async () => {
    const m = addSession(sm, 's-archive-busy', false)
    m.agent = { isProcessing: () => false, dispose: mock(() => {}) }
    m.backgroundTaskRegistry.set('t1', { taskId: 't1', startTime: 0, status: 'running' })
    await sm.archiveSession('s-archive-busy')
    expect(m.isArchived).toBe(true)
    expect(m.agent).not.toBeNull()
  })

  it('delete closes the MCP pool even when the agent leaves it open', async () => {
    const managed = addSession(sm, 's-delete')
    await sm.sendMessage('s-delete', 'first')
    const pid = await whoami(managed.mcpPool)

    await sm.deleteSession('s-delete')
    expect(created[0]!.disposed).toBe(true)
    expect(await waitForExit(pid)).toBe(true)
  })

  it('CRAFT_MAX_LIVE_RUNTIMES evicts the least recently active idle runtimes', async () => {
    process.env.CRAFT_MAX_LIVE_RUNTIMES = '2'
    const capped = newManager()
    delete process.env.CRAFT_MAX_LIVE_RUNTIMES
    const now = Date.now()
    const ages: Record<string, number> = { a: 4_000, b: 3_000, c: 2_000, d: 1_000 }
    for (const [id, age] of Object.entries(ages)) {
      const m = addSession(capped, id, false)
      m.agent = { isProcessing: () => false, dispose: () => {} }
      m.lastRuntimeActivityAt = now - age
    }
    expect((await capped.sweepIdleRuntimes()).sort()).toEqual(['a', 'b'])
    expect((capped as any).sessions.get('c').agent).not.toBeNull()
    expect((capped as any).sessions.get('d').agent).not.toBeNull()
  })
})

// Shared stdio MCP children vs. idle runtime eviction (electinfo/craft-agents#97).
// Runs the real SessionManager and its real periodic sweeper with CRAFT_SHARED_MCP=1:
// two sessions on one stdio source share ONE child process; it survives the
// eviction of one session and is reaped (after the linger grace) when the last
// session's runtime is evicted. Isolated because it sets process-wide env.
import { expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as backend from '@craft-agent/shared/agent/backend'
import { sharedStdioMcp } from '@craft-agent/shared/mcp'
import { SessionManager, createManagedSession, setSessionPlatform } from './SessionManager.ts'

process.env.CRAFT_SESSION_IDLE_DISPOSE_MS = '2000'
process.env.CRAFT_LOCAL_MCP_ENABLED = 'true'
process.env.CRAFT_SHARED_MCP = '1'
process.env.CRAFT_SHARED_MCP_LINGER_MS = '1000'

const FIXTURE = join(import.meta.dir, '__fixtures__', 'pid-mcp-server.ts')

setSessionPlatform({
  appRootPath: '/tmp/shared-mcp-evict', resourcesPath: '/tmp/shared-mcp-evict/resources',
  isPackaged: false, appVersion: 'test', isDebugMode: false,
  logger: { info: (...a: unknown[]) => console.log('[sm]', ...a), warn: (...a: unknown[]) => console.log('[sm:warn]', ...a), error() {}, debug() {} },
  imageProcessor: { async getMetadata() { return null }, async process() { throw new Error('no images') } },
} as any)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** PIDs of live fixture servers, counted from /proc independently of the registry. */
function fixturePids(): number[] {
  const pids: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8')
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      if (cmd.includes(FIXTURE) && !/\) Z /.test(stat)) pids.push(Number(name))
    } catch { /* process exited */ }
  }
  return pids
}

async function waitUntil(cond: () => boolean, ms: number): Promise<number> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms}ms`)
    await sleep(100)
  }
  return Date.now() - t0
}

it('two sessions share one stdio child; it survives one eviction and is reaped after the last', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-mcp-evict-'))
  const dir = join(root, 'sources', 'pidfix')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    id: 'pidfix', slug: 'pidfix', name: 'pid', type: 'mcp', provider: 'custom', enabled: true,
    mcp: { transport: 'stdio', command: process.execPath, args: [FIXTURE], authType: 'none' },
  }))
  writeFileSync(join(dir, 'guide.md'), '# pid\n')

  spyOn(backend, 'createBackendFromResolvedContext').mockImplementation(((args: any) => {
    const pool = args.coreConfig.mcpPool
    return {
      postInit: async () => ({}), getSummarizeCallback: () => async () => null, setAllSources: () => {},
      setSourceServers: async (mcp: any, api: any) => { await pool.sync(mcp, api) },
      applyBridgeUpdates: async () => {}, getModel: () => 'stub', isProcessing: () => false,
      chat: async function* () { yield { type: 'complete' } },
      dispose: () => {}, disposeForRestart: async () => {},
    }
  }) as any)

  const sm = new SessionManager()
  spyOn(sm as any, 'sendEvent').mockImplementation(() => {})
  spyOn(sm as any, 'persistSession').mockImplementation(() => {})
  spyOn(sm as any, 'flushSession').mockResolvedValue(undefined)
  const workspace = { id: 'ws', name: 'ws', rootPath: root, createdAt: 0 } as never
  const s1 = createManagedSession({ id: 's1', name: 's1' }, workspace, { messagesLoaded: true }) as any
  const s2 = createManagedSession({ id: 's2', name: 's2' }, workspace, { messagesLoaded: true }) as any
  for (const m of [s1, s2]) {
    m.enabledSourceSlugs = ['pidfix']
    ;(sm as any).sessions.set(m.id, m)
  }

  await sm.sendMessage('s1', 'hello')
  await sm.sendMessage('s2', 'hello')
  const pid1 = Number((await s1.mcpPool.callTool('mcp__pidfix__whoami', {})).content)
  const pid2 = Number((await s2.mcpPool.callTool('mcp__pidfix__whoami', {})).content)
  console.log(`s1 pid=${pid1} s2 pid=${pid2} fixture processes=${JSON.stringify(fixturePids())} registry=${JSON.stringify(sharedStdioMcp.stats())}`)
  expect(pid1).toBe(pid2)
  expect(fixturePids()).toEqual([pid1])

  // Keep s2 recently active so the sweeper evicts only s1.
  s2.lastRuntimeActivityAt = Date.now() + 10 * 60_000
  ;(sm as any).startRuntimeSweeper()
  const t1 = await waitUntil(() => s1.agent === null && s1.mcpPool === undefined, 20_000)
  await sleep(1500) // past the linger grace: a wrongly released child would be gone by now
  const pidAfter = Number((await s2.mcpPool.callTool('mcp__pidfix__whoami', {})).content)
  console.log(`s1 evicted after ${t1}ms; s2 still live=${!!s2.agent}; child pid=${pidAfter} alive=${alive(pid1)} fixture processes=${JSON.stringify(fixturePids())}`)
  expect(s2.agent).not.toBeNull()
  expect(alive(pid1)).toBe(true)
  expect(pidAfter).toBe(pid1)
  expect(fixturePids()).toEqual([pid1])

  // Let s2 go idle: the last lease goes with its runtime and the child is reaped.
  s2.lastRuntimeActivityAt = 0
  const t2 = await waitUntil(() => s2.agent === null && !alive(pid1), 20_000)
  console.log(`s2 evicted and child reaped after ${t2}ms; fixture processes=${JSON.stringify(fixturePids())} registry=${JSON.stringify(sharedStdioMcp.stats())}`)
  expect(fixturePids()).toEqual([])
  expect(sharedStdioMcp.stats()).toEqual([])
  sm.cleanup()
}, 60_000)

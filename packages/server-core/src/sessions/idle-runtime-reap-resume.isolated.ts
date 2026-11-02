import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as backend from '@craft-agent/shared/agent/backend'
import { McpClientPool } from '@craft-agent/shared/mcp'
import { SessionManager, createManagedSession, setSessionPlatform } from './SessionManager.ts'

// Run in isolation: setSessionPlatform is process-global and has no reset API.
setSessionPlatform({
  appRootPath: '/tmp/idle-reap-test',
  resourcesPath: '/tmp/idle-reap-test/resources',
  isPackaged: false,
  appVersion: 'test',
  isDebugMode: false,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  imageProcessor: {
    async getMetadata() { return null },
    async process() { throw new Error('Unexpected image processing in idle-reap test') },
  },
})

// After an idle reap, the next turn's lazy getOrCreateAgent must rebuild the
// runtime through the real create path: a NEW MCP pool, and a backend created
// with the SAME sdkSessionId so the CLI resumes the conversation. The backend
// factory is stubbed (no subprocess); everything up to it is the real code.

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

/** Agent stub: every method is a no-op, `isProcessing` is false. */
function stubAgent(onDispose: () => void) {
  const target: Record<string, unknown> = {
    isProcessing: () => false,
    dispose: onDispose,
    postInit: async () => ({}),
  }
  return new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop]
      // Like ClaudeAgent: no disposeForRestart, so teardown goes through dispose().
      if (prop === 'then' || prop === 'disposeForRestart') return undefined
      return () => undefined
    },
    set(t, prop: string, value) { t[prop] = value; return true },
  })
}

describe('idle reap → next turn resumes the same SDK session', () => {
  it('rebuilds a fresh MCP pool and recreates the backend with the preserved sdkSessionId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sm-idle-resume-'))
    try {
      const created: Array<{ sdkSessionId?: string; mcpPool?: unknown }> = []
      let disposed = 0
      spies.push(spyOn(backend, 'createBackendFromResolvedContext').mockImplementation(((args: any) => {
        created.push({ sdkSessionId: args.coreConfig.session.sdkSessionId, mcpPool: args.coreConfig.mcpPool })
        return stubAgent(() => { disposed++ })
      }) as never))

      const sm = new SessionManager()
      const workspace = { id: 'ws_test', name: 'Test', rootPath: root, createdAt: Date.now() }
      const managed = createManagedSession({ id: 'resume-me', name: 'resume-me' }, workspace as never, { messagesLoaded: true }) as any
      ;(sm as any).sessions.set(managed.id, managed)

      // Turn 1: build the runtime, then the CLI reports its SDK session id.
      await (sm as any).getOrCreateAgent(managed)
      expect(created).toHaveLength(1)
      expect(created[0].sdkSessionId).toBeUndefined()
      const firstPool = managed.mcpPool
      expect(firstPool).toBeInstanceOf(McpClientPool)
      managed.sdkSessionId = 'sdk-conversation-1'

      // Idle for over an hour → reaped.
      managed.lastRuntimeActivityAt = Date.now() - 61 * 60_000
      const swept = await sm.sweepIdleRuntimes(Date.now())
      expect(swept.reaped).toEqual(['resume-me'])
      expect(disposed).toBe(1)
      expect(managed.agent).toBeNull()
      expect(managed.mcpPool).toBeUndefined()

      // Next message: the send path's getOrCreateAgent rebuilds and resumes.
      await (sm as any).getOrCreateAgent(managed)
      expect(created).toHaveLength(2)
      expect(created[1].sdkSessionId).toBe('sdk-conversation-1')
      expect(managed.agent).not.toBeNull()
      expect(managed.mcpPool).toBeInstanceOf(McpClientPool)
      expect(managed.mcpPool).not.toBe(firstPool)
      expect(created[1].mcpPool).toBe(managed.mcpPool)
      // A fresh runtime is fresh activity and starts with no armed schedules.
      expect(managed.lastRuntimeActivityAt).toBeGreaterThan(Date.now() - 60_000)
      expect(managed.armedSchedules?.countArmed(Date.now())).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

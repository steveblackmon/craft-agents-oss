import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sessionPersistenceQueue } from '@craft-agent/shared/sessions/persistence-queue'
import { loadSession } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession, setSessionPlatform } from './SessionManager'

// Isolated because SessionPlatform is process-global. No backend/MCP is started.
setSessionPlatform({
  appRootPath: '/tmp/message-release-test', resourcesPath: '/tmp/message-release-test',
  isPackaged: false, appVersion: 'test', isDebugMode: false,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  imageProcessor: { async getMetadata() { return null }, async process() { throw new Error('unused') } },
})

const IDLE = 21 * 60_000
let sm: SessionManager
let root: string
let m: any
const spies: Array<{ mockRestore(): void }> = []
function age() {
  m.lastMessageAt = Date.now() - IDLE
  m.lastRuntimeActivityAt = Date.now() - IDLE
  m.lastMessageAccessAt = Date.now() - IDLE
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'idle-messages-'))
  sm = new SessionManager()
  spies.push(spyOn(sm as any, 'sendEvent').mockImplementation(() => {}))
  m = createManagedSession({ id: 'history', name: 'History' },
    { id: 'ws', name: 'Test', rootPath: root, createdAt: 0 } as any,
    { messagesLoaded: true })
  m.messages = [
    { id: 'u1', role: 'user', content: 'question', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'answer', timestamp: 2 },
  ]
  ;(sm as any).sessions.set(m.id, m)
  ;(sm as any).persistSession(m)
  age()
})
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  await sm.flushSession(m.id)
  sessionPersistenceQueue.cancel(m.id)
  sm.cleanup()
  rmSync(root, { recursive: true, force: true })
})

describe('idle message release', () => {
  it('flushes pending writes, releases GUI-only history, and reloads identical messages', async () => {
    const original = structuredClone(m.messages)
    expect(sessionPersistenceQueue.hasUnflushed(m.id)).toBe(true)
    expect(await sm.sweepIdleRuntimes()).toEqual([]) // no runtime needed
    expect(m.messagesLoaded).toBe(false)
    expect(m.messages).toEqual([])
    expect(sessionPersistenceQueue.hasUnflushed(m.id)).toBe(false)
    expect((await sm.getSession(m.id))?.messages).toEqual(original)
    expect(m.messagesLoaded).toBe(true)
    await sm.sweepIdleRuntimes()
    expect(m.messagesLoaded).toBe(true) // a recent read starts a new idle period
  })

  for (const busy of ['turn', 'queue', 'refresh', 'permission', 'auth', 'retry', 'background', 'shell', 'hold', 'stream', 'loading', 'async', 'viewing']) {
    it(`does not release while ${busy} is active`, async () => {
      switch (busy) {
        case 'turn': m.isProcessing = true; break
        case 'queue': m.messageQueue.push({ message: 'queued' }); break
        case 'refresh': (sm as any).agentRefreshLocks.set(m.id, Promise.resolve()); break
        case 'permission': (sm as any).pendingPermissionRequests.set('p', { sessionId: m.id }); break
        case 'auth': m.pendingAuthRequestId = 'auth'; break
        case 'retry': m.autoRetryTimer = setTimeout(() => {}, 10000); break
        case 'background': m.backgroundTaskRegistry.set('task', { status: 'running' }); break
        case 'shell': m.liveBackgroundShells = new Set(['shell']); break
        case 'hold': m.runtimeHolds = new Map([['wakeup', Date.now() + 10000]]); break
        case 'stream': m.agent = { isProcessing: () => true }; break
        case 'loading': (sm as any).messageLoadingPromises.set(m.id, Promise.resolve()); break
        case 'async': m.isAsyncOperationOngoing = true; break
        case 'viewing': sm.setActiveViewingSession(m.id, 'ws'); break
      }
      await sm.sweepIdleRuntimes()
      expect(m.messagesLoaded).toBe(true)
      expect(m.messages).toHaveLength(2)
      if (m.autoRetryTimer) clearTimeout(m.autoRetryTimer)
      m.agent = null
    })
  }

  it('retains memory until an in-flight flush finishes', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    spies.push(spyOn(sm, 'flushSession').mockImplementation(async id => {
      await gate
      await sessionPersistenceQueue.flush(id)
    }))
    const pass = sm.sweepIdleRuntimes()
    await Promise.resolve()
    expect(m.messagesLoaded).toBe(true)
    expect(m.messages).toHaveLength(2)
    finish()
    await pass
    expect(m.messagesLoaded).toBe(false)
  })

  it('a getMessages access during flush cancels release, including same-tick accesses', async () => {
    spies.push(spyOn(sm, 'flushSession').mockImplementation(async id => {
      await sm.getSession(id)
      await sessionPersistenceQueue.flush(id)
    }))
    await sm.sweepIdleRuntimes(Date.now() + IDLE)
    expect(m.messagesLoaded).toBe(true)
  })

  it('rechecks busy state after awaiting persistence', async () => {
    spies.push(spyOn(sm, 'flushSession').mockImplementation(async id => {
      await sessionPersistenceQueue.flush(id)
      m.isProcessing = true
    }))
    await sm.sweepIdleRuntimes()
    expect(m.messagesLoaded).toBe(true)
  })

  it('never releases failed writes; retries the retained snapshot on a later sweep', async () => {
    const badTmp = join(root, 'sessions', m.id, 'session.jsonl.tmp')
    mkdirSync(badTmp, { recursive: true })
    spies.push(spyOn(console, 'error').mockImplementation(() => {}))
    await sm.sweepIdleRuntimes()
    expect(sessionPersistenceQueue.hasUnflushed(m.id)).toBe(true)
    expect(m.messagesLoaded).toBe(true)
    expect(m.messages).toHaveLength(2)
    rmSync(badTmp, { recursive: true })
    await sm.sweepIdleRuntimes()
    expect(m.messagesLoaded).toBe(false)
    expect((await sm.getSession(m.id))?.messages).toHaveLength(2)
  })

  it('does not release when a flush leaves pending writes', async () => {
    spies.push(spyOn(sm, 'flushSession').mockResolvedValue(undefined))
    await sm.sweepIdleRuntimes()
    expect(m.messagesLoaded).toBe(true)
  })

  it('hydrates before synchronous edits and persists the full history', async () => {
    await sm.sweepIdleRuntimes()
    sm.updateMessageContent(m.id, 'a1', 'edited')
    await sm.flushSession(m.id)
    age()
    await sm.sweepIdleRuntimes()
    const messages = (await sm.getSession(m.id))!.messages
    expect(messages.map(x => x.content)).toEqual(['question', 'edited'])
  })

  it('cold metadata persistence cannot replace a released history with an empty array', async () => {
    await sm.sweepIdleRuntimes()
    m.name = 'New name'
    ;(sm as any).persistSession(m)
    await sm.flushSession(m.id)
    expect(loadSession(root, m.id)?.messages).toHaveLength(2)
    expect(loadSession(root, m.id)?.name).toBe('New name')
  })

  it('/compact reloads history before acknowledging the command', async () => {
    await sm.sweepIdleRuntimes()
    const stop = new Error('stop before backend startup')
    await expect(sm.sendMessage(m.id, '/compact', undefined, undefined, undefined, undefined, undefined, () => {
      expect(m.messagesLoaded).toBe(true)
      expect(m.messages.slice(0, 2).map((x: any) => x.content)).toEqual(['question', 'answer'])
      throw stop
    })).rejects.toThrow(stop.message)
    expect(loadSession(root, m.id)?.messages.map(x => x.content)).toEqual(['question', 'answer', '/compact'])
  })

  it('export after release serializes the full history', async () => {
    await sm.sweepIdleRuntimes()
    const bundle = await sm.exportSession(m.id, 'ws')
    expect(bundle?.session.messages.map(x => x.content)).toEqual(['question', 'answer'])
  })

  it('late compaction events hydrate before appending', async () => {
    await sm.sweepIdleRuntimes()
    await (sm as any).processEvent(m, { type: 'info', message: 'Compacted conversation', statusType: 'compaction_complete', compactionTrigger: 'manual' })
    expect(m.messages.map((x: any) => x.content)).toEqual(['question', 'answer', 'Compacted conversation'])
  })

  it('share flushes pending history and updateShare reads it after release', async () => {
    let uploaded: any
    spies.push(spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init: RequestInit | undefined) => {
      uploaded = JSON.parse(init!.body as string)
      return Response.json({ id: 'shared', url: 'https://example.invalid/shared' })
    }) as typeof fetch))
    expect((await sm.shareToViewer(m.id)).success).toBe(true)
    expect(uploaded.messages.map((x: any) => x.content)).toEqual(['question', 'answer'])
    age()
    await sm.sweepIdleRuntimes()
    expect(m.messagesLoaded).toBe(false)
    expect((await sm.updateShare(m.id)).success).toBe(true)
    expect(uploaded.messages.map((x: any) => x.content)).toEqual(['question', 'answer'])
  })

  it('snapshots an unqueued late message before release', async () => {
    await sm.flushSession(m.id)
    m.messages.push({ id: 'late', role: 'info', content: 'late result', timestamp: 3 })
    expect(sessionPersistenceQueue.hasUnflushed(m.id)).toBe(false)
    await sm.sweepIdleRuntimes()
    expect(m.messagesLoaded).toBe(false)
    expect((await sm.getSession(m.id))?.messages.map(x => x.content)).toEqual(['question', 'answer', 'late result'])
  })

  it('retains history if snapshot conversion fails', async () => {
    spies.push(spyOn(sm as any, 'enqueuePersist').mockReturnValue(false))
    await sm.sweepIdleRuntimes()
    expect(m.messagesLoaded).toBe(true)
  })

  it('the existing disable switch disables history eviction too', async () => {
    ;(sm as any).idleDisposeMs = 0
    await sm.sweepIdleRuntimes()
    expect(m.messagesLoaded).toBe(true)
  })

  it('fails closed on missing disk history without converting a cold session into an empty loaded session', async () => {
    await sm.sweepIdleRuntimes()
    const path = join(root, 'sessions', m.id, 'session.jsonl')
    const saved = readFileSync(path)
    rmSync(path)
    await expect(sm.getSession(m.id)).rejects.toThrow('history unavailable')
    expect(m.messagesLoaded).toBe(false)
    expect(() => sm.updateMessageContent(m.id, 'a1', 'edited')).toThrow('history unavailable')
    await expect(sm.renameSession(m.id, 'renamed')).rejects.toThrow('history unavailable')
    expect(m.messagesLoaded).toBe(false)
    expect(sessionPersistenceQueue.hasUnflushed(m.id)).toBe(false)
    writeFileSync(path, saved)
    expect((await sm.getSession(m.id))?.messages).toHaveLength(2)
  })

  it('cold hydration uses an in-flight metadata snapshot and cannot lose history or revert unread metadata', async () => {
    await sm.sweepIdleRuntimes()
    const unread = sm.markSessionUnread(m.id)
    expect(sessionPersistenceQueue.hasUnflushed(m.id)).toBe(true)
    await sm.renameSession(m.id, 'Renamed during metadata write')
    await unread
    await sm.flushSession(m.id)
    const stored = loadSession(root, m.id)!
    expect(stored.messages.map(x => x.content)).toEqual(['question', 'answer'])
    expect(stored.hasUnread).toBe(true)
    expect(stored.name).toBe('Renamed during metadata write')
  })

  it('metadata RMW during release cannot replace the fresh snapshot with older disk messages', async () => {
    await sm.flushSession(m.id)
    m.messages.push({ id: 'late', role: 'info', content: 'late result', timestamp: 3 })
    m.hasUnread = true
    spies.push(spyOn(sm, 'flushSession').mockImplementation(async id => {
      const write = sessionPersistenceQueue.flush(id)
      const metadata = sm.markAllSessionsRead('ws')
      await Promise.all([write, metadata])
    }))
    await sm.sweepIdleRuntimes()
    expect(m.messagesLoaded).toBe(false)
    const stored = loadSession(root, m.id)!
    expect(stored.messages.map(x => x.content)).toEqual(['question', 'answer', 'late result'])
    expect(stored.hasUnread).toBe(false)
  })

  it('retains messages when runtime disposal fails', async () => {
    m.agent = { isProcessing: () => false }
    spies.push(spyOn(sm as any, 'evictManagedRuntime').mockRejectedValue(new Error('dispose failed')))
    await sm.sweepIdleRuntimes()
    expect(m.messagesLoaded).toBe(true)
    m.agent = null
  })

  it('initializes an explicitly known-empty new session without a JSONL file', async () => {
    const fresh = createManagedSession({ id: 'fresh', messageCount: 0 }, m.workspace)
    ;(sm as any).sessions.set(fresh.id, fresh)
    expect((await sm.getSession(fresh.id))?.messages).toEqual([])
    expect(fresh.messagesLoaded).toBe(true)
    const syncFresh = createManagedSession({ id: 'fresh-sync', messageCount: 0 }, m.workspace)
    ;(sm as any).sessions.set(syncFresh.id, syncFresh)
    ;(sm as any).hydrateMessagesForColdPersist(syncFresh)
    expect(syncFresh.messagesLoaded).toBe(true)
  })

  it('a stale zero messageCount does not permit missing history after release', async () => {
    m.messageCount = 0 // the startup header count can predate runtime messages
    await sm.sweepIdleRuntimes()
    const path = join(root, 'sessions', m.id, 'session.jsonl')
    const saved = readFileSync(path)
    rmSync(path)
    await expect(sm.getSession(m.id)).rejects.toThrow('history unavailable')
    expect(m.messagesLoaded).toBe(false)
    writeFileSync(path, saved)
  })

  it('queue replay hydrates before finding and clearing queued message flags', async () => {
    m.messages[0].isQueued = true
    ;(sm as any).persistSession(m)
    await sm.flushSession(m.id)
    // Simulate a cold session with an already recovered queue.
    m.messages = []
    m.messagesLoaded = false
    m.messageQueue.push({ message: 'question', messageId: 'u1' })
    m.isProcessing = true // prevents hydrate scheduling another recovery callback
    spies.push(spyOn(sm, 'sendMessage').mockResolvedValue(undefined))
    ;(sm as any).processNextQueuedMessage(m.id)
    expect(m.messages.find((x: any) => x.id === 'u1').isQueued).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import {
  evaluateIdleMessageRelease,
  resolveIdleMessageReleaseEnabled,
  MESSAGE_RELEASE_PERSIST_QUIET_MS,
  type IdleMessageReleaseCandidate,
} from './idle-runtime-reaper'

// Idle transcript release (craft-agents#248): a session's lazy-loaded messages
// must go back to disk-only once the session is idle with no runtime, without
// losing anything, and every later read must transparently reload them.

const MIN = 60_000
const THRESHOLD = 60 * MIN

describe('evaluateIdleMessageRelease', () => {
  const NOW = 1_800_000_000_000
  const base = (): IdleMessageReleaseCandidate => ({
    messagesLoaded: true,
    hasRuntime: false,
    isProcessing: false,
    transitionInFlight: false,
    queuedMessages: 0,
    pendingPermissions: 0,
    pendingAuth: false,
    pendingPlan: false,
    loadInFlight: false,
    persistPending: false,
    queuedInTranscript: 0,
    diskInSync: true,
    lastActivityAt: NOW - 61 * MIN,
  })

  it('releases an idle, persisted session with no runtime', () => {
    expect(evaluateIdleMessageRelease(base(), NOW, THRESHOLD)).toEqual({ release: true, idleMs: 61 * MIN })
  })

  const blockers: Array<[string, Partial<IdleMessageReleaseCandidate>]> = [
    ['not-loaded', { messagesLoaded: false }],
    ['has-runtime', { hasRuntime: true }],
    ['processing', { isProcessing: true }],
    ['transition-in-flight', { transitionInFlight: true }],
    ['queued-messages', { queuedMessages: 1 }],
    ['pending-permission', { pendingPermissions: 1 }],
    ['pending-auth', { pendingAuth: true }],
    ['pending-plan', { pendingPlan: true }],
    ['load-in-flight', { loadInFlight: true }],
    ['persist-pending', { persistPending: true }],
    ['queued-in-transcript', { queuedInTranscript: 1 }],
    ['disk-out-of-sync', { diskInSync: false }],
  ]
  for (const [reason, patch] of blockers) {
    it(`keeps the transcript when ${reason}`, () => {
      const d = evaluateIdleMessageRelease({ ...base(), ...patch }, NOW, THRESHOLD)
      expect(d.release).toBe(false)
      expect(d).toMatchObject({ reason })
    })
  }

  it('counts a recent client read, or a recent persist, as activity', () => {
    expect(evaluateIdleMessageRelease({ ...base(), lastAccessAt: NOW - 5 * MIN }, NOW, THRESHOLD)).toMatchObject({ release: false, reason: 'not-idle-long-enough' })
    // A persist inside the quiet window means the debounced write may still be landing.
    expect(evaluateIdleMessageRelease({ ...base(), lastActivityAt: NOW - 200 * MIN, lastPersistAt: NOW - MESSAGE_RELEASE_PERSIST_QUIET_MS + 1 }, NOW, THRESHOLD)).toMatchObject({ release: false, reason: 'persist-pending' })
  })

  it('never releases when the threshold is 0 (reaper disabled)', () => {
    expect(evaluateIdleMessageRelease(base(), NOW, 0)).toMatchObject({ release: false, reason: 'not-idle-long-enough' })
  })

  it('env: on by default, off only for 0/false/off', () => {
    expect(resolveIdleMessageReleaseEnabled({})).toBe(true)
    expect(resolveIdleMessageReleaseEnabled({ CRAFT_IDLE_MESSAGE_RELEASE: '1' })).toBe(true)
    for (const v of ['0', 'false', 'OFF', ' off ']) {
      expect(resolveIdleMessageReleaseEnabled({ CRAFT_IDLE_MESSAGE_RELEASE: v })).toBe(false)
    }
  })
})

describe('SessionManager.releaseIdleMessages', () => {
  let tmpRoot: string
  let sm: SessionManager
  const prevReap = process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES
  const prevRelease = process.env.CRAFT_IDLE_MESSAGE_RELEASE

  beforeEach(() => {
    delete process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES
    delete process.env.CRAFT_IDLE_MESSAGE_RELEASE
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-idle-release-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    if (prevReap === undefined) delete process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES
    else process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES = prevReap
    if (prevRelease === undefined) delete process.env.CRAFT_IDLE_MESSAGE_RELEASE
    else process.env.CRAFT_IDLE_MESSAGE_RELEASE = prevRelease
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  type Internals = {
    sessions: Map<string, unknown>
    persistSession(m: unknown): void
  }

  /** A loaded session whose two messages are on disk, last active 2h ago. */
  async function persistedIdleSession(id: string, manager: SessionManager = sm) {
    const workspace = { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id, name: id }, workspace as never, { messagesLoaded: true }) as unknown as Record<string, any>
    const t = Date.now() - 120 * MIN
    managed.messages.push(
      { id: `${id}-u1`, role: 'user', content: 'hello', timestamp: t },
      { id: `${id}-a1`, role: 'assistant', content: 'hi there', timestamp: t + 1000 },
    )
    managed.sdkSessionId = `sdk-${id}`
    const internals = manager as unknown as Internals
    internals.sessions.set(id, managed)
    internals.persistSession(managed)
    await sessionPersistenceQueue.flush(id)
    managed.lastRuntimeActivityAt = t
    managed.lastMessageAt = t
    managed.lastPersistEnqueuedAt = t
    return managed
  }

  const later = () => Date.now() + 5 * MIN

  it('releases an idle persisted transcript, and getSession reloads it intact', async () => {
    const managed = await persistedIdleSession('idle')

    const result = sm.releaseIdleMessages(later())

    expect(result.released).toEqual(['idle'])
    expect(result.releasedMessages).toBe(2)
    expect(managed.messagesLoaded).toBe(false)
    expect(managed.messages).toEqual([])
    // Resume state is untouched.
    expect(managed.sdkSessionId).toBe('sdk-idle')

    const session = await sm.getSession('idle')
    expect(session?.messages.map(m => [m.id, m.role, m.content])).toEqual([
      ['idle-u1', 'user', 'hello'],
      ['idle-a1', 'assistant', 'hi there'],
    ])
    expect(managed.messagesLoaded).toBe(true)
    // Just read by a client → not idle any more.
    expect(sm.releaseIdleMessages(later()).released).toEqual([])
  })

  it('keeps a transcript whose newest message never reached disk', async () => {
    const managed = await persistedIdleSession('behind')
    managed.messages.push({ id: 'behind-u2', role: 'user', content: 'unsaved', timestamp: Date.now() - 100 * MIN })

    const result = sm.releaseIdleMessages(later())

    expect(result.released).toEqual([])
    expect(result.blocked).toEqual({ 'disk-out-of-sync': 1 })
    expect(managed.messages).toHaveLength(3)
  })

  it('keeps a transcript that has no session file at all', () => {
    const workspace = { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id: 'nofile', name: 'nofile' }, workspace as never, { messagesLoaded: true }) as unknown as Record<string, any>
    managed.messages.push({ id: 'n1', role: 'user', content: 'x', timestamp: Date.now() - 120 * MIN })
    managed.lastRuntimeActivityAt = Date.now() - 120 * MIN
    ;(sm as unknown as Internals).sessions.set('nofile', managed)

    expect(sm.releaseIdleMessages(later()).blocked).toEqual({ 'disk-out-of-sync': 1 })
    expect(managed.messages).toHaveLength(1)
  })

  it('keeps a transcript while a runtime is still live (the runtime reaper goes first)', async () => {
    const managed = await persistedIdleSession('live')
    managed.agent = { isProcessing: () => false, dispose: () => {} }
    expect(sm.releaseIdleMessages(later()).released).toEqual([])
    expect(managed.messagesLoaded).toBe(true)
  })

  it('keeps a transcript with a message still flagged queued (a reload would replay it)', async () => {
    const managed = await persistedIdleSession('queued')
    managed.messages[0].isQueued = true
    expect(sm.releaseIdleMessages(later()).blocked).toEqual({ 'queued-in-transcript': 1 })
  })

  it('keeps a transcript with an unwritten persist queued', async () => {
    const managed = await persistedIdleSession('pending')
    ;(sm as unknown as Internals).persistSession(managed)
    managed.lastPersistEnqueuedAt = Date.now() - 120 * MIN  // isolate the queue check from the quiet window
    expect(sm.releaseIdleMessages(later()).blocked).toEqual({ 'persist-pending': 1 })
    await sessionPersistenceQueue.flush('pending')
    expect(sm.releaseIdleMessages(later()).released).toEqual(['pending'])
  })

  it('does nothing when CRAFT_IDLE_MESSAGE_RELEASE=0 or the reaper is disabled', async () => {
    process.env.CRAFT_IDLE_MESSAGE_RELEASE = '0'
    const off = new SessionManager()
    const a = await persistedIdleSession('off-a', off)
    expect(off.releaseIdleMessages(later()).released).toEqual([])
    expect(a.messagesLoaded).toBe(true)

    delete process.env.CRAFT_IDLE_MESSAGE_RELEASE
    process.env.CRAFT_IDLE_RUNTIME_REAP_MINUTES = '0'
    const noReap = new SessionManager()
    const b = await persistedIdleSession('off-b', noReap)
    expect(noReap.releaseIdleMessages(later()).released).toEqual([])
    expect(b.messagesLoaded).toBe(true)
  })

  it('sync message edits on a released session reload it first and persist the full transcript', async () => {
    const managed = await persistedIdleSession('edit')
    expect(sm.releaseIdleMessages(later()).released).toEqual(['edit'])

    sm.updateMessageContent('edit', 'edit-a1', 'edited')
    await sessionPersistenceQueue.flush('edit')

    expect(managed.messagesLoaded).toBe(true)
    expect(managed.messages.map((m: { content: string }) => m.content)).toEqual(['hello', 'edited'])
    // Round-trip through disk: nothing was dropped by the edit.
    managed.lastPersistEnqueuedAt = Date.now() - 120 * MIN
    expect(sm.releaseIdleMessages(later()).released).toEqual(['edit'])
    const session = await sm.getSession('edit')
    expect(session?.messages.map(m => m.content)).toEqual(['hello', 'edited'])
  })

  it('refuses a connection change on a released session that has already started', async () => {
    await persistedIdleSession('conn')
    expect(sm.releaseIdleMessages(later()).released).toEqual(['conn'])
    await expect(sm.setSessionConnection('conn', 'some-connection')).rejects.toThrow(/already|started/i)
  })
})

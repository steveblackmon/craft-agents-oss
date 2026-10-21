import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionPersistenceQueue } from '../persistence-queue'
import { loadSession } from '../storage'
import type { StoredSession } from '../types'

let root: string
let queue: SessionPersistenceQueue
function snapshot(content = 'durable'): StoredSession {
  return {
    id: 'history', workspaceRootPath: root, createdAt: 1, lastUsedAt: 1,
    messages: [{ id: 'm1', type: 'user', content, timestamp: 1 }],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  }
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'queue-durability-')); queue = new SessionPersistenceQueue(1) })
afterEach(async () => { await queue.flushAll(); queue.cancel('history'); rmSync(root, { recursive: true, force: true }) })

describe('durability gates for history eviction', () => {
  it('tracks timer-started writes and flush waits for them even without a pending entry', async () => {
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { finish = resolve })
    const write = (queue as any).write.bind(queue)
    const spy = spyOn(queue as any, 'write').mockImplementation(async (id: string) => {
      // Real write consumes the entry synchronously; its async I/O still runs.
      const result = write(id)
      started()
      await gate
      return await result
    })
    queue.enqueue(snapshot())
    await entered
    expect(queue.hasPending('history')).toBe(false)
    expect(queue.hasUnflushed('history')).toBe(true)
    let flushed = false
    const flushing = queue.flush('history').then(() => { flushed = true })
    await Promise.resolve()
    expect(flushed).toBe(false)
    finish()
    await flushing
    expect(queue.hasUnflushed('history')).toBe(false)
    expect(loadSession(root, 'history')?.messages[0]?.content).toBe('durable')
    spy.mockRestore()
  })

  it('serializes concurrent flushes and drains a newer enqueue during I/O', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const write = (queue as any).write.bind(queue)
    let active = 0
    let maxActive = 0
    const spy = spyOn(queue as any, 'write').mockImplementation(async (id: string) => {
      maxActive = Math.max(maxActive, ++active)
      const result = write(id)
      await gate
      const success = await result
      active--
      return success
    })
    queue.enqueue(snapshot('old'))
    const a = queue.flush('history')
    queue.enqueue(snapshot('new'))
    const b = queue.flush('history')
    finish()
    await Promise.all([a, b])
    expect(maxActive).toBe(1)
    expect(queue.hasUnflushed('history')).toBe(false)
    expect(loadSession(root, 'history')?.messages[0]?.content).toBe('new')
    spy.mockRestore()
  })

  it('cancel invalidates an in-progress write so shutdown cannot resurrect a deleted session', async () => {
    queue.enqueue(snapshot())
    const writing = queue.flush('history') // consumes pending, yields inside writeFile
    expect(queue.hasPending('history')).toBe(false)
    queue.cancel('history')
    rmSync(join(root, 'sessions/history'), { recursive: true, force: true })
    await writing
    expect(queue.hasUnflushed('history')).toBe(false)
    expect(queue.getLatestSnapshot('history')).toBeUndefined()
    await queue.flushAll()
    expect(existsSync(join(root, 'sessions/history'))).toBe(false)
  })

  it('cancel prevents a failed in-flight write from requeueing its snapshot', async () => {
    const badTmp = join(root, 'sessions/history/session.jsonl.tmp')
    mkdirSync(badTmp, { recursive: true })
    const spy = spyOn(console, 'error').mockImplementation(() => {})
    queue.enqueue(snapshot())
    const writing = queue.flush('history') // writeFile on a directory will fail
    queue.cancel('history')
    await writing
    expect(queue.hasUnflushed('history')).toBe(false)
    rmSync(join(root, 'sessions/history'), { recursive: true, force: true })
    await queue.flushAll()
    expect(existsSync(join(root, 'sessions/history'))).toBe(false)
    spy.mockRestore()
  })

  for (const timerDriven of [false, true]) {
    it(`drains replacement after cancellation (${timerDriven ? 'debounce already fired' : 'explicit waiting flush'})`, async () => {
      let finish!: () => void
      const gate = new Promise<void>(resolve => { finish = resolve })
      const write = (queue as any).write.bind(queue)
      let first = true
      const spy = spyOn(queue as any, 'write').mockImplementation(async (id: string) => {
        const result = write(id)
        if (first) {
          first = false
          await gate
        }
        return await result
      })
      queue.enqueue(snapshot('A'))
      const owner = queue.flush('history')
      queue.cancel('history')
      queue.enqueue(snapshot('B'))
      const waiter = timerDriven ? undefined : queue.flush('history')
      if (timerDriven) await Bun.sleep(10) // B's timer now waits behind A
      finish()
      await Promise.all([owner, waiter])
      expect(queue.hasUnflushed('history')).toBe(false)
      expect(loadSession(root, 'history')?.messages[0]?.content).toBe('B')
      spy.mockRestore()
    })
  }

  it('metadata writers can read the latest in-flight snapshot instead of stale disk history', async () => {
    queue.enqueue(snapshot('old'))
    await queue.flush('history')
    queue.enqueue(snapshot('new'))
    const writing = queue.flush('history')
    const current = queue.getLatestSnapshot('history')!
    expect(current.messages[0]?.content).toBe('new')
    current.name = 'metadata'
    queue.enqueue(current)
    await writing
    expect(loadSession(root, 'history')?.messages[0]?.content).toBe('new')
    expect(loadSession(root, 'history')?.name).toBe('metadata')
  })

  it('retains failed snapshots until a successful retry', async () => {
    const badTmp = join(root, 'sessions/history/session.jsonl.tmp')
    mkdirSync(badTmp, { recursive: true })
    const spy = spyOn(console, 'error').mockImplementation(() => {})
    queue.enqueue(snapshot())
    await queue.flush('history')
    expect(queue.hasUnflushed('history')).toBe(true)
    rmSync(badTmp, { recursive: true })
    await queue.flush('history')
    expect(queue.hasUnflushed('history')).toBe(false)
    expect(loadSession(root, 'history')?.messages).toHaveLength(1)
    spy.mockRestore()
  })
})

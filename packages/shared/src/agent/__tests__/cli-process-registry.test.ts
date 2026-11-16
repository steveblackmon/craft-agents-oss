import { describe, expect, it } from 'bun:test'
import {
  CliProcessRegistry,
  CLI_ORPHAN_MIN_AGE_MS,
  CLI_SIGKILL_GRACE_MS,
  CLI_TEARDOWN_GRACE_MS,
  readProcStartTime,
  type CliProcessRegistryDeps,
} from '../backend/claude/cli-process-registry.ts'

// craft-agents#250: every Claude CLI the SDK spawns is registered so none can outlive its agent.

const MIN = 60_000

/** A fake process table + manual clock/timers. */
function harness() {
  const procs = new Map<number, { start: string; ignoresTerm?: boolean }>()
  const signals: Array<[number, string]> = []
  let now = 1_000_000
  let timers: Array<{ at: number; fn: () => void }> = []
  const deps: CliProcessRegistryDeps = {
    readStartTime: (pid) => procs.get(pid)?.start ?? null,
    kill: (pid, sig) => {
      signals.push([pid, sig])
      const p = procs.get(pid)
      if (!p) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      if (sig === 'SIGKILL' || !p.ignoresTerm) procs.delete(pid)
    },
    now: () => now,
    setTimer: (fn, ms) => { timers.push({ at: now + ms, fn }) },
  }
  // Runs timers in time order, moving the clock to each one (timers set by a timer count from then).
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const next = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      timers = timers.filter(t => t !== next)
      now = next.at
      next.fn()
    }
    now = target
  }
  return { procs, signals, deps, advance, registry: new CliProcessRegistry(deps) }
}

const reg = (ownerId: string, kind: 'persistent' | 'oneshot' = 'persistent', generation = 1) => ({ ownerId, sessionId: 's', kind, generation })

describe('CliProcessRegistry', () => {
  it('tracks nothing when the process identity cannot be read (e.g. no /proc)', () => {
    const h = harness()
    expect(h.registry.register(42, reg('a'))).toBe(false)
    expect(h.registry.list()).toEqual([])
  })

  it('terminate: waits the grace, then SIGTERM; nothing more once it exited', () => {
    const h = harness()
    h.procs.set(10, { start: '100' })
    h.registry.register(10, reg('a'))
    h.registry.terminate(h.registry.list()[0]!)
    h.advance(CLI_TEARDOWN_GRACE_MS - 1)
    expect(h.signals).toEqual([])
    h.advance(1)
    expect(h.signals).toEqual([[10, 'SIGTERM']])
    h.advance(CLI_SIGKILL_GRACE_MS)
    expect(h.signals).toEqual([[10, 'SIGTERM']])
    expect(h.registry.list()).toEqual([])
  })

  it('terminate: escalates to SIGKILL when SIGTERM is ignored', () => {
    const h = harness()
    h.procs.set(11, { start: '100', ignoresTerm: true })
    h.registry.register(11, reg('a'))
    h.registry.terminate(h.registry.list()[0]!, 0)
    h.advance(CLI_SIGKILL_GRACE_MS)
    expect(h.signals).toEqual([[11, 'SIGTERM'], [11, 'SIGKILL']])
    expect(h.procs.has(11)).toBe(false)
  })

  it('terminate: sends nothing when the SDK already closed it', () => {
    const h = harness()
    h.procs.set(12, { start: '100' })
    h.registry.register(12, reg('a'))
    const [entry] = h.registry.list()
    h.registry.terminate(entry!)
    h.procs.delete(12) // the SDK's own close path ended it during the grace
    h.advance(CLI_TEARDOWN_GRACE_MS + CLI_SIGKILL_GRACE_MS)
    expect(h.signals).toEqual([])
  })

  it('never signals a reused pid (same pid, different start time)', () => {
    const h = harness()
    h.procs.set(13, { start: '100' })
    h.registry.register(13, reg('a'))
    const [entry] = h.registry.list()
    h.procs.set(13, { start: '999' }) // our CLI died, the kernel handed 13 to something else
    h.registry.terminate(entry!, 0)
    h.advance(CLI_SIGKILL_GRACE_MS)
    expect(h.signals).toEqual([])
    expect(h.procs.has(13)).toBe(true)
  })

  it('terminateOwner only hits that owner (and kind), and only what is registered at call time', () => {
    const h = harness()
    for (const pid of [20, 21, 22]) h.procs.set(pid, { start: String(pid) })
    h.registry.register(20, reg('a', 'persistent'))
    h.registry.register(21, reg('a', 'oneshot'))
    h.registry.register(22, reg('b', 'persistent'))
    h.registry.terminateOwner('a', { kind: 'persistent' }, 0)
    // A new persistent CLI for the same owner, spawned right after the teardown:
    h.procs.set(23, { start: '23' })
    h.registry.register(23, reg('a', 'persistent', 2))
    h.advance(CLI_SIGKILL_GRACE_MS)
    expect(h.signals).toEqual([[20, 'SIGTERM']])
    expect(h.registry.list().map(e => e.pid).sort()).toEqual([21, 22, 23])
  })

  describe('sweep (reaper backstop)', () => {
    function populated() {
      const h = harness()
      for (const pid of [30, 31, 32, 33, 34]) h.procs.set(pid, { start: String(pid) })
      h.registry.register(30, reg('live', 'persistent', 2))   // the live agent's current query
      h.registry.register(31, reg('live', 'persistent', 1))   // the same agent's previous query
      h.registry.register(32, reg('gone', 'persistent', 1))   // an agent no session references
      h.registry.register(33, reg('gone', 'oneshot', 1))      // a one-shot of that agent
      h.registry.register(34, reg('dead', 'oneshot', 1))      // a destroyed agent's one-shot
      h.registry.setOwnerGeneration('live', 2)
      h.registry.retireOwner('dead')
      return h
    }

    it('leaves young CLIs alone except those of destroyed agents', () => {
      const h = populated()
      const r = h.registry.sweep(new Set(['live']))
      expect(r.terminated.map(e => e.pid)).toEqual([34])
    })

    it('ends stale-generation and unowned persistent CLIs once old enough; keeps the current one and one-shots', () => {
      const h = populated()
      h.advance(CLI_ORPHAN_MIN_AGE_MS)
      const r = h.registry.sweep(new Set(['live']))
      expect(r.terminated.map(e => e.pid).sort()).toEqual([31, 32, 34])
      h.advance(CLI_SIGKILL_GRACE_MS)
      expect([...h.procs.keys()].sort()).toEqual([30, 33])
      expect(h.registry.sweep(new Set(['live'])).tracked).toBe(2)
    })

    it('reports dead entries as gone', () => {
      const h = populated()
      h.procs.delete(30)
      expect(h.registry.list().map(e => e.pid)).not.toContain(30)
      // 31-34 remain tracked; 34 (destroyed owner) is only scheduled, not yet signalled.
      expect(h.registry.sweep(new Set(['live']), 15 * MIN).tracked).toBe(4)
    })
  })

  it('reads a real start time from /proc for this process (Linux)', () => {
    if (process.platform !== 'linux') return
    const t = readProcStartTime(process.pid)
    expect(t).toMatch(/^\d+$/)
    expect(readProcStartTime(process.pid)).toBe(t)
    expect(readProcStartTime(2 ** 30)).toBeNull()
  })
})

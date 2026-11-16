import { afterEach, describe, expect, it } from 'bun:test'
import { cliProcessRegistry } from '@craft-agent/shared/agent'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// craft-agents#250: the idle reaper's backstop must treat exactly the agents that sessions
// reference as live, and run on every sweep.

describe('SessionManager orphaned-CLI backstop', () => {
  const realSweep = cliProcessRegistry.sweep.bind(cliProcessRegistry)
  afterEach(() => { (cliProcessRegistry as any).sweep = realSweep })

  function inject(sm: SessionManager, id: string, agent: unknown) {
    const workspace = { id: 'ws', name: 'ws', rootPath: '/tmp/none', createdAt: Date.now() }
    const managed = createManagedSession({ id, name: id }, workspace as never, { messagesLoaded: true }) as any
    managed.agent = agent
    ;(sm as any).sessions.set(id, managed)
  }

  it('passes the owner ids of agents referenced by sessions (and only those) as live', () => {
    const sm = new SessionManager()
    inject(sm, 'a', { getCliOwnerId: () => 'owner-a', isProcessing: () => false })
    inject(sm, 'b', null)
    inject(sm, 'c', { isProcessing: () => false })  // a backend without CLIs (e.g. Pi)
    let seen: Set<string> | undefined
    ;(cliProcessRegistry as any).sweep = (live: Set<string>) => { seen = new Set(live); return { tracked: 0, terminated: [] } }

    expect(sm.sweepOrphanedClis()).toEqual({ tracked: 0, terminated: 0 })
    expect(seen).toEqual(new Set(['owner-a']))
  })

  it('runs as part of every idle-runtime sweep', async () => {
    const sm = new SessionManager()
    let calls = 0
    ;(cliProcessRegistry as any).sweep = () => { calls++; return { tracked: 0, terminated: [] } }
    await sm.sweepIdleRuntimes(Date.now())
    await sm.sweepIdleRuntimes(Date.now())
    expect(calls).toBe(2)
  })
})

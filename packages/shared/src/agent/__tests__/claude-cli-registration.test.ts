import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeAgent } from '../claude-agent.ts'
import { createPushableInputStream } from '../backend/claude/persistent-input.ts'
import { cliProcessRegistry, readProcStartTime } from '../backend/claude/cli-process-registry.ts'

// craft-agents#250, against the REAL pinned SDK: a stand-in `claude` executable that never
// answers and ignores stdin EOF, i.e. a CLI the SDK's graceful close cannot end. Guards that
//  - the SDK still calls `onProcessSpawned` (an option it forwards but does not document), so an
//    SDK bump that drops it fails here instead of silently disabling the registry;
//  - ClaudeAgent registers the persistent CLI under its owner/generation, and tears a stale
//    query down before building a new one (the overwrite that leaked CLIs).

const linux = process.platform === 'linux'
let dir: string
let fakeCli: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  fakeCli = join(dir, 'claude')
  // Ignores stdin EOF (sleeps on), dies on SIGTERM like any process with default handlers. Records
  // its pid so cleanup never depends on the registry under test.
  writeFileSync(fakeCli, `#!/bin/sh\necho $$ >> '${join(dir, 'pids')}'\nexec sleep 300\n`)
  chmodSync(fakeCli, 0o755)
})
afterAll(() => {
  let pids: number[] = []
  try { pids = readFileSync(join(dir, 'pids'), 'utf8').split('\n').filter(Boolean).map(Number) } catch { /* none spawned */ }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
  rmSync(dir, { recursive: true, force: true })
})

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v !== undefined) return v
    if (Date.now() > until) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 25))
  }
}

const alive = (pid: number) => readProcStartTime(pid) !== null

describe.if(linux)('Claude CLI registration (real SDK, fake CLI)', () => {
  it('the SDK reports the spawned pid through onProcessSpawned', async () => {
    const abort = new AbortController()
    let spawned: number | undefined
    const q = query({
      prompt: createPushableInputStream<never>().stream as never,
      options: { pathToClaudeCodeExecutable: fakeCli, abortController: abort, onProcessSpawned: (pid: number) => { spawned = pid } } as never,
    })
    const it = q[Symbol.asyncIterator]()
    void it.next().catch(() => {})
    const pid = await waitFor(() => spawned)
    expect(alive(pid)).toBe(true)
    process.kill(pid, 'SIGKILL')
    abort.abort()
  })

  it('ClaudeAgent registers its persistent CLI, and a stale query is torn down before the next one', async () => {
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.cliOwnerId = 'owner-test'
    agent.persistentGeneration = 0
    agent.config = { session: { id: 'sess-test' } }
    agent.debug = () => {}
    agent.pendingSteers = { pause: () => {} }
    const options = { pathToClaudeCodeExecutable: fakeCli }
    const userMsg = (content: string) => ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })

    // Turn 1 builds the persistent query.
    agent.currentQueryAbortController = new AbortController()
    await agent.beginPersistentTurn(userMsg('one'), options, {})
    const first = await waitFor(() => cliProcessRegistry.list().find(e => e.ownerId === 'owner-test'))
    expect(first).toMatchObject({ sessionId: 'sess-test', kind: 'persistent', generation: 1 })
    expect(alive(first.pid)).toBe(true)

    // The leak shape: currentQuery dropped while the query's input/iterator/controller stay.
    const staleInput = agent.persistentInput
    const staleController = agent.persistentAbortController
    agent.currentQuery = null

    // Turn 2 must tear the stale query down (not overwrite it) and build generation 2.
    agent.currentQueryAbortController = new AbortController()
    await agent.beginPersistentTurn(userMsg('two'), options, {})
    expect(staleInput.isEnded).toBe(true)
    expect(staleController.signal.aborted).toBe(true)
    const second = await waitFor(() => cliProcessRegistry.list().find(e => e.ownerId === 'owner-test' && e.generation === 2))
    expect(second.pid).not.toBe(first.pid)

    // The fake CLI ignores the SDK's close; the registry ends it after the teardown grace.
    await waitFor(() => (alive(first.pid) ? undefined : true), 15_000)
    expect(alive(second.pid)).toBe(true)

    // destroy-style teardown ends the current one too, and retires the owner.
    agent.teardownPersistentQuery('test-end')
    await waitFor(() => (alive(second.pid) ? undefined : true), 15_000)
  }, 40_000)
})

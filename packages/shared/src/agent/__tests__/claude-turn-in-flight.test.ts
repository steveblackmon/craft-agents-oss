import { describe, expect, it } from 'bun:test'
import { ClaudeAgent, claudeThinkingKey } from '../claude-agent.ts'
import { createPushableInputStream } from '../backend/claude/persistent-input.ts'
import { AbortReason } from '../core/index.ts'

// The idle runtime reaper (storeminder#2095) asks the backend whether a turn is
// running. With keep-alive the persistent query stays open between turns, so
// isProcessing() is true while the session is idle; isTurnInFlight() must not be.
describe('ClaudeAgent.isTurnInFlight', () => {
  const thinking = { thinking: { type: 'adaptive' as const }, effort: 'high' as const }

  /** A keep-alive agent whose query has a consumer fed from `feed`. */
  function keepAliveAgent() {
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.debug = () => {}
    agent.keepBackgroundTasksAlive = true
    agent.config = {}
    const feed = createPushableInputStream<any>()
    const iterator = feed.stream[Symbol.asyncIterator]()
    agent.persistentInput = createPushableInputStream()
    agent.persistentIterator = iterator
    agent.fakeQuery = { applyFlagSettings: async () => {}, setMaxThinkingTokens: async () => {} }
    agent.currentQuery = agent.fakeQuery
    agent.persistentThinkingKey = claudeThinkingKey(thinking)
    agent.pendingSteers = { pause: () => {} }
    agent.startPersistentConsumer()
    return { agent, feed }
  }

  async function startTurn(agent: any) {
    await agent.beginPersistentTurn({ type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null }, {}, thinking)
  }

  it('is false between turns while keep-alive holds the query open (isProcessing stays true)', async () => {
    const { agent, feed } = keepAliveAgent()
    await startTurn(agent)
    expect(agent.isTurnInFlight()).toBe(true)
    // The turn's result arrives through the real consumer: the channel closes, the query lives on.
    feed.push({ type: 'result', subtype: 'success' })
    await new Promise(r => setTimeout(r, 0))
    expect(agent.activeTurnChannel).toBeNull()
    expect(agent.isProcessing()).toBe(true)
    expect(agent.isTurnInFlight()).toBe(false)
    expect(agent.hasLiveQuery()).toBe(true)
  })

  it('is true while a stopped turn is still draining', async () => {
    const { agent } = keepAliveAgent()
    await startTurn(agent)
    agent.activeTurnChannel = null
    agent.stoppedTurn = { fallback: setTimeout(() => {}, 0) }
    expect(agent.isTurnInFlight()).toBe(true)
    clearTimeout(agent.stoppedTurn.fallback)
  })

  it('with keep-alive off, an open per-turn query is a turn in flight', () => {
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.keepBackgroundTasksAlive = false
    agent.activeTurnChannel = null
    agent.stoppedTurn = null
    agent.persistentInput = null
    agent.currentQuery = {}
    expect(agent.isTurnInFlight()).toBe(true)
    agent.currentQuery = null
    expect(agent.isTurnInFlight()).toBe(false)
  })

  it('hasLiveQuery is false once the query is torn down', async () => {
    const { agent } = keepAliveAgent()
    await startTurn(agent)
    agent.forceAbort(AbortReason.UserStop)
    agent.teardownPersistentQuery('test')
    expect(agent.hasLiveQuery()).toBe(false)
    expect(agent.isTurnInFlight()).toBe(false)
  })
})

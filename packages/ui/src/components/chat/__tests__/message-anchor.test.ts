import { describe, expect, it } from 'bun:test'
import {
  MESSAGE_ANCHOR_PREFIX,
  getTurnAnchorMessageId,
  messageAnchorDomId,
  buildMessageAnchorHash,
  parseMessageAnchorFromHash,
} from '../message-anchor'
import type { AssistantTurn, UserTurn, SystemTurn, Turn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    role: 'user',
    content: 'hello',
    timestamp: 1,
    ...overrides,
  }
}

describe('getTurnAnchorMessageId', () => {
  it('uses the response message id for assistant turns', () => {
    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'turn-1',
      activities: [],
      response: { text: 'done', isStreaming: false, messageId: 'assistant-msg-9' },
      isStreaming: false,
      isComplete: true,
      timestamp: 1,
    }
    expect(getTurnAnchorMessageId(turn)).toBe('assistant-msg-9')
  })

  it('falls back to turnId for tool-only assistant turns with no response', () => {
    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'turn-42',
      activities: [],
      response: undefined,
      isStreaming: false,
      isComplete: true,
      timestamp: 1,
    }
    expect(getTurnAnchorMessageId(turn)).toBe('turn-42')
  })

  it('uses the message id for user turns', () => {
    const turn: UserTurn = { type: 'user', message: makeMessage({ id: 'user-7' }), timestamp: 1 }
    expect(getTurnAnchorMessageId(turn)).toBe('user-7')
  })

  it('uses the message id for system turns', () => {
    const turn: SystemTurn = {
      type: 'system',
      message: makeMessage({ id: 'sys-3', role: 'system' }),
      timestamp: 1,
    }
    expect(getTurnAnchorMessageId(turn)).toBe('sys-3')
  })
})

describe('messageAnchorDomId', () => {
  it('prefixes the raw (unencoded) id for use as a DOM id', () => {
    expect(messageAnchorDomId('abc')).toBe(`${MESSAGE_ANCHOR_PREFIX}abc`)
    expect(messageAnchorDomId('a:b/c')).toBe('msg-a:b/c')
  })
})

describe('buildMessageAnchorHash / parseMessageAnchorFromHash', () => {
  it('round-trips a simple id', () => {
    const hash = buildMessageAnchorHash('abc123')
    expect(hash).toBe('#msg-abc123')
    expect(parseMessageAnchorFromHash(hash)).toBe('abc123')
  })

  it('round-trips ids containing URL-significant characters', () => {
    const id = 'a/b:c?d#e'
    const hash = buildMessageAnchorHash(id)
    expect(parseMessageAnchorFromHash(hash)).toBe(id)
  })

  it('parses a hash without the leading #', () => {
    expect(parseMessageAnchorFromHash('msg-xyz')).toBe('xyz')
  })

  it('returns null for non-anchor hashes', () => {
    expect(parseMessageAnchorFromHash('')).toBeNull()
    expect(parseMessageAnchorFromHash(undefined)).toBeNull()
    expect(parseMessageAnchorFromHash(null)).toBeNull()
    expect(parseMessageAnchorFromHash('#section-2')).toBeNull()
    expect(parseMessageAnchorFromHash('#msg-')).toBeNull()
  })

  it('falls back to the raw value on malformed percent-encoding', () => {
    expect(parseMessageAnchorFromHash('#msg-%E0%A4%A')).toBe('%E0%A4%A')
  })

  it('ignores unrelated turn types', () => {
    const turn = { type: 'weird' } as unknown as Turn
    expect(getTurnAnchorMessageId(turn)).toBeUndefined()
  })
})

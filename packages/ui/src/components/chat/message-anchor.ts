/**
 * message-anchor.ts
 *
 * Helpers for deep-linkable message anchors — a permalink / scroll-to for a
 * specific message inside a session transcript.
 *
 * A message anchor is expressed in a URL as a fragment: `#msg-<messageId>`.
 * The same `messageId` is emitted onto each message wrapper in the DOM
 * (`id="msg-<messageId>"` + `data-message-id="<messageId>"`), so the target can
 * be found and scrolled into view on load.
 *
 * Kept as small, pure, framework-free functions so both the `/s/` viewer and the
 * web UI (and their tests) can share the exact same anchor grammar.
 *
 * See craft-ai-agents/craft-agents-oss#949.
 */

import type { Turn } from './turn-utils'

/** Prefix for both the URL fragment and the DOM id of a message anchor. */
export const MESSAGE_ANCHOR_PREFIX = 'msg-'

/**
 * The stable message id used to anchor a turn in the transcript.
 *
 * `messageId` already exists in the data model; this maps each rendered turn to
 * the id that should become its DOM anchor:
 * - assistant turns → the final response message id (falls back to `turnId` for
 *   tool-only turns that never produced a text response)
 * - user / system / auth-request turns → the message id
 */
export function getTurnAnchorMessageId(turn: Turn, _index?: number): string | undefined {
  switch (turn.type) {
    case 'assistant':
      return turn.response?.messageId ?? turn.turnId
    case 'user':
    case 'system':
    case 'auth-request':
      return turn.message.id
    default:
      return undefined
  }
}

/** DOM id for a message anchor, e.g. `msg-<messageId>`. */
export function messageAnchorDomId(messageId: string): string {
  return `${MESSAGE_ANCHOR_PREFIX}${messageId}`
}

/**
 * Build a URL fragment (including the leading `#`) that targets a message.
 * The id is percent-encoded so ids containing URL-significant characters survive.
 */
export function buildMessageAnchorHash(messageId: string): string {
  return `#${MESSAGE_ANCHOR_PREFIX}${encodeURIComponent(messageId)}`
}

/**
 * Parse a message id out of a location hash like `#msg-<id>`.
 * Returns `null` when the hash is not a message anchor.
 */
export function parseMessageAnchorFromHash(hash: string | undefined | null): string | null {
  if (!hash) return null
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw.startsWith(MESSAGE_ANCHOR_PREFIX)) return null
  const encoded = raw.slice(MESSAGE_ANCHOR_PREFIX.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    // Malformed percent-encoding — fall back to the raw value.
    return encoded
  }
}

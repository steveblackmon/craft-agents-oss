/**
 * SessionViewer - Read-only session transcript viewer
 *
 * Platform-agnostic component for viewing session transcripts.
 * Used by the web viewer app. For interactive chat, Electron uses ChatDisplay.
 *
 * Renders a session's messages as turn cards with gradient fade at top/bottom.
 */

import type { ReactNode } from 'react'
import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import type { StoredSession } from '@craft-agent/core'
import { cn } from '../../lib/utils'
import { CHAT_LAYOUT, CHAT_CLASSES } from '../../lib/layout'
import { PlatformProvider, type PlatformActions } from '../../context'
import { TurnCard } from './TurnCard'
import { UserMessageBubble } from './UserMessageBubble'
import { SystemMessage } from './SystemMessage'
import {
  groupMessagesByTurn,
  storedToMessage,
  getAssistantTurnUiKey,
  type ActivityItem,
} from './turn-utils'
import { getTurnAnchorMessageId, messageAnchorDomId } from './message-anchor'

export type SessionViewerMode = 'interactive' | 'readonly'

export interface SessionViewerProps {
  /** Session data to display */
  session: StoredSession
  /** View mode - 'readonly' for web viewer, 'interactive' for Electron */
  mode?: SessionViewerMode
  /** Platform-specific actions (file opening, URL handling, etc.) */
  platformActions?: PlatformActions
  /** Additional className for the container */
  className?: string
  /** Callback when a turn is clicked */
  onTurnClick?: (turnId: string) => void
  /** Callback when an activity is clicked */
  onActivityClick?: (activity: ActivityItem) => void
  /** Default expanded state for turns (true for readonly, false for interactive) */
  defaultExpanded?: boolean
  /** Custom header content */
  header?: ReactNode
  /** Custom footer content (input area for interactive mode) */
  footer?: ReactNode
  /** Optional session folder path for stripping from file paths in tool display */
  sessionFolderPath?: string
  /**
   * Deep-link target: the messageId of a message to scroll to and briefly
   * highlight once the transcript has rendered. Derived from a `#msg-<id>`
   * fragment (or `/m/<id>` route segment) by the host app. See #949.
   */
  targetMessageId?: string
}

/** How long the transient highlight stays on a deep-linked message. */
const MESSAGE_HIGHLIGHT_MS = 2400

/**
 * CraftAgentLogo - The Craft Agent "C" logo for branding
 */
function CraftAgentLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(3.4502, 3)" fill="currentColor">
        <path
          d="M3.17890888,3.6 L3.17890888,0 L16,0 L16,3.6 L3.17890888,3.6 Z M9.642,7.2 L9.64218223,10.8 L0,10.8 L0,3.6 L16,3.6 L16,7.2 L9.642,7.2 Z M3.17890888,18 L3.178,14.4 L0,14.4 L0,10.8 L16,10.8 L16,18 L3.17890888,18 Z"
          fillRule="nonzero"
        />
      </g>
    </svg>
  )
}

/**
 * SessionViewer - Read-only session transcript viewer component
 */
export function SessionViewer({
  session,
  mode = 'readonly',
  platformActions = {},
  className,
  onTurnClick,
  onActivityClick,
  defaultExpanded = false,
  header,
  footer,
  sessionFolderPath,
  targetMessageId,
}: SessionViewerProps) {
  // Convert StoredMessage[] to Message[] and group into turns.
  // Viewer is always a snapshot of a finished session, so we mark it as not processing
  // to force the open turn (if any) to flush with the intermediate-text fallback applied.
  const turns = useMemo(
    () => groupMessagesByTurn(session.messages.map(storedToMessage), { isSessionProcessing: false }),
    [session.messages]
  )

  // Track expanded turns (for controlled state)
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => {
    // Default: all turns collapsed, can override with defaultExpanded prop
    if (defaultExpanded) {
      return new Set(
        turns
          .map((turn, index) => turn.type === 'assistant' ? getAssistantTurnUiKey(turn, index) : null)
          .filter((key): key is string => !!key)
      )
    }
    return new Set()
  })

  // Track expanded activity groups
  const [expandedActivityGroups, setExpandedActivityGroups] = useState<Set<string>>(new Set())

  // Deep-link scroll-to: the scrollable transcript container and the messageId
  // currently painted with the transient highlight. See #949.
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)

  // When a target message id is supplied (from a `#msg-<id>` fragment), find the
  // corresponding wrapper and scroll it into view with a transient highlight.
  // The effect also depends on `turns` so a target that arrives before the
  // session has loaded is honored once the transcript renders.
  useEffect(() => {
    if (!targetMessageId) return
    const container = scrollContainerRef.current
    if (!container) return

    let cleared: ReturnType<typeof setTimeout> | undefined
    const raf = requestAnimationFrame(() => {
      // Attribute lookup avoids escaping ids that contain CSS-significant chars.
      const escaped = typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(targetMessageId)
        : targetMessageId.replace(/"/g, '\\"')
      const el = container.querySelector(`[data-message-id="${escaped}"]`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedMessageId(targetMessageId)
      cleared = setTimeout(() => setHighlightedMessageId(null), MESSAGE_HIGHLIGHT_MS)
    })

    return () => {
      cancelAnimationFrame(raf)
      if (cleared) clearTimeout(cleared)
    }
  }, [targetMessageId, turns])

  const handleExpandedChange = useCallback((turnId: string, expanded: boolean) => {
    setExpandedTurns(prev => {
      const next = new Set(prev)
      if (expanded) {
        next.add(turnId)
      } else {
        next.delete(turnId)
      }
      return next
    })
  }, [])

  const handleExpandedActivityGroupsChange = useCallback((groups: Set<string>) => {
    setExpandedActivityGroups(groups)
  }, [])

  const handleOpenActivityDetails = useCallback((activity: ActivityItem) => {
    if (onActivityClick) {
      onActivityClick(activity)
    } else if (platformActions.onOpenActivityDetails) {
      platformActions.onOpenActivityDetails(session.id, activity.id)
    }
  }, [onActivityClick, platformActions, session.id])

  const handleOpenTurnDetails = useCallback((turnId: string) => {
    if (onTurnClick) {
      onTurnClick(turnId)
    } else if (platformActions.onOpenTurnDetails) {
      platformActions.onOpenTurnDetails(session.id, turnId)
    }
  }, [onTurnClick, platformActions, session.id])

  return (
    <PlatformProvider actions={platformActions}>
      <div className={cn("flex flex-col h-full", className)}>
        {/* Header */}
        {header && (
          <div className="shrink-0 border-b">
            {header}
          </div>
        )}

        {/* Messages area with gradient fade mask at top/bottom */}
        <div
          className="flex-1 min-h-0"
          style={{
            maskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
          }}
        >
          <div ref={scrollContainerRef} className="h-full overflow-y-auto">
            <div className={cn(CHAT_LAYOUT.maxWidth, "mx-auto", CHAT_LAYOUT.containerPadding, CHAT_LAYOUT.messageSpacing)}>
            {turns.map((turn, index) => {
              // Stable per-message anchor so a `#msg-<id>` deep link can target
              // this exact message. `scroll-mt` keeps the target clear of the
              // top gradient-fade mask; the ring is the transient highlight.
              const anchorMessageId = getTurnAnchorMessageId(turn, index)
              const isHighlighted = !!anchorMessageId && anchorMessageId === highlightedMessageId
              const anchorProps = anchorMessageId
                ? { id: messageAnchorDomId(anchorMessageId), 'data-message-id': anchorMessageId }
                : {}
              const anchorClass = cn(
                'scroll-mt-12 rounded-xl transition-shadow duration-500',
                isHighlighted && 'ring-2 ring-[#9570BE]/60 ring-offset-2 ring-offset-transparent'
              )

              if (turn.type === 'user') {
                return (
                  <div key={turn.message.id} {...anchorProps} className={cn(anchorClass, CHAT_LAYOUT.userMessagePadding)}>
                    <UserMessageBubble
                      content={turn.message.content}
                      attachments={turn.message.attachments}
                      badges={turn.message.badges}
                      onUrlClick={platformActions.onOpenUrl}
                      onFileClick={platformActions.onOpenFile}
                    />
                  </div>
                )
              }

              if (turn.type === 'system') {
                const msgType = turn.message.role === 'error' ? 'error' :
                               turn.message.role === 'warning' ? 'warning' :
                               turn.message.role === 'info' ? 'info' : 'system'
                return (
                  <div key={turn.message.id} {...anchorProps} className={anchorClass}>
                    <SystemMessage
                      content={turn.message.content}
                      type={msgType}
                    />
                  </div>
                )
              }

              if (turn.type === 'assistant') {
                const assistantUiKey = getAssistantTurnUiKey(turn, index)
                return (
                  <div key={assistantUiKey} {...anchorProps} className={anchorClass}>
                  <TurnCard
                    turnId={turn.turnId}
                    activities={turn.activities}
                    response={turn.response}
                    intent={turn.intent}
                    isStreaming={turn.isStreaming}
                    isComplete={turn.isComplete}
                    isExpanded={expandedTurns.has(assistantUiKey)}
                    onExpandedChange={(expanded) => handleExpandedChange(assistantUiKey, expanded)}
                    onOpenFile={platformActions.onOpenFile}
                    onOpenUrl={platformActions.onOpenUrl}
                    onPopOut={platformActions.onOpenMarkdownPreview}
                    onOpenDetails={() => handleOpenTurnDetails(turn.turnId)}
                    onOpenActivityDetails={handleOpenActivityDetails}
                    todos={turn.todos}
                    expandedActivityGroups={expandedActivityGroups}
                    onExpandedActivityGroupsChange={handleExpandedActivityGroupsChange}
                    hasEditOrWriteActivities={turn.activities.some(a =>
                      a.toolName === 'Edit' || a.toolName === 'Write'
                    )}
                    onOpenMultiFileDiff={platformActions.onOpenMultiFileDiff
                      ? () => platformActions.onOpenMultiFileDiff!(session.id, turn.turnId)
                      : undefined
                    }
                    sessionFolderPath={sessionFolderPath}
                    annotationInteractionMode={mode === 'readonly' ? 'tooltip-only' : 'interactive'}
                  />
                  </div>
                )
              }

              return null
            })}

            {/* Bottom branding */}
            <div className={CHAT_CLASSES.brandingContainer}>
              <CraftAgentLogo className="w-8 h-8 text-[#9570BE]/40" />
            </div>
            </div>
          </div>
        </div>

        {/* Footer (input area) */}
        {footer && (
          <div className="shrink-0 border-t">
            {footer}
          </div>
        )}
      </div>
    </PlatformProvider>
  )
}

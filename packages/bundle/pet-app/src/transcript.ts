/**
 * Fold durable Session events into the transcript the pet renders. Internal
 * bookkeeping (requests, prompts, inbox splices, model selections) is dropped;
 * every user message, assistant message, tool result, and turn boundary is kept
 * in log order.
 *
 * @module @deepseek-ai/dsh-pet-app/transcript
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TranscriptEntry, TranscriptToolCall } from './types.ts'

/**
 * Extract visible text from one message's content blocks.
 * @param content - the message content.
 * @returns the concatenated text blocks.
 */
export function textOf(content: readonly ContentBlock[]): string {
  return content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('')
}

/**
 * Extract reasoning text from one message's content blocks.
 * @param content - the message content.
 * @returns the concatenated reasoning blocks.
 */
export function reasoningOf(content: readonly ContentBlock[]): string {
  return content
    .flatMap(block => block.type === 'reasoning' ? [block.text] : [])
    .join('')
}

/**
 * Extract tool calls from one message's content blocks.
 * @param content - the message content.
 * @returns the tool calls in block order.
 */
export function toolCallsOf(content: readonly ContentBlock[]): TranscriptToolCall[] {
  return content
    .flatMap(block => block.type === 'tool-call'
      ? [{ callId: String(block.id), name: block.name, arguments: block.arguments }]
      : [])
}

/**
 * Fold events for one session lifetime. It remembers tool names so a later
 * `tool/result` can name the call it answers.
 */
export class TranscriptBuilder {
  private readonly toolNames = new Map<string, string>()

  /**
   * Normalize one committed event.
   * @param event - committed Session event in log order.
   * @returns the transcript entry it contributes, or undefined for internal events.
   */
  push(event: SessionEvent): TranscriptEntry | undefined {
    switch (event.type) {
      case 'user/message': {
        const text = textOf(event.data.content)
        return text === '' ? undefined : { kind: 'user', at: event.time, text }
      }
      case 'assistant/message': {
        const { content } = event.data.message
        const text = textOf(content)
        const reasoning = reasoningOf(content)
        const tools = toolCallsOf(content)
        if (text === '' && reasoning === '' && tools.length === 0) return undefined
        for (const tool of tools) this.toolNames.set(tool.callId, tool.name)
        return { kind: 'assistant', at: event.time, text, reasoning, tools }
      }
      case 'tool/call':
        this.toolNames.set(String(event.data.callId), event.data.name)
        return undefined
      case 'tool/result': {
        const { message } = event.data
        const text = textOf(message.content)
        return {
          kind: 'tool',
          at: event.time,
          callId: String(message.toolCallId),
          name: this.toolNames.get(String(message.toolCallId)),
          text,
          isError: message.isError === true,
        }
      }
      case 'turn/start':
        return undefined
      case 'turn/end': {
        const reason = event.data.reason
        return {
          kind: 'status',
          at: event.time,
          label: reason.kind === 'completed' ? 'Turn completed' : `Turn ended: ${reason.kind}`,
        }
      }
      default:
        return undefined
    }
  }
}

/**
 * Return the last non-empty assistant text, falling back to all assistant text joined.
 * @param entries - the transcript entries in log order.
 * @returns the final assistant text, or the joined assistant text.
 */
export function finalAssistantText(entries: readonly TranscriptEntry[]): string {
  let last = ''
  const all: string[] = []
  for (const entry of entries) {
    if (entry.kind !== 'assistant' || entry.text === '') continue
    last = entry.text
    all.push(entry.text)
  }
  return last === '' ? all.join('') : last
}

/** Transcript normalization and final-text selection. */

import { describe, expect, it } from 'vitest'
import { finalAssistantText, textOf } from '../src/transcript.ts'
import type { TranscriptEntry } from '../src/types.ts'

describe('transcript helpers', () => {
  it('joins visible text blocks only', () => {
    expect(textOf([
      { type: 'text', text: 'hello ' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'world' },
    ])).toBe('hello world')
  })

  it('selects the last non-empty assistant message', () => {
    const entries: TranscriptEntry[] = [
      { kind: 'assistant', at: 1, text: 'first', reasoning: '', tools: [] },
      { kind: 'assistant', at: 2, text: '', reasoning: 'reasoning only', tools: [] },
      { kind: 'assistant', at: 3, text: 'final', reasoning: '', tools: [] },
    ]
    expect(finalAssistantText(entries)).toBe('final')
  })

  it('falls back to all assistant text when every message is empty', () => {
    expect(finalAssistantText([
      { kind: 'assistant', at: 1, text: 'a', reasoning: '', tools: [] },
      { kind: 'assistant', at: 2, text: 'b', reasoning: '', tools: [] },
    ])).toBe('b')
  })
})

/** MCP presentation helpers. */

import { describe, expect, it } from 'vitest'
import { outcomeText, tokenMatches } from '../src/mcp.ts'

describe('MCP helpers', () => {
  it('returns the execution output for independent verification', () => {
    const text = outcomeText({
      id: 'd-1',
      status: 'completed',
      text: 'Implemented.',
      stopReason: 'completed',
    })
    expect(text).toContain('Delegate: d-1')
    expect(text).toContain('Verification: required by the calling Agent')
    expect(text).toContain('Implemented.')
  })

  it('reports a failed execution with its stop reason', () => {
    const text = outcomeText({
      id: 'd-2',
      status: 'failed',
      text: '',
      stopReason: 'error',
      error: 'error: boom',
    })
    expect(text).toContain('Stop reason: error')
    expect(text).toContain('Error: error: boom')
    expect(text).toContain('(the execution subagent returned no text)')
  })

  it('compares tokens without accepting missing values', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abc', 'abd')).toBe(false)
    expect(tokenMatches('abc', undefined)).toBe(false)
  })
})

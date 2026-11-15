/** MCP presentation helpers. */

import { describe, expect, it } from 'vitest'
import { outcomeText, tokenMatches } from '../src/mcp.ts'

describe('MCP helpers', () => {
  it('renders acceptance, errors, and the returned text', () => {
    const text = outcomeText({
      id: 'd-1',
      status: 'completed',
      acceptance: { accepted: true, notes: 'tests pass' },
      text: 'Implemented and verified.',
      stopReason: 'completed',
    })
    expect(text).toContain('Delegate: d-1')
    expect(text).toContain('Acceptance: accepted')
    expect(text).toContain('Acceptance notes: tests pass')
    expect(text).toContain('Implemented and verified.')
  })

  it('marks an unrecorded verdict and failure detail', () => {
    const text = outcomeText({
      id: 'd-2',
      status: 'failed',
      acceptance: undefined,
      text: '',
      stopReason: 'error: boom',
      error: 'error: boom',
    })
    expect(text).toContain('Acceptance: not recorded')
    expect(text).toContain('Error: error: boom')
    expect(text).toContain('(the worker returned no text)')
  })

  it('compares tokens without accepting missing values', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abc', 'abd')).toBe(false)
    expect(tokenMatches('abc', undefined)).toBe(false)
  })
})

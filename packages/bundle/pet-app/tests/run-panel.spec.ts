/** Run panel interactions while the worker transcript is refreshed. */

import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import type { DelegateRecord } from '../src/types.ts'

const html = readFileSync(new URL('../assets/pet.html', import.meta.url), 'utf8')
const script = readFileSync(new URL('../assets/pet.js', import.meta.url), 'utf8')

it('retains Run expansion choices across detail polls', async () => {
  const at = Date.now()
  const record: DelegateRecord = {
    id: 'd-one', agentSession: 'conversation', task: 'task', acceptanceCriteria: 'criteria',
    expectedReturn: 'result', dispatchedAt: at, status: 'running', mainSessionId: 'main', workspace: '/work',
    transcript: [{
      kind: 'assistant', at, text: 'x'.repeat(2_000), reasoning: 'reasoning',
      tools: [{ callId: 'call', name: 'subagent', arguments: '{}' }],
    }, {
      kind: 'tool', at, callId: 'call', name: 'subagent', text: 'y'.repeat(1_300), isError: false,
    }],
    subagents: [{
      runId: 'run', sessionId: 'child', parentSessionId: 'main', name: 'child', label: 'child',
      icon: '🐳', color: '#6ea8ff', startedAt: at, status: 'running', transcript: [],
    }],
  }
  const polls = new Map<number, () => void>()
  const { window } = new JSDOM(html, {
    url: 'https://pet.invalid/pet?token=test',
    runScripts: 'outside-only',
    beforeParse(window) {
      window.setInterval = (handler, delay = 0) => {
        if (typeof handler !== 'function') throw new Error('Expected a poll callback')
        polls.set(delay, () => { handler() })
        return delay
      }
      window.clearInterval = (id) => {
        if (id !== undefined) polls.delete(id)
      }
      window.fetch = async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/pet/api/delegates/d-one') return Response.json(record)
        if (path === '/pet/api/history') return Response.json({
          count: 1, limit: 1_000, groups: [{ agentSession: record.agentSession, count: 1, entries: [{
            id: record.id, taskPreview: record.task, dispatchedAt: at, status: record.status, subagentCount: 1,
          }] }],
        })
        if (path === '/pet/api/snapshot') return Response.json({ historyCount: 1, active: [], subagents: [] })
        throw new Error(`Unexpected request: ${path}`)
      }
    },
  })
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = window.document.querySelector<T>(selector)
    if (element === null) throw new Error(`Missing ${selector}`)
    return element
  }
  const refresh = async (label: string) => {
    record.transcript.push({ kind: 'status', at, label })
    const poll = polls.get(1_200)
    if (poll === undefined) throw new Error('Detail poll did not start')
    poll()
    await vi.waitFor(() => expect(find('.entry.status:last-child').textContent).toBe(label))
  }

  try {
    window.eval(script)
    find('#history-button').click()
    await vi.waitFor(() => find('.history-row').click())
    await vi.waitFor(() => expect(find('#panel-name').textContent).toBe(record.agentSession))
    find('[data-tab="run"]').click()

    const summaries = ['.assistant details:first-of-type', '.assistant details:last-of-type']
    const longTexts = ['.assistant', '.tool']
    for (const selector of summaries) find(`${selector} summary`).click()
    for (const selector of longTexts) find(`${selector} .entry-toggle`).click()
    find('.subagent-block > summary').click()
    find('.assistant .entry-toggle').focus()

    await refresh('First refresh')
    for (const selector of summaries) expect(find<HTMLDetailsElement>(selector).open).toBe(true)
    for (const selector of longTexts) expect(find(`${selector} .entry-text`).classList.contains('clamp')).toBe(false)
    expect(find<HTMLDetailsElement>('.subagent-block').open).toBe(false)
    expect(window.document.activeElement).toBe(find('.assistant .entry-toggle'))

    for (const selector of summaries) find(`${selector} summary`).click()
    for (const selector of longTexts) find(`${selector} .entry-toggle`).click()
    find('.subagent-block > summary').click()
    const child = record.subagents[0]
    if (child === undefined) throw new Error('Missing child fixture')
    child.status = 'completed'

    await refresh('Second refresh')
    for (const selector of summaries) expect(find<HTMLDetailsElement>(selector).open).toBe(false)
    for (const selector of longTexts) expect(find(`${selector} .entry-text`).classList.contains('clamp')).toBe(true)
    expect(find<HTMLDetailsElement>('.subagent-block').open).toBe(true)
  } finally {
    window.close()
  }
})

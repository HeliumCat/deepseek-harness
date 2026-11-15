// Scripted keyless adapter for the pet profile e2e. The worker main agent
// (system prompt contains "pet worker") is driven through one subagent
// delegation, one acceptance verdict, and a final reply; every other agent
// answers one text line directly. Plain .mjs so the built CLI loads it.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const HIGH = 'high'

class PetMockAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: HIGH, name: 'High' }], defaultEffort: HIGH },
    }
  }

  async *stream(options) {
    const systemText = options.messages
      .filter(message => message.role === 'system')
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    const worker = systemText.includes('pet worker')
    if (!worker) {
      yield* textBlock('PET_CHILD_OK')
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    // Anchor on the current delegation envelope; subagent settlement messages
    // arrive as user-role messages and must not reset the anchor.
    let anchor = -1
    options.messages.forEach((message, index) => {
      if (message.role !== 'user') return
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (text.includes('Codex delegation')) anchor = index
    })
    const toolResults = options.messages.filter((message, index) => message.role === 'tool' && index > anchor)
    if (toolResults.length === 0) {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'Delegating the task to one subagent.' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Delegating the task to one subagent.' } }
      yield* toolBlock(
        'pet-mock-subagent',
        'subagent',
        JSON.stringify({ prompt: 'Produce exactly the text PET_CHILD_OK and nothing else.', description: 'Pet e2e child' }),
        1,
      )
      yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const last = toolResults.at(-1)
    const toolText = last?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    if (toolText.includes('Acceptance recorded')) {
      const allText = options.messages
        .flatMap(message => message.content)
        .filter(block => block.type === 'text')
        .map(block => block.text)
      const childOut = allText.find(text => text.includes('PET_CHILD_OK')) ?? ''
      yield* textBlock(`PET_RESULT_OK child said: ${childOut} | ${toolText}`)
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield* toolBlock(
      'pet-mock-acceptance',
      'pet_acceptance',
      JSON.stringify({ accepted: true, notes: 'PET_ACCEPT_OK: the child output matches the acceptance criterion.' }),
      0,
    )
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function *textBlock(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
}

function *toolBlock(id, name, args, index) {
  yield { type: 'block-start', index, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
  yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }
}

export const name = 'pet-mock-llm'
export const inject = ['llm']

/** Register the keyless `cli-mock` adapter used by the e2e patch. */
export function apply(ctx) {
  ctx.llm.registerAdapter(['cli-mock'], new PetMockAdapter())
}

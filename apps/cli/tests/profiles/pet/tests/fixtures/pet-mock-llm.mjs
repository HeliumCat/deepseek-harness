// Scripted keyless adapter for the pet profile e2e. The worker main agent
// (system prompt contains "pet worker") is driven through one subagent
// delegation and acceptance. Child prompts select the recursive test path.
// Plain .mjs so the built CLI loads it.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const HIGH = 'high'
const HIGH_EFFORT = { id: HIGH, name: 'High' }
const MAX_EFFORT = { id: 'max', name: 'Max' }
const CHILD_MODELS = ['pet-selected', 'pet-high-only', 'pet-no-effort']

class PetMockAdapter extends LlmAdapter {
  async listModels(provider) {
    const models = provider === 'cli-mock' ? ['cli-mock'] : CHILD_MODELS
    return models.map(id => ({ provider, id, name: 'Pet test model' }))
  }

  async resolveModel(provider, model) {
    const efforts = model === 'pet-high-only' ? [HIGH_EFFORT] : [HIGH_EFFORT, MAX_EFFORT]
    return {
      provider,
      id: model,
      name: 'Pet test model',
      ...model === 'pet-no-effort' ? {} : { reasoning: { efforts, defaultEffort: HIGH } },
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
      if (options.messages.some(message => message.role === 'user' && message.content.some(block =>
        block.type === 'text' && block.text.startsWith('PET_NESTED_CHILD')))
        && !options.messages.some(message => message.role === 'tool')) {
        yield* toolBlock('pet-grandchild', 'subagent', JSON.stringify({
          prompt: 'Return the selected model marker.', description: 'Pet e2e grandchild',
        }), 0)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (options.model === 'cli-mock' && options.reasoningEffort !== 'max') {
        throw new Error('the inherited child model must get the pet default max effort')
      }
      yield* textBlock(options.model === 'cli-mock'
        ? 'PET_CHILD_OK'
        : `${options.provider}/${options.model} ${options.reasoningEffort ?? 'none'} PET_SELECTED`)
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (options.provider !== 'cli-mock' || options.model !== 'cli-mock' || options.reasoningEffort !== HIGH) {
      throw new Error('the worker main agent must keep its configured model and adapter effort')
    }
    // Anchor on the current delegation envelope; subagent settlement messages
    // arrive as user-role messages and must not reset the anchor.
    let anchor = -1
    let envelope = ''
    options.messages.forEach((message, index) => {
      if (message.role !== 'user') return
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (text.includes('Agent delegation')) {
        anchor = index
        envelope = text
      }
    })
    const toolResults = options.messages.filter((message, index) => message.role === 'tool' && index > anchor)
    if (toolResults.length === 0) {
      const prompt = envelope.includes('PET_TRY_NESTED') ? 'PET_NESTED_CHILD: try one child.' : 'Return the child marker.'
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'Delegating the task to one subagent.' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Delegating the task to one subagent.' } }
      yield* toolBlock(
        'pet-mock-subagent',
        'subagent',
        JSON.stringify({ prompt, description: 'Pet e2e child' }),
        1,
      )
      if (envelope.includes('PET_TRY_SIBLINGS')) {
        yield* toolBlock('pet-extra-sibling', 'subagent', JSON.stringify({
          prompt, description: 'Pet e2e sibling',
        }), 2)
      }
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
      const childOut = allText.find(text => text.includes('PET_SELECTED') || text.includes('PET_CHILD_OK')) ?? ''
      yield* textBlock(`PET_RESULT_OK child said: ${childOut} | ${toolText}`)
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const accepted = !envelope.includes('The child output text is exactly PET_CHILD_OTHER.')
    const notes = accepted
      ? 'The child output matches the acceptance criterion.'
      : 'The criterion expected PET_CHILD_OTHER. The child returned PET_CHILD_OK.'
    yield* toolBlock(
      'pet-mock-acceptance',
      'pet_acceptance',
      JSON.stringify({ accepted, notes }),
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
  ctx.effect(() => ctx.llm.registerAdapter(['cli-mock', 'pet-child-mock'], new PetMockAdapter()))
}

/** Keyless execution-subagent adapter for the built Pet profile test. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const HIGH = 'high'
const HIGH_EFFORT = { id: HIGH, name: 'High' }
const MAX_EFFORT = { id: 'max', name: 'Max' }
const CHILD_MODELS = ['pet-selected', 'pet-high-only', 'pet-no-effort']
const FLASH = 'deepseek-flash'

class PetMockAdapter extends LlmAdapter {
  async listModels(provider) {
    const models = provider === 'cli-mock' ? ['cli-mock'] : provider === 'deepseek-official' ? [FLASH] : CHILD_MODELS
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
    const assignment = options.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content).find(block =>
        block.type === 'text' && block.text.startsWith('Agent delegation '))?.text ?? ''
    if (assignment.includes('PET_TRY_NESTED') && !options.messages.some(message => message.role === 'tool')) {
      yield* toolBlock('pet-grandchild', 'subagent', JSON.stringify({
        prompt: 'Return the selected model marker.', description: 'Pet e2e grandchild',
      }), 0)
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (options.model === 'cli-mock') {
      throw new Error('the lead subagent must not run a model turn')
    }
    if (options.provider === 'deepseek-official' && (options.model !== FLASH || options.reasoningEffort !== 'max')) {
      throw new Error('the default execution route must be DeepSeek Flash with max reasoning')
    }
    if (options.tools?.some(tool => tool.name === 'pet_acceptance')) {
      throw new Error('the lead subagent must not run a model turn')
    }
    if (assignment.includes('PET_FORCE_FAILURE')) {
      throw new Error('PET_EXECUTION_FAILED')
    }
    if (assignment.includes('PET_WAIT_FOR_CANCEL')) {
      const { signal } = options
      if (signal === undefined) throw new Error('missing execution cancellation signal')
      signal.throwIfAborted()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      signal.throwIfAborted()
    }
    yield* textBlock(options.provider === 'deepseek-official'
      ? 'PET_CHILD_OK'
      : `${options.provider}/${options.model} ${options.reasoningEffort ?? 'none'} PET_SELECTED`)
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
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

/** Register keyless routes for the lead, default execution, and explicit execution models. */
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['cli-mock', 'deepseek-official', 'pet-child-mock'], new PetMockAdapter()))
}

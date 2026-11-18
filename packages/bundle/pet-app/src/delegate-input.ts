/** Assignment validation shared by the MCP and schedule storage. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { DelegateInput } from './types.ts'

/**
 * Read one non-blank string argument.
 * @param args - untrusted argument object.
 * @param name - field to read.
 * @returns the original string or undefined when invalid or absent.
 */
export function requiredString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Decode the assignment fields accepted by MCP and recurring schedule storage.
 * @param args - untrusted assignment values.
 * @returns normalized input or a validation diagnostic.
 */
export function parseDelegateInput(args: Record<string, unknown>): DelegateInput | string {
  const agentSession = requiredString(args, 'agentSession')
  const task = requiredString(args, 'task')
  const acceptanceCriteria = requiredString(args, 'acceptanceCriteria')
  const expectedReturn = requiredString(args, 'expectedReturn')
  if (agentSession === undefined || task === undefined || acceptanceCriteria === undefined || expectedReturn === undefined) {
    return 'Delegation requires non-empty agentSession, task, acceptanceCriteria, and expectedReturn strings.'
  }
  const model = args['subagentModel']
  let subagentModel: DelegateInput['subagentModel']
  if (model !== undefined) {
    if (typeof model !== 'object' || model === null || Array.isArray(model) || Object.keys(model).length !== 2
      || !('provider' in model) || typeof model.provider !== 'string' || model.provider.trim() === ''
      || !('model' in model) || typeof model.model !== 'string' || model.model.trim() === '') {
      return 'subagentModel requires non-empty provider and model strings from list_subagent_models.'
    }
    subagentModel = { provider: model.provider.trim(), model: model.model.trim() }
  }
  const reasoningEffort = requiredString(args, 'reasoningEffort')?.trim()
  if (reasoningEffort === undefined && args['reasoningEffort'] !== undefined) {
    return 'reasoningEffort must be a non-empty effort ID from list_subagent_models.'
  }
  const maxDepth = args['maxDepth']
  const maxSubagents = args['maxSubagents']
  if (maxDepth !== undefined && (typeof maxDepth !== 'number' || !Number.isSafeInteger(maxDepth) || maxDepth < 1)) {
    return 'maxDepth must be a positive safe integer.'
  }
  if (maxSubagents !== undefined && (typeof maxSubagents !== 'number' || !Number.isSafeInteger(maxSubagents) || maxSubagents < 1)) {
    return 'maxSubagents must be a positive safe integer.'
  }
  return {
    agentSession, task, acceptanceCriteria, expectedReturn,
    ...subagentModel === undefined ? {} : { subagentModel },
    ...reasoningEffort === undefined ? {} : { reasoningEffort: brandString<ReasoningEffortId>(reasoningEffort) },
    ...maxDepth === undefined ? {} : { maxDepth },
    ...maxSubagents === undefined ? {} : { maxSubagents },
  }
}

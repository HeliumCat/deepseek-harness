/**
 * The model-facing acceptance tool mounted only in the pet worker preset. The
 * worker main agent calls it once after its subagents settle; the tool writes
 * the verdict onto the active delegation so the pet and the MCP result can show
 * whether the acceptance criteria were met.
 *
 * @module @deepseek-ai/dsh-pet-app/acceptance
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import type {} from './worker.ts'

/** Cordis plugin identity. */
export const name = 'pet-acceptance'

/** Registries and the delegation service this tool reads. */
export const inject = ['tools', 'petWorker']

/**
 * Register `pet_acceptance` for the worker main agent.
 * @param ctx - agent-scoped context carrying the tool registry and delegation service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'pet_acceptance',
    description:
      'Record whether the subagent results satisfy the delegated task\'s acceptance criteria. Call this exactly once, after '
      + 'all subagents have finished and before your final reply. `accepted` is true only when the evidence meets every '
      + 'criterion; `notes` states what you checked and why the verdict follows. The pet and the MCP result use this verdict.',
    parameters: {
      accepted: {
        type: 'boolean',
        required: true,
        description: 'True only when the subagent results meet every acceptance criterion.',
      },
      notes: {
        type: 'string',
        required: true,
        description: 'What was checked and why the results were accepted or rejected.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          notes: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Acceptance recorded: ${value.accepted ? 'accepted' : 'rejected'}. ${value.notes}`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new ToolContextUnavailableError('pet_acceptance requires the worker main agent session')
      }
      await ctx.petWorker.recordAcceptance(exec.agent, { accepted: args.accepted, notes: args.notes })
      return { accepted: args.accepted, notes: args.notes }
    },
  }))
}

/** Scope the recorded depth limit and child effort to the root of the scenario. */

export const name = 'snapshot-tree-policy'
export const inject = ['subagents']

/**
 * Keep the policy active for the root's lifetime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario composition.
 */
export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.origin === 'subagent') return
    const lifetime = Promise.withResolvers()
    let installed = false
    const policy = ctx.subagents.withTreePolicy(agent, { maxDepth: 2, maxSubagents: 2, reasoningEffort: 'max' }, () => {
      installed = true
      return lifetime.promise
    })
    if (!installed) await policy
    agent.ctx.effect(() => async () => {
      lifetime.resolve()
      await policy
    })
  })
}

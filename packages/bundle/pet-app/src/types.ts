/**
 * Durable and wire types for the pet worker: one Agent delegation, the
 * subagents it spawned, the normalized transcripts the pet renders, and the
 * capped history entry that survives while a record is evicted.
 *
 * @module @deepseek-ai/dsh-pet-app/types
 */

import type { SubagentTreePolicy } from '@deepseek-ai/dsh-subagent'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** One delegated task normalized from an MCP tool call. */
export interface DelegateInput extends SubagentTreePolicy {
  /** Caller-supplied conversation name, unique per conversation and reused across its calls. */
  readonly agentSession: string
  /** The task the caller delegates. */
  readonly task: string
  /** The calling Agent's independent checks, methods, and expected results. */
  readonly acceptanceCriteria: string
  /** The content the caller expects back. */
  readonly expectedReturn: string
}

/** Advertised model routes and providers whose catalogs could not be read. */
export interface PetModelCatalog {
  /** Model routes accepted by the delegation tool, with labels for choosing a route. */
  readonly models: readonly {
    readonly provider: string
    readonly model: string
    readonly name: string
    /** Exact-model capability. Omitted in bulk listings. Null when the model has no selectable efforts. */
    readonly reasoning?: LlmModelReasoningInfo | null
  }[]
  /** Provider ids to retry individually if their catalogs could not be read. */
  readonly unavailableProviders: readonly string[]
}

/** Terminal or in-flight state of one delegation. */
export type DelegateStatus =
  | 'scheduled'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** State of one child run inside a delegation. */
export type SubagentStatus =
  | 'running'
  | 'completed'
  | 'aborted'
  | 'error'
  | 'max-tokens'
  | 'refusal'
  | 'unknown'

/** One model-visible step of a worker or subagent run, in log order. */
export type TranscriptEntry =
  | {
    readonly kind: 'user'
    readonly at: number
    readonly text: string
  }
  | {
    readonly kind: 'assistant'
    readonly at: number
    readonly text: string
    readonly reasoning: string
    readonly tools: readonly TranscriptToolCall[]
  }
  | {
    readonly kind: 'tool'
    readonly at: number
    readonly callId: string
    readonly name: string | undefined
    readonly text: string
    readonly isError: boolean
  }
  | {
    readonly kind: 'status'
    readonly at: number
    readonly label: string
  }

/** One tool invocation recorded on an assistant message. */
export interface TranscriptToolCall {
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

/** One child run tracked for a delegation. */
export interface SubagentRecord {
  /** Provider run identity shared by the start/end lifecycle pair. */
  readonly runId: string
  /** Child Session id. */
  readonly sessionId: string
  /** Direct creator Session id (the lead subagent or another execution subagent). */
  readonly parentSessionId: string
  /** Model-facing tree name when the subagent manager could resolve one. */
  readonly name: string
  /** Short model-authored label, or the first prompt line when no label is available. */
  label: string
  /** Display glyph assigned by the pet. */
  readonly icon: string
  /** Display color assigned by the pet. */
  readonly color: string
  /** Epoch milliseconds when the child run was announced. */
  readonly startedAt: number
  /** Epoch milliseconds when the child settled. */
  endedAt?: number
  status: SubagentStatus
  /** Terminal stop reason reported by the subagent lifecycle. */
  stopReason?: string
  /** Final assistant text reported by the child lifecycle. */
  output?: string
  /** Normalized child transcript in log order. */
  readonly transcript: TranscriptEntry[]
}

/** One delegation and everything the pet can show for it. */
export interface DelegateRecord extends SubagentTreePolicy {
  /** Pet-local record identity, also used as the record file name. */
  readonly id: string
  /** The calling Agent’s conversation name. */
  readonly agentSession: string
  /** The delegated task. */
  readonly task: string
  /** The acceptance criteria supplied by the caller. */
  readonly acceptanceCriteria: string
  /** The expected return content supplied by the caller. */
  readonly expectedReturn: string
  /** Epoch milliseconds at dispatch. */
  readonly dispatchedAt: number
  /** Requested start time in epoch milliseconds for a scheduled delegation. */
  readonly scheduledAt?: number
  /** Recurring plan that produced this delegation, when applicable. */
  readonly scheduleId?: PetScheduleId
  /** Epoch milliseconds when the record reached a terminal state. */
  completedAt?: number
  /** Delegation state. */
  status: DelegateStatus
  /** Lead subagent Session id, stored under the existing history field name. */
  readonly mainSessionId: string
  /** Absolute directory the worker ran in when the delegation was dispatched. */
  readonly workspace: string
  /** The lead subagent's forwarding record and any Session transcript entries. */
  readonly transcript: TranscriptEntry[]
  /** Child runs in start order. */
  readonly subagents: SubagentRecord[]
  /** Execution subagent output and stop reason. */
  result?: {
    readonly text: string
    readonly stopReason: string
  }
  /** Failure detail for a failed or cancelled delegation. */
  error?: string
}

/** A persisted delegation with a requested start time. */
export type ScheduledDelegateRecord = DelegateRecord & { readonly scheduledAt: number }

/** One-time start condition, validated at the caller boundary. */
export type DelegateScheduleTiming = { readonly runAt: number } | { readonly delaySeconds: number }

/** Fixed-rate timing and optional bounds for a recurring plan. */
export interface RecurringScheduleTiming {
  /** Seconds between planned starts. */
  readonly everySeconds: number
  /** Seconds from admission through the last eligible planned start. */
  readonly durationSeconds?: number
  /** Number of delegations the plan may admit. */
  readonly maxRuns?: number
}

/** Durable identifier for a recurring Pet schedule. */
export type PetScheduleId = Branded<'PetScheduleId'>

/** Management operation for an existing recurring Pet schedule. */
export type PetScheduleAction = 'view' | 'pause' | 'resume' | 'stop'

/** One compact row in the capped history index. */
export interface HistoryEntry {
  /** Pet-local record identity. */
  readonly id: string
  /** Agent conversation name used for grouping. */
  readonly agentSession: string
  /** Epoch milliseconds at dispatch. */
  readonly dispatchedAt: number
  /** Requested start time in epoch milliseconds for a scheduled delegation. */
  readonly scheduledAt?: number
  /** Recurring plan that produced this delegation, when applicable. */
  readonly scheduleId?: PetScheduleId
  /** Epoch milliseconds at settlement. */
  readonly completedAt?: number
  /** Delegation state. */
  readonly status: DelegateStatus
  /** First line of the task, trimmed for the history list. */
  readonly taskPreview: string
  /** Number of child runs. */
  readonly subagentCount: number
}

/** One Agent conversation's slice of the history list. */
export interface HistoryGroup {
  /** Conversation name supplied by the caller. */
  readonly agentSession: string
  /** Number of retained records in this group. */
  readonly count: number
  /** Epoch milliseconds of the newest record. */
  readonly latestAt: number
  /** Records newest first. */
  readonly entries: readonly HistoryEntry[]
}

/** One running delegation reduced to what the pet needs to draw it. */
export interface ActiveDelegateSnapshot {
  readonly id: string
  readonly agentSession: string
  readonly dispatchedAt: number
  readonly status: DelegateStatus
  readonly subagents: readonly ActiveSubagentSnapshot[]
}

/** One running child reduced to what the pet needs to draw its icon. */
export interface ActiveSubagentSnapshot {
  readonly id: string
  readonly runId: string
  readonly delegateId: string
  readonly agentSession: string
  readonly name: string
  readonly label: string
  readonly icon: string
  readonly color: string
  readonly startedAt: number
}

/** Everything the pet polls while it is visible. */
export interface PetSnapshot {
  /** Server epoch milliseconds. */
  readonly generatedAt: number
  /** MCP endpoint for calling Agents, including its access token. */
  readonly mcpUrl: string
  /** Pet page URL, including its access token. */
  readonly pageUrl: string
  /** Configured history cap. */
  readonly historyLimit: number
  /** Retained record count. */
  readonly historyCount: number
  /** Running delegations in dispatch order. */
  readonly active: readonly ActiveDelegateSnapshot[]
}

/** Result the MCP tool returns to the caller. */
export interface DelegateOutcome {
  /** Pet-local record identity. */
  readonly id: string
  /** Terminal delegation state. */
  readonly status: Extract<DelegateStatus, 'completed' | 'failed' | 'cancelled'>
  /** Final text from the direct execution subagent. */
  readonly text: string
  /** Why the execution ended. */
  readonly stopReason: string
  /** Failure detail for a failed or cancelled delegation. */
  readonly error?: string
}

/** One history record and its full detail. */
export type DelegateDetail = DelegateRecord

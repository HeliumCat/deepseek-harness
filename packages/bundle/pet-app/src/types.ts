/**
 * Durable and wire types for the pet worker: one Codex delegation, the
 * subagents it spawned, the normalized transcripts the pet renders, and the
 * capped history entry that survives while a record is evicted.
 *
 * @module @deepseek-ai/dsh-pet-app/types
 */

/** One delegated task exactly as the Codex MCP client sends it. */
export interface DelegateInput {
  /** Stable human-readable name of the calling Codex conversation, never a session id. */
  readonly codexSession: string
  /** The task Codex delegates. */
  readonly task: string
  /** How the worker must judge whether the task succeeded. */
  readonly acceptanceCriteria: string
  /** The content Codex expects back. */
  readonly expectedReturn: string
}

/** Terminal or in-flight state of one delegation. */
export type DelegateStatus =
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

/** A verdict the worker main agent records through `pet_acceptance`. */
export interface AcceptanceVerdict {
  /** Whether the subagent output satisfies the delegate's acceptance criteria. */
  readonly accepted: boolean
  /** The worker's one-paragraph acceptance notes. */
  readonly notes: string
}

/** One acceptance verdict with its recording time. */
export interface StoredAcceptance extends AcceptanceVerdict {
  readonly at: number
}

/** One child run tracked for a delegation. */
export interface SubagentRecord {
  /** Provider run identity shared by the start/end lifecycle pair. */
  readonly runId: string
  /** Child Session id. */
  readonly sessionId: string
  /** Direct creator Session id (the worker session or another child session). */
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
export interface DelegateRecord {
  /** Pet-local record identity, also used as the record file name. */
  readonly id: string
  /** The Codex conversation name supplied by the caller. */
  readonly codexSession: string
  /** The delegated task. */
  readonly task: string
  /** The acceptance criteria supplied by the caller. */
  readonly acceptanceCriteria: string
  /** The expected return content supplied by the caller. */
  readonly expectedReturn: string
  /** Epoch milliseconds at dispatch. */
  readonly dispatchedAt: number
  /** Epoch milliseconds when the record reached a terminal state. */
  completedAt?: number
  /** Delegation state. */
  status: DelegateStatus
  /** Worker main-agent Session id. */
  readonly mainSessionId: string
  /** Absolute directory the worker ran in when the delegation was dispatched. */
  readonly workspace: string
  /** Normalized worker transcript, including the delegate envelope and subagent tool calls. */
  readonly transcript: TranscriptEntry[]
  /** Child runs in start order. */
  readonly subagents: SubagentRecord[]
  /** Worker verdict, or absent when the worker never recorded one. */
  acceptance?: StoredAcceptance
  /** Final returned text and how the worker turn ended. */
  result?: {
    readonly text: string
    readonly stopReason: string
  }
  /** Failure detail for a failed or cancelled delegation. */
  error?: string
}

/** One compact row in the capped history index. */
export interface HistoryEntry {
  /** Pet-local record identity. */
  readonly id: string
  /** Codex conversation name used for grouping. */
  readonly codexSession: string
  /** Epoch milliseconds at dispatch. */
  readonly dispatchedAt: number
  /** Epoch milliseconds at settlement. */
  readonly completedAt?: number
  /** Delegation state. */
  readonly status: DelegateStatus
  /** First line of the task, trimmed for the history list. */
  readonly taskPreview: string
  /** Number of child runs. */
  readonly subagentCount: number
  /** Recorded acceptance, when the worker provided one. */
  readonly accepted?: boolean
}

/** One Codex conversation's slice of the history list. */
export interface HistoryGroup {
  /** Conversation name supplied by the caller. */
  readonly codexSession: string
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
  readonly codexSession: string
  readonly dispatchedAt: number
  readonly status: DelegateStatus
  readonly subagents: readonly ActiveSubagentSnapshot[]
}

/** One running child reduced to what the pet needs to draw its icon. */
export interface ActiveSubagentSnapshot {
  readonly id: string
  readonly runId: string
  readonly delegateId: string
  readonly codexSession: string
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
  /** MCP endpoint Codex should connect to, including its access token. */
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

/** Result the MCP tool returns to Codex. */
export interface DelegateOutcome {
  /** Pet-local record identity. */
  readonly id: string
  /** Terminal delegation state. */
  readonly status: DelegateStatus
  /** Worker verdict, or undefined when the worker did not record one. */
  readonly acceptance: AcceptanceVerdict | undefined
  /** Final returned text. */
  readonly text: string
  /** Why the worker turn ended. */
  readonly stopReason: string
  /** Failure detail for a failed or cancelled delegation. */
  readonly error?: string
}

/** One history record and its full detail. */
export type DelegateDetail = DelegateRecord

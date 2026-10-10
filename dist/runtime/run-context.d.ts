/** Holds one run's mutable state and the shared services that every workflow global uses. */
import type { AgentRegistry } from "../agent-registry.js";
import type { AgentUsage } from "../agent-usage.js";
import { type WorkflowCheckpointSuspensionError, WorkflowError } from "../errors.js";
import type { WorkflowLogger } from "../logger.js";
import type { ModelRoutingConfig } from "../model-routing.js";
import type { SharedStore } from "../shared-store.js";
import type { WorkflowAgentRunner, WorkflowCheckpoint, WorkflowMeta, WorkflowRunOptions } from "../workflow.js";
export interface RuntimeState {
    currentPhase?: string;
    logs: string[];
    phases: string[];
    /** Assigned in lexical call order, so it is the stable resume key of each agent()/checkpoint() call. */
    callSeq: number;
    /**
     * Index of the first call that missed the resume journal (changed or new).
     * A cached result replays only while callIndex < firstMiss: once an upstream
     * call changed, every later call runs live instead of serving stale results.
     */
    firstMiss: number;
    limiter: <T>(fn: () => Promise<T>) => Promise<T>;
    /** Logical agent()/checkpoint() slots reserved so far; capped by maxAgents. */
    agentCount: number;
    tokenUsage: AgentUsage;
    /** Set after the terminal drain, so abandoned agents can no longer report. */
    agentCallbacksClosed: boolean;
    /** Active attempts whose usage must be finalized when an abort drain abandons them. */
    pendingUsageFinalizers: Set<() => void>;
    /** Exact durable checkpoint currently waiting or resuming. */
    activeCheckpointId: string | null;
    /** Persisted response currently being consumed by exactly one checkpoint. */
    activeCheckpointResponse: WorkflowCheckpoint | null;
    /** Every durable checkpoint ID encountered in this run; IDs must be unique. */
    seenCheckpointIds: Set<string>;
    /** A durably accepted suspension cannot be swallowed into a successful run. */
    checkpointSuspension?: WorkflowCheckpointSuspensionError;
    /**
     * Aborted once an error escapes the script uncaught, i.e. the run is lost.
     * Not on the first fan-out rejection: parallel() turns recoverable failures
     * into null and a script may catch agent() errors itself. Every attempt links
     * its AbortController to this signal as well as to options.signal, so
     * in-flight siblings stop instead of finishing a doomed run. A controller is
     * needed because the runtime cannot abort the caller-owned options.signal.
     */
    runFatalController: AbortController;
    /**
     * Every agent() promise of this run, added on call and removed on settle.
     * The run drains it before disposing the SharedStore, so an agent() the
     * script forgot to await cannot touch state after teardown.
     */
    inFlight: Set<Promise<unknown>>;
    /** Named conversations currently executing. */
    activeThreads: Set<string>;
    /** Whether a threaded call has invalidated journal replay for the rest of the run. */
    resumeBarrierReached: boolean;
}
/** Fixed inputs of a run, resolved once by runWorkflow. */
export interface RunSetup {
    readonly options: WorkflowRunOptions;
    readonly runId: string;
    readonly baseCwd: string;
    readonly maxAgents: number;
    readonly agentTimeoutMs: number | null;
    readonly routingConfig: ModelRoutingConfig;
    /** Snapshotted once per run so two agent() calls never observe a mid-run edit. */
    readonly agentRegistry: AgentRegistry;
    readonly agentRunner: WorkflowAgentRunner;
    readonly store: SharedStore;
    readonly logger: WorkflowLogger;
    readonly state: RuntimeState;
}
/** A run's setup plus the helpers shared by agent(), parallel(), pipeline() and checkpoint(). */
export interface RunContext extends RunSetup {
    /** Record a line in the run's logs and the persisted log file. */
    readonly log: (message: string) => void;
    /** True after an external abort (pause/stop/Esc) or once the run is sealed as failed. */
    readonly isAborted: () => boolean;
    /** Throw the pending checkpoint suspension or an abort error, if either applies. */
    readonly throwIfAborted: () => void;
    readonly agentLimitError: () => WorkflowError;
    /** Every logical agent() call and checkpoint consumes one slot of the run's maxAgents cap. */
    readonly ensureAgentCapacity: () => void;
}
export declare function workflowAbortedError(): WorkflowError;
export declare function createRuntimeState(meta: WorkflowMeta, options: WorkflowRunOptions, concurrency: number): RuntimeState;
export declare function createRunContext(setup: RunSetup): RunContext;

/** Implements agent(): validates a call, reserves its slot, then replays it from the journal or runs it live. */

import { agentDefinitionKey, resolveAgentType } from "../agent-registry.js";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import { resolveModelForPhase } from "../model-routing.js";
import { validateThinkingLevel } from "../model-spec.js";
import type { AgentOptions, JournalEntry } from "../workflow.js";
import { type AgentCall, isEmptyTextAgentResult, runLiveAgent } from "./agent-execution.js";
import { normalizeThread, resolveAgentCwd, validateAgentOptions } from "./agent-options.js";
import { agentCallId, hashAgentCall } from "./call-identity.js";
import { currentFanoutBatch } from "./fanout.js";
import type { RunContext } from "./run-context.js";

/** Build the script's agent() global for this run. */
export function createAgent(ctx: RunContext) {
  const { state } = ctx;

  /** Validate synchronously (a failure throws), enforce thread exclusivity, then start the call. */
  const startAgentCall = (prompt: string, agentOptions: unknown): Promise<unknown> => {
    validateAgentOptions(agentOptions);
    const thread = normalizeThread(agentOptions.thread);
    if (thread === undefined) return runAgentCall(prompt, agentOptions);
    if (state.activeThreads.has(thread)) {
      throw new WorkflowError(
        `agent thread "${thread}" is already running; same-thread calls must be sequential`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    state.activeThreads.add(thread);
    return runAgentCall(prompt, thread === agentOptions.thread ? agentOptions : { ...agentOptions, thread }).finally(
      () => state.activeThreads.delete(thread),
    );
  };

  const runAgentCall = async (prompt: string, agentOptions: AgentOptions): Promise<unknown> => {
    ctx.throwIfAborted();
    validateThinkingLevel(agentOptions.thinking);

    // Invalid local configuration must fail before a slot is reserved, so it
    // cannot change the run's capacity or scheduling state.
    const definition = resolveAgentType(agentOptions.agentType, ctx.agentRegistry);
    // isolation: false opts out; otherwise the call's isolation beats the definition's.
    const isolation = agentOptions.isolation === false ? undefined : (agentOptions.isolation ?? definition?.isolation);
    const cwd = resolveAgentCwd(agentOptions.cwd);
    if (cwd && isolation === "worktree") {
      throw new WorkflowError(
        "agent cwd cannot be combined with worktree isolation",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }

    // Read before the first await, while the caller's fan-out context is still active.
    const batch = currentFanoutBatch();
    // A fan-out that overshoots the cap throws here; parallel()/pipeline() then
    // cancel their batch so its already-queued agents bail before dispatch.
    ctx.ensureAgentCapacity();

    const phase = agentOptions.phase ?? state.currentPhase;
    const requestedLabel = agentOptions.label?.trim();
    if (agentOptions.thread && isolation === "worktree") {
      throw new WorkflowError(
        `agent thread "${agentOptions.thread}" cannot use worktree isolation`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    if (agentOptions.agentType && !definition) {
      ctx.log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
    }

    // Precedence: explicit model > agentType model > tier > phase model. With
    // only a tier set, modelSpec stays undefined so the agent layer resolves the tier.
    const explicitModel = agentOptions.model ?? definition?.model;
    const modelSpec = explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(phase, ctx.routingConfig));

    // The resume key is assigned at lexical call time, before the limiter, so a
    // fixed script's fan-out numbers its calls the same way on every run.
    const index = state.callSeq++;
    const hash = hashAgentCall({
      prompt,
      model: modelSpec,
      phase,
      options: agentOptions,
      agentDefinitionKey: agentDefinitionKey(definition),
      cwd,
      isolation,
    });
    const id = agentCallId(ctx.runId, index);

    // Reserved with no await since the capacity check, so a parallel() fan-out
    // cannot all observe the same agentCount and overshoot maxAgents. Replayed
    // calls count too, which keeps maxAgents cumulative across resume.
    state.agentCount++;
    const label = requestedLabel || defaultAgentLabel(phase, state.agentCount);
    const call: AgentCall = {
      prompt,
      options: agentOptions,
      definition,
      isolation,
      cwd,
      phase,
      label,
      modelSpec,
      index,
      hash,
      id,
      batch,
      displayModel: modelSpec ?? ctx.options.mainModel,
    };

    // Longest-unchanged-prefix resume: replay only while no earlier call has
    // missed, so an edited upstream call never leaves stale downstream results.
    // Independent calls have no downstream, so each replays on its own match.
    // A thread's conversation cannot be replayed, so it ends replay for the run.
    if (agentOptions.thread) state.resumeBarrierReached = true;
    const cached = agentOptions.thread ? undefined : ctx.options.resumeJournal?.get(index);
    const hashMatches = cached != null && cached.hash === hash;
    const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
    const withinReplay = ctx.options.independentCalls || index < state.firstMiss;
    if (!state.resumeBarrierReached && hashMatches && !cachedEmptyOutput && withinReplay) {
      return replayFromJournal(ctx, call, cached);
    }
    // A genuine miss marks where the unchanged prefix ends.
    if (!hashMatches || cachedEmptyOutput) {
      state.firstMiss = Math.min(state.firstMiss, index);
    }
    return runLiveAgent(ctx, call);
  };

  // runWorkflow exposes this through trackScriptCalls, which also turns a synchronous validation throw into a rejection.
  return (prompt: string, agentOptions: unknown = {}): Promise<unknown> => startAgentCall(prompt, agentOptions);
}

/** Report a journaled call as if it ran, keeping its recorded model and store writes. */
function replayFromJournal(ctx: RunContext, call: AgentCall, entry: JournalEntry): unknown {
  const { options } = ctx;
  const { result, storeDelta } = entry;
  const model = entry.model ?? call.displayModel;
  options.onAgentStart?.({
    id: call.id,
    label: call.label,
    phase: call.phase,
    prompt: call.prompt,
    model,
    replayed: true,
  });
  options.onAgentEnd?.({ id: call.id, label: call.label, phase: call.phase, result, tokens: 0, model });
  // Deltas apply additively, so writes of a later call that finished first survive.
  if (storeDelta) ctx.store.applyDelta(storeDelta);
  return result;
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

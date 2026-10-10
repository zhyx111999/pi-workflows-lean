/**
 * Runs one workflow script: the entry point of the workflow runtime.
 *
 * runWorkflow() parses the script's literal `meta`, prepares the run (limits,
 * agent registry, logger, shared store), exposes the workflow globals in a vm
 * context, runs the script, and finally drains every outstanding agent() call.
 * The parts live in src/runtime/:
 *   - script-meta.ts, determinism.ts        parse-time checks and the in-realm guard
 *   - run-limits.ts                         host settings turned into enforced limits
 *   - run-context.ts                        per-run state and the helpers shared by the globals
 *   - agent-call.ts                         agent(): validation, slot, journal replay
 *   - agent-execution.ts, agent-attempt.ts  live runs: worktree, retries, timeout, usage
 *   - fanout.ts, checkpoint.ts              parallel()/pipeline() and checkpoint()
 *   - script-vm.ts                          the vm context and script execution
 *   - run-teardown.ts                       fatal seal, drain, final accounting
 */
import { WorkflowAgent } from "./agent.js";
import { loadAgentRegistry } from "./agent-registry.js";
import { DEFAULT_MAX_AGENTS } from "./config.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta } from "./model-routing.js";
import { createAgent } from "./runtime/agent-call.js";
import { createCheckpoint } from "./runtime/checkpoint.js";
import { assertDeterministicSource } from "./runtime/determinism.js";
import { createParallel, createPipeline } from "./runtime/fanout.js";
import { createRunContext, createRuntimeState } from "./runtime/run-context.js";
import { resolveAgentTimeoutMs, resolveConcurrency } from "./runtime/run-limits.js";
import { finishRun, sealRunFatal } from "./runtime/run-teardown.js";
import { readMetaExport } from "./runtime/script-meta.js";
import { createScriptContext, runScript } from "./runtime/script-vm.js";
import { SharedStore } from "./shared-store.js";
export async function runWorkflow(script, options = {}) {
    const started = Date.now();
    const { meta, body } = parseWorkflowScript(script);
    // 1. Prepare the run.
    // Per-phase models from meta.phases[].model, with meta.model as the default.
    const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
    const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
    const agentTimeoutMs = resolveAgentTimeoutMs(options);
    const runId = options.runId ?? `run-${started.toString(36)}`;
    const baseCwd = options.cwd ?? process.cwd();
    // Read once per run so agent() calls never see a mid-run edit; a resume reads it again.
    const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);
    const logger = createWorkflowLogger({
        runId,
        cwd: baseCwd,
        persist: options.persistLogs ?? true,
        onLog: options.onLog,
    });
    const ctx = createRunContext({
        options,
        runId,
        baseCwd,
        maxAgents,
        agentTimeoutMs,
        routingConfig,
        agentRegistry,
        logger,
        state: createRuntimeState(meta, options, resolveConcurrency(options.concurrency)),
        agentRunner: options.agent ?? new WorkflowAgent(options),
        store: new SharedStore(),
    });
    const { state, log } = ctx;
    // 2. Expose the workflow globals declared by the capability contract.
    const phase = (title) => {
        state.currentPhase = title;
        if (!state.phases.includes(title))
            state.phases.push(title);
        options.onPhase?.(title);
    };
    const context = createScriptContext({
        agent: createAgent(ctx),
        parallel: createParallel(ctx),
        pipeline: createPipeline(ctx),
        checkpoint: createCheckpoint(ctx),
        log,
        phase,
        args: options.args,
        cwd: baseCwd,
        process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
        console: {
            log,
            info: log,
            warn: (m) => log(`[warn] ${String(m)}`),
            error: (m) => log(`[error] ${String(m)}`),
        },
    }, logger);
    // 3. Run the script, then always drain its outstanding agent() calls.
    let successResult;
    try {
        const result = await runScript(context, body, `${meta.name || "workflow"}.js`);
        // A script that caught its checkpoint suspension still pauses instead of
        // completing; an external abort keeps priority over the suspension.
        if (state.checkpointSuspension)
            ctx.throwIfAborted();
        const logFile = logger.persist();
        if (logFile)
            log(`Logs persisted to ${logFile}`);
        successResult = {
            meta,
            result: result,
            logs: state.logs,
            phases: state.phases,
            agentCount: state.agentCount,
            durationMs: Date.now() - started,
            runId,
            tokenUsage: state.tokenUsage,
        };
        return successResult;
    }
    catch (error) {
        // A checkpoint suspension is an intentional pause, not a failure: in-flight
        // siblings are waited out so their paid results journal instead of being
        // aborted and paid for again on resume.
        const isCheckpointSuspension = state.checkpointSuspension !== undefined && error === state.checkpointSuspension;
        if (!isCheckpointSuspension)
            sealRunFatal(ctx, error);
        throw error;
    }
    finally {
        await finishRun(ctx, successResult);
    }
}
/** Split a script into its validated literal `meta` and the body that runs in the vm. */
export function parseWorkflowScript(script) {
    assertDeterministicSource(script);
    const { meta, start, end } = readMetaExport(script);
    return { meta, body: script.slice(0, start) + script.slice(end) };
}

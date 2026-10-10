import { createAgentSession, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { pinChildCacheRetention } from "../child-cache-retention.js";
import { runtimeOf } from "./model-registry.js";
export async function openChildSession(spec) {
    const { injected, modelRegistry } = spec;
    // pi 0.80.8+ takes the registry's backing runtime so subagents share the host
    // catalog and auth; omp's registry has no runtime and is passed itself. Never
    // spread `modelRuntime: undefined`: it would shadow the SDK's default runtime.
    const modelRuntime = runtimeOf(modelRegistry);
    const { session } = await createAgentSession({
        cwd: spec.cwd,
        agentDir: spec.agentDir,
        sessionManager: spec.sessionManager,
        // A real SettingsManager inherits the user's default provider/model.
        // SettingsManager.inMemory() skips ~/.pi settings, so subagents would fall
        // back to the first available model, which may lack auth and answer empty.
        settingsManager: SettingsManager.create(spec.cwd, spec.agentDir),
        customTools: spec.customTools,
        // An injected resourceLoader wins and skips the shared build entirely.
        resourceLoader: injected.resourceLoader ?? (await spec.sharedResourceLoader()),
        // `modelRegistry` is omp-only; the spread keeps it out of the upstream option type check.
        ...(modelRuntime ? { modelRuntime } : { modelRegistry }),
        ...injected,
        ...(spec.cwdIsExplicit ? { cwd: spec.cwd } : {}),
        // The computed id must win: an embedder's stable agentId would collide
        // across runs in the process-global registry. `agentId` is omp-only, hence the spread.
        ...{ agentId: spec.agentId },
        // The injected spread above would otherwise replace a thread's retained
        // manager, breaking turn continuity and failed-turn rollback.
        ...(spec.keepSessionManager ? { sessionManager: spec.sessionManager } : {}),
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
        // Last, so the recursive-orchestration denylist always applies.
        excludeTools: spec.excludeTools,
    });
    pinChildCacheRetention(session.agent);
    const dispose = async () => {
        try {
            // dispose() alone does not emit shutdown; give opted-in extension
            // factories a chance to release session-local listeners and resources.
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
        catch {
            // Cleanup must not replace the original result or failure.
        }
        finally {
            session.dispose();
        }
    };
    // Child sessions do not auto-bind a supplied ResourceLoader. Bind middleware
    // before the first provider request (also supports injected resource loaders).
    try {
        await session.bindExtensions({});
    }
    catch (error) {
        await dispose();
        throw error;
    }
    return { session, dispose };
}

/** Builds the vm context that exposes exactly the declared workflow globals and runs a script body in it. */
import vm from "node:vm";
import { WORKFLOW_CAPABILITY_CONTRACT } from "../workflow-capability-contract.js";
import { DETERMINISM_PRELUDE } from "./determinism.js";
/** Bind the runtime implementations to the global names the capability contract declares. */
export function createScriptContext(implementations, logger) {
    const { globals, diagnostics } = WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings(implementations);
    for (const diagnostic of diagnostics)
        logger.warn(diagnostic.message);
    // Built-ins (Object, Array, JSON, Math, Date, Promise...) come from the vm
    // realm itself: a host built-in's .constructor would be the host Function,
    // which would bypass the determinism prelude.
    return vm.createContext({ ...globals });
}
/**
 * Compile and start the script body as an async function. A syntax error throws
 * synchronously; the returned promise settles with the script's return value.
 */
export function runScript(context, body, filename) {
    const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
    return new vm.Script(wrapped, { filename }).runInContext(context);
}

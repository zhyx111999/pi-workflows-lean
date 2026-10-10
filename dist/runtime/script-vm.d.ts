/** Builds the vm context that exposes exactly the declared workflow globals and runs a script body in it. */
import vm from "node:vm";
import type { WorkflowLogger } from "../logger.js";
/** Bind the runtime implementations to the global names the capability contract declares. */
export declare function createScriptContext(implementations: Readonly<Record<string, unknown>>, logger: WorkflowLogger): vm.Context;
/**
 * Compile and start the script body as an async function. A syntax error throws
 * synchronously; the returned promise settles with the script's return value.
 */
export declare function runScript(context: vm.Context, body: string, filename: string): Promise<unknown>;

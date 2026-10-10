/** Reads and validates the literal `export const meta = {...}` statement that opens every workflow script. */
import type { WorkflowMeta } from "../workflow.js";
/** The validated meta object and the source range of the statement that declares it. */
export interface MetaExport {
    meta: WorkflowMeta;
    start: number;
    end: number;
}
/**
 * Locate the meta export and evaluate it without running the script: only
 * literals are accepted, so reading meta can never execute author code.
 */
export declare function readMetaExport(script: string): MetaExport;

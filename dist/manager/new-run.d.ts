import type { ManagedRun } from "../workflow-manager.js";
export interface NewRunOwner {
    /** Whether the result is delivered back into the conversation (see ManagedRun.background). */
    background: boolean;
    /** The session that started the run; it owns delivery and becomes the parent lineage. */
    sessionId?: string;
    sessionFile?: string;
    autoResume?: boolean;
    toolset?: string;
}
/** A fresh running run for `script`, without a lease yet. Throws when the script does not parse. */
export declare function newManagedRun(script: string, args: unknown, owner: NewRunOwner): ManagedRun;

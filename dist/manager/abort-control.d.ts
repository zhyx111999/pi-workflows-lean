/** A user pause()/stop() that aborted one execution; `abortReason` is the AbortSignal.reason it set. */
export interface LifecycleControl {
    action: "pause" | "stop";
    abortReason: object;
}
/** A host/tool signal that aborted one execution; `abortReason` is the AbortSignal.reason it set. */
export interface ExternalAbort {
    abortReason: object;
}
/** The parts of a managed run that record abort ownership. */
interface AbortableRun {
    controller: AbortController;
    lifecycleControl?: LifecycleControl;
    externalAbort?: ExternalAbort;
}
/**
 * Abort for an explicit user lifecycle action. The fresh reason object is an
 * execution-scoped identity token. An already-aborted controller keeps its
 * original reason, so the earlier cause stays observable when the execution settles.
 */
export declare function abortForLifecycleControl(run: AbortableRun, action: LifecycleControl["action"]): void;
/**
 * Ties one execution to a host AbortSignal (e.g. Esc during a blocking tool
 * call). The listener belongs to that execution alone: detach() removes it, so
 * a reused host signal neither retains a settled run nor aborts it later.
 */
export declare class ExternalAbortLink {
    private readonly signal;
    private readonly onAbort;
    constructor(signal: AbortSignal, run: AbortableRun);
    attach(): void;
    /** Safe on every path: removing a listener that already fired or was never added is a no-op. */
    detach(): void;
}
export {};

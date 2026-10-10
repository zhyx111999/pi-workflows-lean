/** Keeps workflow scripts replayable by rejecting and disabling nondeterministic builtins. */
/** Reject a script that visibly calls Date.now(), Math.random() or new Date(). */
export declare function assertDeterministicSource(script: string): void;
/**
 * Runs inside the vm realm before the script body. Resume replays a script and
 * matches calls against the journal, so values that differ between runs would
 * break replay:
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * It uses the realm's own Math/Date/Reflect, so it hands the script no host
 * `Function`. vm is not a security sandbox (an injected bridge function's
 * `.constructor` is still the host Function), so this guards against accidental
 * nondeterminism in trusted scripts, not against a deliberate bypass.
 */
export declare const DETERMINISM_PRELUDE: string;

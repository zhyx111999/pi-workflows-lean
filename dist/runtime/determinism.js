/** Keeps workflow scripts replayable by rejecting and disabling nondeterministic builtins. */
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
/** Parse-time hint for authors; DETERMINISM_PRELUDE is the actual enforcement. */
const NONDETERMINISTIC_CALLS = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;
/** Reject a script that visibly calls Date.now(), Math.random() or new Date(). */
export function assertDeterministicSource(script) {
    if (NONDETERMINISTIC_CALLS.test(script)) {
        throw new WorkflowError("Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
    }
}
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
export const DETERMINISM_PRELUDE = [
    '"use strict";',
    'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
    "{",
    "  const RealDate = Date;",
    '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
    "  const SafeDate = function (...a) {",
    '    if (!new.target) fail("Date()");',
    '    if (a.length === 0) fail("new Date()");',
    "    return Reflect.construct(RealDate, a, SafeDate);",
    "  };",
    "  SafeDate.UTC = RealDate.UTC;",
    "  SafeDate.parse = RealDate.parse;",
    '  SafeDate.now = () => fail("Date.now()");',
    "  SafeDate.prototype = RealDate.prototype;",
    "  globalThis.Date = SafeDate;",
    "}",
].join("\n");

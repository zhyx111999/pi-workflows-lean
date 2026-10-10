/** @internal Test hook: shorten the settle wait so tests need not take 10s. */
export declare function _setPausedExecutionSettleTimeoutForTests(ms: number | undefined): void;
/** Wait for `execution` to settle; false when it is still running after the timeout. */
export declare function waitForPausedExecutionSettlement(execution: Promise<unknown>): Promise<boolean>;

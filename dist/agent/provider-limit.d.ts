/**
 * The last assistant message's terminal metadata. The pi SDK does not throw
 * provider usage/quota limits: it records them as an assistant message with
 * stopReason "error" and an errorMessage, so this is the only place they show.
 */
export declare function lastAssistantError(messages: unknown[]): {
    stopReason?: string;
    errorMessage?: string;
} | undefined;
/**
 * Throw PROVIDER_USAGE_LIMIT with the provider's message and reset hint when the
 * turn ended in a usage/quota/rate-limit error. Gated on stopReason "error" so a
 * successful answer that merely mentions "rate limit" is never misclassified.
 * Not recoverable: the run pauses for a later resume instead of retrying into the
 * same limit or collapsing to a silent null.
 */
export declare function throwIfProviderLimit(messages: unknown[], label?: string): void;

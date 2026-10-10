/**
 * Anthropic prices a cache write by the TTL it is asked for: 1.25x base input
 * for the 5m window, 2x for the 1h one. Workflow agents are short-lived and
 * rarely idle, so a 1h window they never claim is a flat surcharge on every
 * write. Setting this to `short` keeps that surcharge off agent sessions while
 * the parent keeps `long`, the same split Claude Code makes between its main
 * conversation and its workflows.
 *
 * Unset means agent sessions inherit the parent's retention, which is the
 * behaviour before this setting existed.
 */
export declare function childCacheRetention(env?: NodeJS.ProcessEnv): string | undefined;
/**
 * Pi resolves retention per request as `options.env?.[name] || process.env[name]`,
 * so a per-call env beats the process-wide one. Wrapping this session's own
 * stream function keeps the override scoped to one agent, with no shared-state
 * race against the parent session streaming concurrently in the same process.
 */
export declare function pinChildCacheRetention(agent: {
    streamFunction: unknown;
} | undefined, env?: NodeJS.ProcessEnv): void;

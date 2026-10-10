import { type CreateAgentSessionOptions, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
/**
 * Without a resourceLoader, createAgentSession() builds a fresh loader per
 * subagent and re-runs every installed extension factory, which is the memory
 * churn this cache avoids.
 *
 * Host extensions stay disabled by default. When provider middleware is opted
 * in, configured paths are resolved without loading factories and only the
 * allowlisted ones are added to a `noExtensions: true` loader, so recursive
 * orchestration factories never load. Skills, prompts, AGENTS.md context, and
 * workflow-supplied `customTools` stay available. Allowlisted middleware must be
 * trusted and child-safe; this is not a sandbox.
 *
 * Extension-free loaders are shared per directory. Middleware loaders are built
 * per session: the SDK binds session actions into their runtime, so sharing one
 * would send a child's extension actions into another child.
 */
export declare class SharedResourceLoaders {
    private readonly loaders;
    private readonly middleware;
    /** Read when a loader is built, so an injected settingsManager is honored. */
    private readonly sessionOptions;
    constructor(middleware: readonly string[], sessionOptions: Partial<CreateAgentSessionOptions>);
    /** Number of memoized loaders. */
    get size(): number;
    get(agentDir: string, cwd: string): Promise<DefaultResourceLoader>;
    private get shared();
    private build;
    private prune;
}

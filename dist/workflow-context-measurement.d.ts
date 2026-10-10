/** Package-relative generated context-measurement artifact. */
export declare const WORKFLOW_CONTEXT_MEASUREMENT_PATH = "docs/workflow-context-surfaces.json";
/** Canonical task profiles used for stable byte-based on-demand context measurements. */
export declare const WORKFLOW_AUTHORING_PROFILES: readonly [{
    readonly name: "write";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/pattern-selection.md", "skills/workflow-authoring/references/focused-recipes.md", "skills/workflow-authoring/examples/fan-out-and-synthesize.js", "skills/workflow-authoring/examples/structured-output.js"];
}, {
    readonly name: "edit";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/lifecycle.md", "skills/workflow-authoring/references/focused-recipes.md", "skills/workflow-authoring/examples/structured-output.js", "skills/workflow-authoring/examples/bounded-semantic-retry.js"];
}, {
    readonly name: "review";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/review.md", "skills/workflow-authoring/references/lifecycle.md", "skills/workflow-authoring/examples/classify-and-act.js"];
}, {
    readonly name: "debug";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/debugging.md", "skills/workflow-authoring/references/checkpoint.md", "skills/workflow-authoring/examples/defensive-json-parsing.js"];
}, {
    readonly name: "loop";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/pattern-selection.md", "skills/workflow-authoring/references/lifecycle.md", "skills/workflow-authoring/references/focused-recipes.md", "skills/workflow-authoring/examples/loop-until-done.js", "skills/workflow-authoring/examples/structured-output.js"];
}, {
    readonly name: "retry";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/lifecycle.md", "skills/workflow-authoring/references/focused-recipes.md", "skills/workflow-authoring/examples/bounded-semantic-retry.js", "skills/workflow-authoring/examples/structured-output.js"];
}];
interface ByteSurface {
    serialization: string;
    bytes: number;
}
/** One registered skill's always-on discovery-entry byte cost. */
export interface SkillDiscoverySurface extends ByteSurface {
    root: string;
}
/** One registered tool's provider-visible definition bytes. */
export interface ToolDefinitionSurface {
    name: string;
    bytes: number;
}
declare const SOURCES: readonly ["src/subagents-tool.ts", "src/subagents-control-tool.ts", "skills/workflow-authoring", "package.json#pi.skills"];
/** Versioned byte measurements for always-on, discovery, corpus, and representative authoring surfaces. */
export interface WorkflowContextMeasurement {
    formatVersion: 4;
    encoding: "utf8";
    sources: typeof SOURCES;
    surfaces: {
        /** promptSnippet and promptGuidelines lines Pi adds to the system prompt for the tools. */
        permanentToolPrompt: ByteSurface;
        /** Every tool's name, description, and parameters as sent to the provider. */
        providerVisibleToolDefinitions: ByteSurface & {
            tools: ToolDefinitionSurface[];
        };
        /**
         * Every skill this package registers (package.json's `pi.skills` — read
         * from disk, not hardcoded here) contributes an always-on discovery entry
         * (name + description) the model sees regardless of whether the skill is
         * ever loaded. This sums all of them, not just workflow-authoring, so a
         * new skill's always-on cost can't silently go untracked.
         */
        registeredSkillsDiscovery: ByteSurface & {
            skills: SkillDiscoverySurface[];
        };
        ordinaryWorkflowOwnedAlwaysOn: ByteSurface;
        workflowAuthoringSkillCorpus: ByteSurface & {
            files: number;
        };
        representativeAuthoringProfiles: {
            serialization: "sum of UTF-8 bytes for each profile's declared package-relative files";
            medianBytes: number;
            profiles: Array<{
                name: string;
                files: string[];
                bytes: number;
            }>;
        };
    };
}
interface MeasuredTool {
    name: string;
    description: string;
    parameters: unknown;
    promptSnippet?: string;
    promptGuidelines?: string[];
}
/** The registered tools, built without a host because measuring never executes them. */
export declare function measuredTools(): MeasuredTool[];
/** The lines Pi renders for the tools: one Available-tools entry per snippet, then every guideline. */
export declare function permanentToolPromptLines(tools: readonly MeasuredTool[]): string[];
/** Measures permanent, discovery, corpus, and canonical on-demand workflow context surfaces. */
export declare function measureWorkflowContextSurfaces(root?: string): WorkflowContextMeasurement;
/** Render the current measurement as deterministic formatted JSON. */
export declare function renderWorkflowContextMeasurement(): string;
/** Write the generated measurement under root and return the measured values. */
export declare function writeWorkflowContextMeasurement(root: string): WorkflowContextMeasurement;
/** Report whether committed or supplied measurement JSON matches current package bytes. */
export declare function checkWorkflowContextMeasurement(root: string, actual?: string): boolean;
export {};

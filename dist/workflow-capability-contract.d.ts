import { CapabilityClassification, CapabilityOrigin, CapabilitySupport, DiagnosticSeverity } from "./enums.js";
/** Re-exported so contract consumers need only this module. */
export { CapabilityClassification, CapabilityOrigin, CapabilitySupport, DiagnosticSeverity } from "./enums.js";
/** Version marker: the contract was confirmed against this release, not that it was introduced there. */
export interface PresentAtVersion {
    kind: "present-at";
    version: string;
}
/** One named option and the facts safe to publish about it. */
export interface OptionDescriptor {
    name: string;
    type: string;
    optional: boolean;
    default: string | null;
    constraints: readonly string[];
    dynamicReference: "model-routes" | "agent-types" | null;
}
/** Reusable option group referenced by capability descriptors. */
export interface OptionShape {
    id: "agent-options" | "checkpoint-options" | "phase-options" | "loop-until-dry-options" | "retry-options" | "gate-options";
    options: readonly OptionDescriptor[];
}
/** Authoritative declaration of one workflow capability. */
export interface CapabilityDescriptor {
    id: `workflow.${string}`;
    label: string;
    classification: CapabilityClassification;
    support: CapabilitySupport;
    origin: CapabilityOrigin;
    signature: string | null;
    optionShape: OptionShape["id"] | null;
    constraints: readonly string[];
    /** Present only for globals injected into the workflow VM; drives runtime assembly. */
    runtimeBinding: {
        global: string;
        implementation: string;
        allowsUndefined?: true;
    } | null;
    /** Anchor of this capability's section in the generated capability details. */
    detailsAnchor: string;
    dynamicReference: "model-routes" | "agent-types" | null;
}
/** Ownership and item shape for a live catalogue that static docs must not embed. */
export interface DynamicReferenceDescriptor {
    id: "model-routes" | "agent-types";
    owner: "model-tier-config" | "agent-registry";
    itemShape: string;
    connection: string;
    items?: never;
}
/** Versioned plain-data source for runtime assembly and generated documentation. */
export interface WorkflowCapabilityDefinition {
    versions: {
        /** Shape of this definition; bump when descriptor fields change. */
        format: PresentAtVersion;
        /** Release whose runtime these facts describe; always the package version. */
        content: PresentAtVersion;
    };
    optionShapes: readonly OptionShape[];
    capabilities: readonly CapabilityDescriptor[];
    dynamicReferences: readonly DynamicReferenceDescriptor[];
}
/** Machine-readable disagreement between the contract and an observed surface. */
export interface CapabilityDiagnostic {
    code: "MISSING_RUNTIME_IMPLEMENTATION" | "UNDECLARED_RUNTIME_IMPLEMENTATION" | "DECLARED_GLOBAL_UNOBSERVED" | "OBSERVED_GLOBAL_UNDECLARED" | "INVALID_CAPABILITY_DEFINITION";
    severity: DiagnosticSeverity;
    subject: string;
    message: string;
}
export { WorkflowCapabilityContractError } from "./errors.js";
/** Runtime globals assembled from declared implementations plus non-fatal diagnostics. */
export interface RuntimeBindingAssembly {
    globals: Readonly<Record<string, unknown>>;
    diagnostics: readonly CapabilityDiagnostic[];
}
/** Project-owned implementations required to assemble the workflow VM context. */
export interface WorkflowRuntimeImplementations {
    agent: unknown;
    parallel: unknown;
    pipeline: unknown;
    workflow: unknown;
    loopUntilDry: unknown;
    retry: unknown;
    gate: unknown;
    checkpoint: unknown;
    log: unknown;
    phase: unknown;
    args: unknown;
    cwd: unknown;
    process: unknown;
    budget: unknown;
    console: unknown;
}
/** Exact static projection of one capability for generated references. */
export interface StaticCapabilityFact {
    id: string;
    label: string;
    classification: CapabilityClassification;
    support: CapabilitySupport;
    signature: string | null;
    options: OptionShape | null;
    constraints: readonly string[];
    /** Package-relative link to the generated details section. */
    reference: string;
    dynamicReference: DynamicReferenceDescriptor | null;
}
/** Runtime implementations or observed globals used for drift diagnostics. */
export interface AlignmentEvidence {
    suppliedImplementations?: Readonly<Record<string, unknown>>;
    observedProjectGlobals?: readonly string[];
}
/** Validated capability contract with runtime-assembly, documentation, and alignment projections. */
export interface WorkflowCapabilityContract {
    readonly definition: WorkflowCapabilityDefinition;
    assembleRuntimeBindings(implementations: Readonly<Record<string, unknown>>): RuntimeBindingAssembly;
    projectStaticReferenceFacts(): readonly StaticCapabilityFact[];
    diagnoseAlignment(evidence: AlignmentEvidence): readonly CapabilityDiagnostic[];
}
/** Authoritative versioned inventory used by runtime assembly and every static projection. */
export declare const WORKFLOW_CAPABILITY_DEFINITION: WorkflowCapabilityDefinition;
/** Validate and freeze a definition, throwing with diagnostics when its identities or references conflict. */
export declare function defineWorkflowCapabilityContract(definition: WorkflowCapabilityDefinition): WorkflowCapabilityContract;
/** Installed validated workflow capability contract. */
export declare const WORKFLOW_CAPABILITY_CONTRACT: WorkflowCapabilityContract;

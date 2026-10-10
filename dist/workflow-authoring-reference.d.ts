/** Package-relative compact capability index generated from the contract. */
export declare const CAPABILITY_INDEX_PATH = "skills/workflow-authoring/references/capabilities.md";
/** Package-relative exhaustive generated capability reference. */
export declare const CAPABILITY_DETAIL_PATH = "skills/workflow-authoring/references/capability-details.md";
/** Documents that embed the byte-identical supported-capability table. */
export declare const CAPABILITY_TABLE_PUBLICATION_PATHS: readonly ["skills/workflow-authoring/references/capabilities.md", "README.md", "docs/workflow-authoring.md"];
/** All generated capability publication surfaces checked for drift. */
declare const CAPABILITY_PUBLICATION_PATHS: readonly ["skills/workflow-authoring/references/capabilities.md", "README.md", "docs/workflow-authoring.md", "skills/workflow-authoring/references/capability-details.md"];
/** The byte-identical generated block embedded in every public documentation surface. */
export declare function renderSupportedCapabilityTable(): string;
/** Regenerates only contract-owned content, preserving hand-written prose around marked blocks. */
export declare function writeWorkflowCapabilityPublications(root: string): void;
/** Returns every stale surface in stable publication order. Overrides let tests check edited content without writing files. */
export declare function checkWorkflowCapabilityPublications(root: string, overrides?: Readonly<Partial<Record<(typeof CAPABILITY_PUBLICATION_PATHS)[number], string>>>): string[];
/** Render the compact index that routes exact lookups to the exhaustive details. */
export declare function renderWorkflowCapabilityReference(): string;
/** Render every contract fact under a stable anchor, leaving live catalogues as dynamic references. */
export declare function renderWorkflowCapabilityDetails(): string;
export {};

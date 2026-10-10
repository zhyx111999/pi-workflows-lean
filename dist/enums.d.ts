/** Classifies a workflow capability by its runtime and documentation role. */
export declare enum CapabilityClassification {
    RUNTIME_GLOBAL = "runtime-global",
    SUBAGENTS_TOOL_INPUT = "subagents-tool-input",
    SCRIPT_CONTRACT = "script-contract",
    COMPATIBILITY_BEHAVIOR = "compatibility-behavior",
    INTERNAL_SUBSTRATE = "internal-substrate",
    DYNAMIC_REFERENCE = "dynamic-reference"
}
/** Declares whether workflow authors should use a capability. */
export declare enum CapabilitySupport {
    SUPPORTED = "supported",
    COMPATIBILITY = "compatibility",
    INTERNAL = "internal"
}
/** Names the subsystem that owns a capability's behavior. */
export declare enum CapabilityOrigin {
    PROJECT = "project",
    TOOL_ADAPTER = "tool-adapter",
    VM_REALM = "vm-realm",
    LIVE_CONFIGURATION = "live-configuration"
}
/** Severity carried by capability-alignment diagnostics. */
export declare enum DiagnosticSeverity {
    ERROR = "error",
    WARNING = "warning"
}

import { resolve } from "node:path";
import {
  checkWorkflowContextMeasurement,
  measureWorkflowContextSurfaces,
  WORKFLOW_CONTEXT_MEASUREMENT_PATH,
  writeWorkflowContextMeasurement,
} from "../src/workflow-context-measurement.js";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
// Measured once: the printed numbers are exactly the ones written or checked.
const measurement = measureWorkflowContextSurfaces(root);
const {
  permanentToolPrompt,
  providerVisibleToolDefinitions,
  registeredSkillsDiscovery,
  workflowAuthoringSkillCorpus,
  representativeAuthoringProfiles,
} = measurement.surfaces;

console.log(`Permanent tool prompt: ${permanentToolPrompt.bytes} bytes`);
console.log(`Provider-visible tool definitions: ${providerVisibleToolDefinitions.bytes} bytes`);
for (const tool of providerVisibleToolDefinitions.tools) {
  console.log(`  - ${tool.name}: ${tool.bytes} bytes`);
}
console.log(
  `Registered skills discovery (all ${registeredSkillsDiscovery.skills.length}): ${registeredSkillsDiscovery.bytes} bytes`,
);
for (const skill of registeredSkillsDiscovery.skills) {
  console.log(`  - ${skill.root}: ${skill.bytes} bytes`);
}
console.log(
  `Workflow-authoring skill corpus: ${workflowAuthoringSkillCorpus.bytes} bytes across ${workflowAuthoringSkillCorpus.files} files`,
);
console.log(`Representative authoring profile median: ${representativeAuthoringProfiles.medianBytes} bytes`);

if (!check) {
  writeWorkflowContextMeasurement(root, measurement);
  console.log(`Generated ${WORKFLOW_CONTEXT_MEASUREMENT_PATH}.`);
} else if (checkWorkflowContextMeasurement(root, measurement)) {
  console.log("Workflow context measurement is fresh.");
} else {
  console.error(`Stale workflow context measurement: ${WORKFLOW_CONTEXT_MEASUREMENT_PATH}`);
  process.exitCode = 1;
}

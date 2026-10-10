import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runWorkflow } from "../src/workflow.js";
import {
  CapabilityClassification,
  CapabilityOrigin,
  CapabilitySupport,
  defineWorkflowCapabilityContract,
  WORKFLOW_CAPABILITY_CONTRACT,
  WORKFLOW_CAPABILITY_DEFINITION,
  WorkflowCapabilityContractError,
} from "../src/workflow-capability-contract.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

const EXPECTED_RUNTIME_GLOBALS = [
  "agent",
  "args",
  "checkpoint",
  "console",
  "cwd",
  "log",
  "parallel",
  "phase",
  "pipeline",
  "process",
] as const;

const EXPECTED_TOOL_INPUTS = [
  "agentRetries",
  "agentTimeoutMs",
  "args",
  "background",
  "concurrency",
  "maxAgents",
  "name",
  "resumeFromRunId",
  "script",
] as const;

function implementations(): Record<string, unknown> {
  return Object.fromEntries(EXPECTED_RUNTIME_GLOBALS.map((name) => [name, { name }]));
}

test("capability definition inventories the settled runtime and invocation contract", () => {
  const runtimeGlobals = WORKFLOW_CAPABILITY_DEFINITION.capabilities
    .filter((capability) => capability.classification === CapabilityClassification.RUNTIME_GLOBAL)
    .map((capability) => capability.runtimeBinding?.global)
    .sort();
  const toolInputs = WORKFLOW_CAPABILITY_DEFINITION.capabilities
    .filter((capability) => capability.classification === CapabilityClassification.WORKFLOW_TOOL_INPUT)
    .map((capability) => capability.label)
    .sort();

  assert.deepEqual(runtimeGlobals, [...EXPECTED_RUNTIME_GLOBALS]);
  assert.deepEqual(toolInputs, [...EXPECTED_TOOL_INPUTS]);
  assert.deepEqual(
    WORKFLOW_CAPABILITY_DEFINITION.optionShapes.map((shape) => shape.id),
    ["agent-options"],
  );
  assert.ok(
    WORKFLOW_CAPABILITY_DEFINITION.capabilities.some(
      (capability) => capability.support === CapabilitySupport.COMPATIBILITY,
    ),
  );
  assert.ok(
    WORKFLOW_CAPABILITY_DEFINITION.capabilities.some((capability) => capability.origin === CapabilityOrigin.VM_REALM),
  );
  assert.deepEqual(
    WORKFLOW_CAPABILITY_DEFINITION.dynamicReferences.map(({ id, owner, items }) => ({ id, owner, items })),
    [
      { id: "model-routes", owner: "model-tier-config", items: undefined },
      { id: "agent-types", owner: "agent-registry", items: undefined },
    ],
  );
  assert.equal(WORKFLOW_CAPABILITY_DEFINITION.versions.format.kind, "present-at");
  assert.equal(WORKFLOW_CAPABILITY_DEFINITION.versions.content.kind, "present-at");
});

test("tool-input contract records configured omission defaults", () => {
  const agentTimeoutMs = WORKFLOW_CAPABILITY_DEFINITION.capabilities.find(
    ({ id }) => id === "workflow.tool-input.agentTimeoutMs",
  );

  assert.equal(agentTimeoutMs?.signature, "agentTimeoutMs?: number = configured default or unbounded");
});

test("declared tool inputs match the provider-visible workflow tool schema", () => {
  const { parameters } = createWorkflowTool();
  const properties = (parameters as { properties: Record<string, { description?: string }> }).properties;
  assert.deepEqual(Object.keys(properties).sort(), [...EXPECTED_TOOL_INPUTS]);
});

test("background is an ignored compatibility input and no fact offers a foreground run", () => {
  const background = WORKFLOW_CAPABILITY_DEFINITION.capabilities.find(
    ({ id }) => id === "workflow.tool-input.background",
  );
  assert.equal(background?.support, CapabilitySupport.COMPATIBILITY);
  assert.match(background?.constraints.join(" ") ?? "", /ignored.*every run starts in the background/);

  const checkpoint = WORKFLOW_CAPABILITY_DEFINITION.capabilities.find(({ id }) => id === "workflow.runtime.checkpoint");
  assert.equal(checkpoint?.signature, "checkpoint({ kind, checkpointId, payload }) => Promise<unknown>");
  assert.equal(checkpoint?.optionShape, null);
  assert.match(checkpoint?.constraints.join(" ") ?? "", /pauses the run/);

  const allFacts = JSON.stringify(WORKFLOW_CAPABILITY_DEFINITION);
  assert.doesNotMatch(allFacts, /background:? false|foreground/i);
});

test("contract data is immutable after validation", () => {
  const firstCapability = WORKFLOW_CAPABILITY_DEFINITION.capabilities[0];
  assert.throws(() => Object.assign(firstCapability, { label: "mutated" }), TypeError);
  assert.equal(WORKFLOW_CAPABILITY_DEFINITION.capabilities[0]?.label, "agent");
});

test("contract rejects malformed runtime and registry definitions", () => {
  const missingBinding = {
    ...WORKFLOW_CAPABILITY_DEFINITION,
    capabilities: WORKFLOW_CAPABILITY_DEFINITION.capabilities.map((capability, index) =>
      index === 0 ? { ...capability, runtimeBinding: null } : capability,
    ),
  };
  assert.throws(
    () => defineWorkflowCapabilityContract(missingBinding),
    (error: unknown) =>
      error instanceof WorkflowCapabilityContractError &&
      error.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "INVALID_CAPABILITY_DEFINITION" &&
          diagnostic.message === "Runtime-global capabilities require a runtime binding.",
      ),
  );

  const [firstOptionShape] = WORKFLOW_CAPABILITY_DEFINITION.optionShapes;
  const [firstDynamicReference] = WORKFLOW_CAPABILITY_DEFINITION.dynamicReferences;
  assert.ok(firstOptionShape);
  assert.ok(firstDynamicReference);
  const duplicateRegistries = {
    ...WORKFLOW_CAPABILITY_DEFINITION,
    optionShapes: [...WORKFLOW_CAPABILITY_DEFINITION.optionShapes, firstOptionShape],
    dynamicReferences: [...WORKFLOW_CAPABILITY_DEFINITION.dynamicReferences, firstDynamicReference],
  };
  assert.throws(
    () => defineWorkflowCapabilityContract(duplicateRegistries),
    (error: unknown) =>
      error instanceof WorkflowCapabilityContractError &&
      error.diagnostics.filter((diagnostic) => diagnostic.code === "INVALID_CAPABILITY_DEFINITION").length === 2,
  );

  const duplicateImplementationIdentity = {
    ...WORKFLOW_CAPABILITY_DEFINITION,
    capabilities: WORKFLOW_CAPABILITY_DEFINITION.capabilities.map((capability, index) =>
      index === 1 && capability.runtimeBinding
        ? {
            ...capability,
            runtimeBinding: {
              ...capability.runtimeBinding,
              implementation: WORKFLOW_CAPABILITY_DEFINITION.capabilities[0]?.runtimeBinding?.implementation ?? "agent",
            },
          }
        : capability,
    ),
  };
  assert.throws(
    () => defineWorkflowCapabilityContract(duplicateImplementationIdentity),
    (error: unknown) =>
      error instanceof WorkflowCapabilityContractError &&
      error.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "INVALID_CAPABILITY_DEFINITION" &&
          diagnostic.subject === "agent" &&
          diagnostic.message === 'Duplicate runtime implementation identity "agent".',
      ),
  );

  const duplicateAnchor = {
    ...WORKFLOW_CAPABILITY_DEFINITION,
    capabilities: WORKFLOW_CAPABILITY_DEFINITION.capabilities.map((capability, index) =>
      index === 1 ? { ...capability, detailsAnchor: "agent" } : capability,
    ),
  };
  assert.throws(
    () => defineWorkflowCapabilityContract(duplicateAnchor),
    (error: unknown) =>
      error instanceof WorkflowCapabilityContractError &&
      error.diagnostics.some((diagnostic) => diagnostic.message === 'Duplicate details anchor "agent".'),
  );
});

test("runtime assembly preserves declared implementation identity", () => {
  const supplied = implementations();
  const assembled = WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings(supplied);

  assert.deepEqual(Object.keys(assembled.globals).sort(), [...EXPECTED_RUNTIME_GLOBALS]);
  assert.deepEqual(assembled.diagnostics, []);
  for (const name of EXPECTED_RUNTIME_GLOBALS) assert.equal(assembled.globals[name], supplied[name]);
});

test("static reference projection keeps live catalogue values out of contract data", () => {
  const facts = WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts();
  const modelRoutes = facts.find((fact) => fact.id === "workflow.dynamic.model-routes");
  const agent = facts.find((fact) => fact.id === "workflow.runtime.agent");

  assert.deepEqual(modelRoutes?.dynamicReference, {
    id: "model-routes",
    owner: "model-tier-config",
    itemShape: "{ name: string; description?: string }",
    connection: "loadModelTierConfig",
  });
  assert.equal(Object.hasOwn(modelRoutes?.dynamicReference ?? {}, "items"), false);
  assert.equal(agent?.options?.id, "agent-options");
  assert.deepEqual(
    agent?.options?.options
      .filter(({ dynamicReference }) => dynamicReference === "model-routes")
      .map(({ name }) => name),
    ["tier"],
  );
  assert.match(agent?.reference ?? "", /capability-details\.md#agent$/);
});

test("alignment diagnostics compare declared and observed project globals", () => {
  assert.deepEqual(
    WORKFLOW_CAPABILITY_CONTRACT.diagnoseAlignment({
      observedProjectGlobals: EXPECTED_RUNTIME_GLOBALS.filter((name) => name !== "agent").concat("accidental"),
    }),
    [
      {
        code: "DECLARED_GLOBAL_UNOBSERVED",
        severity: "error",
        subject: "agent",
        message: 'Declared workflow global "agent" was not observed in the assembled context.',
      },
      {
        code: "OBSERVED_GLOBAL_UNDECLARED",
        severity: "error",
        subject: "accidental",
        message: 'Observed project-owned workflow global "accidental" is undeclared.',
      },
    ],
  );
});

test("runtime assembly refuses a missing implementation with a precise diagnostic", () => {
  const supplied = implementations();
  delete supplied.agent;

  assert.throws(
    () => WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings(supplied),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowCapabilityContractError);
      assert.match(error.message, /missing declared runtime implementation: agent/);
      assert.deepEqual(error.diagnostics, [
        {
          code: "MISSING_RUNTIME_IMPLEMENTATION",
          severity: "error",
          subject: "agent",
          message: 'Declared workflow global "agent" has no supplied implementation "agent".',
        },
      ]);
      return true;
    },
  );
});

test("runtime assembly treats an undefined required implementation as missing", () => {
  const supplied = implementations();
  supplied.agent = undefined;

  assert.throws(
    () => WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings(supplied),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowCapabilityContractError);
      assert.match(error.message, /missing declared runtime implementation: agent/);
      assert.deepEqual(error.diagnostics, [
        {
          code: "MISSING_RUNTIME_IMPLEMENTATION",
          severity: "error",
          subject: "agent",
          message: 'Declared workflow global "agent" has no supplied implementation "agent".',
        },
      ]);
      return true;
    },
  );
});

test("runtime assembly preserves undefined for the optional args runtime value", () => {
  const supplied = implementations();
  supplied.args = undefined;

  const assembled = WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings(supplied);

  assert.equal(Object.hasOwn(assembled.globals, "args"), true);
  assert.equal(assembled.globals.args, undefined);
  assert.deepEqual(assembled.diagnostics, []);
});

test("runtime assembly reports and ignores an undeclared implementation", () => {
  const supplied = { ...implementations(), accidental: { secret: true } };
  const assembled = WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings(supplied);

  assert.equal(Object.hasOwn(assembled.globals, "accidental"), false);
  assert.deepEqual(assembled.diagnostics, [
    {
      code: "UNDECLARED_RUNTIME_IMPLEMENTATION",
      severity: "warning",
      subject: "accidental",
      message: 'Supplied runtime implementation "accidental" is undeclared and was ignored.',
    },
  ]);
});

test("runWorkflow exposes exactly the declared project-owned globals", async () => {
  const result = await runWorkflow<{
    allGlobals: string[];
    substratePresent: boolean;
    agentResult: string;
    processMatchesCwd: boolean;
  }>(
    `export const meta = { name: 'observe_contract', description: 'observe project globals' }
return {
  allGlobals: Object.getOwnPropertyNames(globalThis).sort(),
  substratePresent: typeof Array === 'function',
  agentResult: await agent('proof', { label: 'proof' }),
  processMatchesCwd: process.cwd() === cwd,
}`,
    {
      args: [...EXPECTED_RUNTIME_GLOBALS],
      cwd: "/contract-cwd",
      agent: {
        async run() {
          return "ok";
        },
      },
      persistLogs: false,
    },
  );

  const rawVmRealmGlobals: unknown = new vm.Script("Object.getOwnPropertyNames(globalThis)").runInContext(
    vm.createContext({}),
  );
  assert.ok(Array.isArray(rawVmRealmGlobals));
  const vmRealmGlobals = new Set(rawVmRealmGlobals.filter((name): name is string => typeof name === "string"));
  const observedProjectGlobals = Array.from(result.result.allGlobals).filter(
    (name) => !vmRealmGlobals.has(name) || name === "console",
  );

  assert.deepEqual(observedProjectGlobals, [...EXPECTED_RUNTIME_GLOBALS]);
  assert.deepEqual(WORKFLOW_CAPABILITY_CONTRACT.diagnoseAlignment({ observedProjectGlobals }), []);
  assert.equal(result.result.substratePresent, true);
  assert.equal(result.result.agentResult, "ok");
  assert.equal(result.result.processMatchesCwd, true);
});

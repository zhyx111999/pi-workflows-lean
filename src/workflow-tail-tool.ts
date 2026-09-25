import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowAgentSnapshot } from "./display.js";
import type { PersistedAgentState } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";

export const WORKFLOW_TAIL_CHARS = 8000;
export const WORKFLOW_TAIL_TOOL_NAME = "workflow_tail";

const workflowTailSchema = Type.Object({
  runId: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Workflow run ID. Omit to use the most recently started run in this session.",
    }),
  ),
  label: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Subagent label. Omit to use the most recently updated subagent in that run.",
    }),
  ),
});

type TailAgent = {
  id: number;
  label: string;
  phase?: string;
  status: string;
  history?: AgentHistoryEntry[];
  result?: unknown;
  error?: string;
  endedAt?: string;
};

export interface WorkflowTailToolOptions {
  getManager: () => WorkflowManager;
}

function latestStamp(agent: TailAgent): number {
  let stamp = 0;
  for (const entry of agent.history ?? []) {
    if (typeof entry.timestamp === "number" && entry.timestamp > stamp) stamp = entry.timestamp;
  }
  if (agent.endedAt) {
    const ended = Date.parse(agent.endedAt);
    if (Number.isFinite(ended) && ended > stamp) stamp = ended;
  }
  return stamp;
}

export function selectTailAgent(agents: readonly TailAgent[], label?: string): TailAgent | undefined {
  const pool = label ? agents.filter((agent) => agent.label === label) : [...agents];
  if (!pool.length) return undefined;
  return pool.reduce((best, agent) => {
    const bestStamp = latestStamp(best);
    const stamp = latestStamp(agent);
    if (stamp > bestStamp || (stamp === bestStamp && agent.id > best.id)) return agent;
    return best;
  });
}

export function renderAgentTail(agent: TailAgent, maxChars = WORKFLOW_TAIL_CHARS): string {
  const lines = [`label: ${agent.label}`, `status: ${agent.status}`];
  if (agent.phase) lines.push(`phase: ${agent.phase}`);
  for (const entry of agent.history ?? []) {
    const who = entry.toolName ? `${entry.role}:${entry.toolName}` : entry.role;
    lines.push(`[${who}] ${entry.text}`);
  }
  if (agent.result !== undefined) {
    lines.push(`[result] ${typeof agent.result === "string" ? agent.result : JSON.stringify(agent.result)}`);
  }
  if (agent.error) lines.push(`[error] ${agent.error}`);
  const text = lines.join("\n");
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

function asTailAgent(agent: WorkflowAgentSnapshot | PersistedAgentState): TailAgent {
  return {
    id: agent.id,
    label: agent.label,
    phase: agent.phase,
    status: agent.status,
    history: agent.history,
    result: agent.result,
    error: agent.error,
    endedAt: "endedAt" in agent ? agent.endedAt : undefined,
  };
}

export function createWorkflowTailTool(
  options: WorkflowTailToolOptions,
): ToolDefinition<typeof workflowTailSchema> {
  return defineTool({
    name: WORKFLOW_TAIL_TOOL_NAME,
    label: "Workflow tail",
    description:
      "Read the latest 8000 characters of one subagent session so the parent can judge its status and progress. Final workflow delivery is unchanged.",
    parameters: workflowTailSchema,
    async execute(_toolCallId, params) {
      const details: {
        found: boolean;
        runId?: string;
        labels?: string;
        label?: string;
        status?: string;
        chars?: number;
      } = { found: false };
      const manager = options.getManager();
      const runs = manager.listRuns().slice().sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      const run = params.runId ? runs.find((item) => item.runId === params.runId) : runs[0];
      if (!run) {
        return {
          content: [{ type: "text" as const, text: params.runId ? `No workflow run ${params.runId}.` : "No workflow runs." }],
          details,
        };
      }
      const live = manager.getSnapshot(run.runId)?.agents.map(asTailAgent);
      const agents = live?.length ? live : run.agents.map(asTailAgent);
      const agent = selectTailAgent(agents, params.label);
      if (!agent) {
        const labels = [...new Set(agents.map((item) => item.label))].join(", ") || "(none)";
        details.runId = run.runId;
        details.labels = labels;
        return {
          content: [
            {
              type: "text" as const,
              text: params.label
                ? `Run ${run.runId} has no subagent labeled "${params.label}". Labels: ${labels}`
                : `Run ${run.runId} has no subagents yet.`,
            },
          ],
          details,
        };
      }
      details.found = true;
      details.runId = run.runId;
      details.label = agent.label;
      details.status = agent.status;
      details.chars = WORKFLOW_TAIL_CHARS;
      return {
        content: [{ type: "text" as const, text: renderAgentTail(agent) }],
        details,
      };
    },
  });
}

/** Groups a run's agents by phase: the one phase list every progress surface lays out. */
import { asText } from "./navigator/as-text.js";
/** Title of the group that holds agents which ran outside any phase. */
export const NO_PHASE_TITLE = "(no phase)";
/**
 * Declared phases come first, in declared order, including those no agent has
 * reached yet. Every phase that only an agent names (an explicit
 * `agent({ phase })`, or the phase-less group) follows in the order its first
 * agent appears. Snapshots can come from corrupt records or unchecked scripts,
 * so non-array fields read as empty and titles are coerced to text before they
 * become keys.
 */
export function groupAgentsByPhase(snapshot) {
    const groups = new Map();
    const groupOf = (title) => {
        let group = groups.get(title);
        if (!group) {
            group = { title, agents: [], counts: { queued: 0, running: 0, done: 0, error: 0, skipped: 0 } };
            groups.set(title, group);
        }
        return group;
    };
    for (const title of Array.isArray(snapshot.phases) ? snapshot.phases : [])
        groupOf(asText(title));
    for (const agent of Array.isArray(snapshot.agents) ? snapshot.agents : []) {
        const group = groupOf(agent.phase == null ? NO_PHASE_TITLE : asText(agent.phase));
        group.agents.push(agent);
        if (Object.hasOwn(group.counts, agent.status))
            group.counts[agent.status]++;
    }
    return [...groups.values()];
}

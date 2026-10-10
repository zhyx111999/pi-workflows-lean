/** The runs pane's selectable items: their identities, and the filtered list every runs-pane operation shares. */
import { type SavedWorkflow } from "../workflow-saved.js";
import type { RunRow } from "./rows.js";
export type ItemKind = "run" | "saved";
/** A saved workflow is identified by its exact file revision, so an action never hits an edited or replaced copy. */
export type SavedItemIdentity = {
    kind: "saved";
    path: string;
    source: SavedWorkflow["source"];
    name: string;
    revision: string;
};
export type ItemIdentity = {
    kind: "run";
    runId: string;
} | SavedItemIdentity;
export interface VisibleRunItem {
    kind: "run";
    identity: Extract<ItemIdentity, {
        kind: "run";
    }>;
    row: RunRow;
}
export interface VisibleSavedItem {
    kind: "saved";
    identity: SavedItemIdentity;
    workflow: SavedWorkflow;
}
export type VisibleNavigatorItem = VisibleRunItem | VisibleSavedItem;
/** One coherent, filtered source of truth for every runs-pane operation. */
export interface NavigatorSnapshot {
    filter: string;
    items: VisibleNavigatorItem[];
}
export declare function savedIdentity(workflow: SavedWorkflow): SavedItemIdentity;
export declare function sameIdentity(a: ItemIdentity | undefined, b: ItemIdentity | undefined): boolean;
/** Runs first, then saved workflows, keeping those that match `filter` case-insensitively. */
export declare function visibleItems(filter: string, runs: RunRow[], saved: SavedWorkflow[]): NavigatorSnapshot;

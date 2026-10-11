/** Applies navigator key presses for each input mode: text entry, confirmation, and browsing. */

import type { NavAction, NavigatorModel, NavigatorState } from "../workflow-ui.js";
import type { ConfirmKind } from "./confirmation.js";
import { savedIdentity } from "./items.js";
import { executeRunConfirmation, restartRun } from "./run-actions.js";
import { commitRename, deleteSavedWorkflow, saveRunAsWorkflow } from "./saved-actions.js";
import { currentSnapshot, type NavigatorSession } from "./session.js";

/** Filter and rename fields own every keystroke, so pasted text never reaches browse bindings. */
export function handleTextInput(session: NavigatorSession, key: string | undefined, data: string): void {
  const { state, model } = session;
  if (key === "escape" || key === "esc") state.cancelInput();
  else if (key === "backspace" || data === String.fromCharCode(127) || data === "\b") state.backspaceInput();
  else if (key === "enter" || key === "return") {
    if (state.mode === "filter") state.applyFilter(model);
    else commitRename(session);
  } else state.appendInput(data);
}

/** Only the key that asked confirms (p for pause, x for stop or delete); any other key cancels. */
export function handleConfirmKey(session: NavigatorSession, key: string | undefined): void {
  const { state } = session;
  const pendingAction = state.confirmationAction;
  const action: ConfirmKind | undefined =
    (pendingAction === "pause" && key === "p") ||
    ((pendingAction === "stop" || pendingAction === "deleteSaved") && key === "x")
      ? pendingAction
      : undefined;
  const target = action ? state.confirm(action, currentSnapshot(session)) : undefined;
  if (!target || !action) {
    state.cancelConfirmation();
    return;
  }
  if (target.kind === "run") executeRunConfirmation(session, action, target.runId);
  else if (action === "deleteSaved") deleteSavedWorkflow(session, target);
}

function currentCount(state: NavigatorState, model: NavigatorModel): number {
  if (state.kind === "runs") return model.visible(state.filter).items.length;
  if (state.kind === "phases" && state.runId) return model.phases(state.runId).length;
  if (state.kind === "agents" && state.runId && state.phase !== undefined)
    return model.agents(state.runId, state.phase).length;
  return 0;
}

/**
 * Apply a browse-mode action. Returns false when nothing should be redrawn:
 * the key did nothing, or the overlay closed.
 */
export function runBrowseAction(session: NavigatorSession, action: NavAction, close: () => void): boolean {
  const { state, model } = session;
  const snapshot = () => currentSnapshot(session);
  switch (action.type) {
    case "move":
      if (state.kind === "runs") state.moveRuns(action.delta, snapshot());
      else state.move(action.delta, currentCount(state, model), snapshot());
      return true;
    case "page":
      state.movePage(action.direction, currentCount(state, model), snapshot());
      return true;
    case "jump":
      state.jump(action.edge, currentCount(state, model), snapshot());
      return true;
    case "toggleTail":
      state.toggleTail();
      return true;
    case "togglePager":
      state.togglePager();
      return true;
    case "openPager":
      state.openPager();
      return true;
    case "filter":
      state.beginFilter();
      return true;
    case "rename": {
      const workflow = state.activeSaved(snapshot(), model.saved());
      if (workflow) state.beginRename(workflow);
      return true;
    }
    case "drill":
      state.drill(model, snapshot());
      return true;
    case "back":
      // Esc with nothing left to back out of closes the overlay.
      if (!state.back()) close();
      return true;
    case "close":
      close();
      return false;
    case "deleteSaved": {
      const workflow = state.activeSaved(snapshot(), model.saved());
      if (workflow) state.beginConfirmation("deleteSaved", savedIdentity(workflow), snapshot());
      return true;
    }
    case "pause": {
      const runId = state.activeRunId(model, snapshot());
      if (runId) state.beginConfirmation("pause", { kind: "run", runId }, snapshot());
      return true;
    }
    case "stop": {
      const runId = state.activeRunId(model, snapshot());
      if (runId) state.beginConfirmation("stop", { kind: "run", runId }, snapshot());
      return true;
    }
    case "restart":
      restartRun(session, state.activeRunId(model, snapshot()));
      return true;
    case "save":
      saveRunAsWorkflow(session, state.activeRunId(model, snapshot()));
      return true;
    default:
      return false;
  }
}

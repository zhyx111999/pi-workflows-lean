/**
 * Tests for the extension entry point: tool and command registration, the
 * parent-prompt hooks, and live-runtime handoff across session replacement.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  takeWorkflowRuntime,
  WORKFLOW_EXTENSION_BUILD,
} from "../src/extension-reload.js";
import { reportDiagnostic } from "../src/host-diagnostics.js";
import { PARENT_PROMPT_MESSAGE_TYPE, PARENT_WORKFLOW_PROMPT } from "../src/parent-prompt.js";
import { useHostSessionClass } from "../src/task-panel/host-session-capture.js";
import { _resetDeliveryRegistriesForTests } from "../src/task-panel.js";
import { getWorkflowSettingsPath } from "../src/workflow-settings.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { FakeHostSession, type HostMessage, sendMessageTo } from "./helpers/fake-host-session.js";
import { fakeExtensionHost, sessionStartContext } from "./helpers/mock-pi.js";

/**
 * Install an extension generation that takes over a staged runtime reporting
 * one live run, and record which runs its shutdown pauses.
 */
async function installWithLiveRun(runId: string) {
  const { default: installExtension } = await import("../src/pi-extension.js");
  discardWorkflowRuntime();
  const seed = fakeExtensionHost({ activeTools: ["bash"] });
  installExtension(seed.pi);
  seed.handlers.session_shutdown?.[0]?.({ reason: "reload" });
  const staged = takeWorkflowRuntime();
  assert.ok(staged, "seed reload must expose the manager for live-run injection");

  const paused: string[] = [];
  staged.manager.listLiveRuns = (() => [{ runId, status: "running" }]) as typeof staged.manager.listLiveRuns;
  staged.manager.pause = ((id: string) => {
    paused.push(id);
    return true;
  }) as typeof staged.manager.pause;
  handoffWorkflowRuntime(staged);

  const host = fakeExtensionHost({ activeTools: ["bash"] });
  installExtension(host.pi);
  return { handlers: host.handlers, paused };
}

describe("workflow extension - tool availability", () => {
  it("registers exactly the two subagents tools and hands the live runtime across reload", async (t) => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime();
        const {
          pi,
          tools: registeredTools,
          commands,
          handlers,
          activeTools,
        } = fakeExtensionHost({
          activeTools: ["bash", "read"],
        });
        const { default: installExtension } = await import("../src/pi-extension.js");

        installExtension(pi);

        assert.deepEqual(registeredTools, ["subagents", "subagents_control"]);
        assert.deepEqual([...commands.keys()].sort(), [
          "deep-research",
          "workflows",
          "workflows-models",
          "workflows-progress",
        ]);
        assert.equal(handlers.session_start.length, 1);
        assert.equal(handlers.input.length, 1, "one parent-prompt input hook per extension generation");
        assert.equal(handlers.before_agent_start.length, 1, "one parent-prompt start hook per extension generation");
        assert.equal(handlers.input[0]({ source: "interactive", text: "hello" }), undefined, "typed text is kept");
        assert.deepEqual(handlers.before_agent_start[0]({ prompt: "hello" }), {
          message: { customType: PARENT_PROMPT_MESSAGE_TYPE, content: PARENT_WORKFLOW_PROMPT, display: false },
        });
        handlers.input[0]({ source: "interactive", text: "/workflows list" });
        assert.equal(handlers.before_agent_start[0]({ prompt: "/workflows list" }), undefined);
        const notified: string[] = [];
        handlers.session_start[0](
          {},
          sessionStartContext("session-1", { ui: { notify: (message: string) => notified.push(message) } }),
        );
        reportDiagnostic("while the session is bound");
        assert.deepEqual(notified, ["while the session is bound"], "diagnostics go to the session's UI");

        assert.deepEqual(activeTools, ["bash", "read", "subagents", "subagents_control"]);
        assert.equal(handlers.input.length, 1, "session_start does not add another input hook");
        assert.equal(handlers.before_agent_start.length, 1, "session_start does not add another start hook");

        handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const stderr = t.mock.method(console, "warn", () => {});
        reportDiagnostic("after shutdown");
        assert.deepEqual(notified, ["while the session is bound"], "a shut-down session's UI gets nothing more");
        assert.equal(stderr.mock.callCount(), 1);
        stderr.mock.restore();
        const staged = takeWorkflowRuntime();
        assert.ok(staged, "session_shutdown(reload) stages the live manager for the next extension generation");
        handoffWorkflowRuntime(staged);

        const { pi: secondPi, handlers: secondHandlers } = fakeExtensionHost({ activeTools, tools: registeredTools });
        installExtension(secondPi);
        assert.equal(takeWorkflowRuntime(), undefined, "the fresh factory consumes the staged runtime");

        secondHandlers.session_start?.[0]?.({ reason: "reload" }, sessionStartContext("session-2"));

        secondHandlers.session_shutdown?.[0]?.({ reason: "reload" });
        const restaged = takeWorkflowRuntime();
        assert.equal(restaged?.manager, staged.manager, "a compatible generation keeps the exact live manager");
        discardWorkflowRuntime();
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("starts from a settings file that still holds keys from removed features", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-legacy-settings-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime();
        const settingsPath = getWorkflowSettingsPath();
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(
          settingsPath,
          JSON.stringify({
            keywordTriggerEnabled: false,
            keywordTriggerWord: "pi-workflow",
            defaultEffort: "ultra",
            progressPanelMode: "detailed",
            progressPanelMaxAgents: 5,
          }),
        );
        const sent: string[] = [];
        const { pi, commands, handlers } = fakeExtensionHost({
          sendMessage: (message: { content?: string }) => {
            sent.push(message.content ?? "");
          },
        });
        const { default: installExtension } = await import("../src/pi-extension.js");

        installExtension(pi);
        handlers.session_start[0]({}, sessionStartContext("legacy-settings-session"));

        assert.equal(commands.has("workflows-trigger"), false);
        await commands.get("workflows-progress")?.handler("status", {});
        assert.match(sent.at(-1) ?? "", /panel is detailed, showing up to 5 agents per phase/);
        handlers.session_shutdown?.[0]?.({ reason: "quit" });
        discardWorkflowRuntime();
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("hands the live runtime across in-process session replacement when the destination is safe", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-replace-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-dw-session-files-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const sameSessionFile = join(sessionDir, "same.jsonl");
        writeFileSync(
          sameSessionFile,
          `${JSON.stringify({
            type: "session",
            id: "same",
            cwd: process.cwd(),
            timestamp: new Date().toISOString(),
          })}\n`,
        );

        // resume requires a readable same-cwd header; fork may lack a file;
        // new/reload are same-project by definition.
        const cases: Array<{
          reason: "new" | "resume" | "fork";
          event: { reason: string; targetSessionFile?: string };
        }> = [
          { reason: "new", event: { reason: "new" } },
          { reason: "fork", event: { reason: "fork" } },
          { reason: "resume", event: { reason: "resume", targetSessionFile: sameSessionFile } },
        ];

        for (const { reason, event } of cases) {
          discardWorkflowRuntime();

          const { pi, handlers, activeTools } = fakeExtensionHost({ activeTools: ["bash", "read"] });
          const { default: installExtension } = await import("../src/pi-extension.js");
          installExtension(pi);

          handlers.session_shutdown?.[0]?.(event);
          const staged = takeWorkflowRuntime();
          assert.ok(
            staged,
            `session_shutdown(${reason}) must stage the live manager so background result delivery survives`,
          );
          handoffWorkflowRuntime(staged);

          // Pi binds the second generation's pi to the replacement host session.
          useHostSessionClass(FakeHostSession);
          const hostSession = new FakeHostSession(`session-${reason}`);
          const { pi: secondPi, handlers: secondHandlers } = fakeExtensionHost({
            activeTools,
            sendMessage: sendMessageTo(hostSession),
          });
          installExtension(secondPi);
          assert.equal(takeWorkflowRuntime(), undefined, "second generation claims the staged runtime");

          secondHandlers.session_start?.[0]?.({ reason }, sessionStartContext(`session-${reason}`));

          // One run per case: delivery seeds a record, and a record's owner
          // outranks the in-memory copy, so a shared id would carry the
          // previous case's session.
          const runId = `bg-${reason}`;
          const fakeRun = {
            runId,
            sessionId: `session-${reason}`,
            snapshot: { name: "t", agentCount: 0 },
            result: { agentCount: 0, result: { verdict: `ok-${reason}` } },
          };
          const origGet = staged.manager.getRun.bind(staged.manager);
          (staged.manager as { getRun: (id: string) => unknown }).getRun = (id: string) =>
            id === runId ? fakeRun : origGet(id);
          staged.manager.emit("complete", { runId });
          assert.ok(
            hostSession.received.some(({ message }) => message.content.includes(`ok-${reason}`)),
            `completion after ${reason} handoff must deliver through the captured host session`,
          );
          discardWorkflowRuntime();
          _resetDeliveryRegistriesForTests();
        }
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("resume fails closed without a readable same-cwd session header; fork may hand off without a file", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-resume-closed-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-dw-session-resume-closed-"));
    const otherProject = mkdtempSync(join(tmpdir(), "pi-dw-other-resume-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        // resume + no targetSessionFile → discard
        {
          const { handlers, paused } = await installWithLiveRun("resume-no-target");
          handlers.session_shutdown?.[0]?.({ reason: "resume" });
          assert.deepEqual(paused, ["resume-no-target"], "fail-closed resume must pause the live run");
          assert.equal(
            takeWorkflowRuntime(),
            undefined,
            "resume without targetSessionFile must fail closed (no handoff)",
          );
        }

        // resume + missing/unreadable header → discard
        {
          const { handlers, paused } = await installWithLiveRun("resume-missing-header");
          handlers.session_shutdown?.[0]?.({
            reason: "resume",
            targetSessionFile: join(sessionDir, "does-not-exist.jsonl"),
          });
          assert.deepEqual(paused, ["resume-missing-header"], "unreadable resume target must pause the live run");
          assert.equal(takeWorkflowRuntime(), undefined, "resume with missing session header must fail closed");
        }

        // resume + different cwd header → discard
        {
          discardWorkflowRuntime();
          const foreign = join(sessionDir, "foreign.jsonl");
          writeFileSync(
            foreign,
            `${JSON.stringify({
              type: "session",
              id: "foreign",
              cwd: otherProject,
              timestamp: new Date().toISOString(),
            })}\n`,
          );
          const { handlers, paused } = await installWithLiveRun("resume-foreign-cwd");
          handlers.session_shutdown?.[0]?.({ reason: "resume", targetSessionFile: foreign });
          assert.deepEqual(paused, ["resume-foreign-cwd"], "cross-project resume must pause the source live run");
          assert.equal(takeWorkflowRuntime(), undefined, "resume into a different project must discard, not hand off");
        }

        // resume + same cwd header → handoff
        {
          discardWorkflowRuntime();
          const same = join(sessionDir, "same-cwd.jsonl");
          writeFileSync(
            same,
            `${JSON.stringify({
              type: "session",
              id: "same",
              cwd: process.cwd(),
              timestamp: new Date().toISOString(),
            })}\n`,
          );
          const { handlers, paused } = await installWithLiveRun("resume-same-cwd");
          handlers.session_shutdown?.[0]?.({ reason: "resume", targetSessionFile: same });
          assert.deepEqual(paused, [], "same-project resume must keep the live run running");
          const staged = takeWorkflowRuntime();
          assert.ok(staged, "resume with readable same-cwd header must hand off");
          discardWorkflowRuntime();
        }

        // fork without a session file still hands off (new fork file may not exist yet)
        {
          const { handlers, paused } = await installWithLiveRun("fork-no-target");
          handlers.session_shutdown?.[0]?.({ reason: "fork" });
          assert.deepEqual(paused, [], "fork without a target file stays in-project and must keep the live run");
          const staged = takeWorkflowRuntime();
          assert.ok(staged, "fork without targetSessionFile must still hand off");
          discardWorkflowRuntime();
        }

        // fork + positively foreign cwd → pause + discard
        {
          const foreign = join(sessionDir, "foreign-fork.jsonl");
          writeFileSync(
            foreign,
            `${JSON.stringify({
              type: "session",
              id: "foreign-fork",
              cwd: otherProject,
              timestamp: new Date().toISOString(),
            })}\n`,
          );
          const { handlers, paused } = await installWithLiveRun("fork-foreign-cwd");
          handlers.session_shutdown?.[0]?.({ reason: "fork", targetSessionFile: foreign });
          assert.deepEqual(paused, ["fork-foreign-cwd"], "foreign fork target must pause the source live run");
          assert.equal(takeWorkflowRuntime(), undefined, "foreign fork target must not stage a handoff");
        }
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it("defers saved-command registration until session_start so cross-cwd descriptions come from the target project", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-saved-defer-"));
    const otherProject = mkdtempSync(join(tmpdir(), "pi-dw-other-saved-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const { createWorkflowStorage } = await import("../src/workflow-saved.js");
        createWorkflowStorage(process.cwd()).save({
          name: "same",
          description: "SECRET_FROM_A",
          script: "export SOURCE_A",
        });
        createWorkflowStorage(otherProject).save({
          name: "same",
          description: "from-B",
          script: "export TARGET_B",
        });

        discardWorkflowRuntime();
        discardWorkflowRuntime();

        const { pi, commands, handlers } = fakeExtensionHost({ activeTools: ["bash"] });

        const { default: installExtension } = await import("../src/pi-extension.js");
        installExtension(pi);

        assert.equal(
          commands.has("same"),
          false,
          "factory must not register project saved commands before session_start",
        );

        handlers.session_start?.[0]?.({ reason: "resume" }, sessionStartContext("session-b", { cwd: otherProject }));

        const savedCmd = commands.get("same");
        assert.ok(savedCmd, "session_start must register the target project's saved command");
        assert.equal(
          savedCmd.description,
          "from-B",
          "command description must come from the session project, not the factory cwd",
        );

        // Capture the live manager and assert the handler executes B's script.
        handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const runtime = claimWorkflowRuntime().compatible;
        assert.ok(runtime, "shutdown after rebuild must be claimable via process.cwd()");
        const started: string[] = [];
        runtime.manager.startInBackground = ((script: string) => {
          started.push(script);
          return { runId: "bg-same", promise: new Promise(() => {}) };
        }) as typeof runtime.manager.startInBackground;

        const notified: Array<{ message: string; type?: string }> = [];
        await savedCmd.handler("", {
          ui: {
            notify: (message: string, type?: string) => notified.push({ message, type }),
            setStatus: () => {},
          },
        });
        assert.deepEqual(started, ["export TARGET_B"]);
        assert.ok(notified.some((n) => n.type === "info"));
        discardWorkflowRuntime();
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it("wires model_select to manager.setMainModel", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-model-select-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime();
        const { WorkflowManager } = await import("../src/workflow-manager.js");
        const seen: Array<string | undefined> = [];
        const original = WorkflowManager.prototype.setMainModel;
        WorkflowManager.prototype.setMainModel = function setMainModelSpy(spec: string | undefined) {
          seen.push(spec);
          return original.call(this, spec);
        };
        try {
          const { pi, handlers } = fakeExtensionHost({ activeTools: ["bash", "read"] });
          const { default: installExtension } = await import("../src/pi-extension.js");
          installExtension(pi);

          assert.equal(handlers.model_select?.length, 1, "must listen for model_select");

          handlers.session_start[0](
            {},
            {
              cwd: process.cwd(),
              model: { provider: "start-prov", id: "model-a" },
              modelRegistry: {},
              sessionManager: { getSessionId: () => "session-model" },
              ui: { setWidget: () => {}, notify: () => {} },
            },
          );
          assert.ok(seen.includes("start-prov/model-a"), "session_start should seed mainModel from ctx.model");

          handlers.model_select[0]({
            type: "model_select",
            model: { provider: "live-prov", id: "model-b" },
            previousModel: { provider: "start-prov", id: "model-a" },
            source: "set",
          });
          assert.ok(
            seen.includes("live-prov/model-b"),
            "model_select must call setMainModel with the newly selected spec",
          );

          discardWorkflowRuntime();
        } finally {
          WorkflowManager.prototype.setMainModel = original;
        }
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("queues completions that land before session_start and flushes them after", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-prebind-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime();
        useHostSessionClass(FakeHostSession);
        const hostSession = new FakeHostSession("s-prebind");
        const delivered = () => hostSession.received.map(({ message }) => message.content);
        // Pi throws from sendMessage until it binds the generation to a session.
        let secondBound = false;
        const unboundSend = (isBound: () => boolean) => (msg: HostMessage, options?: unknown) => {
          if (!isBound()) throw new Error("Extension runtime not initialized");
          sendMessageTo(hostSession)(msg, options);
        };
        const { pi, handlers, activeTools } = fakeExtensionHost({
          activeTools: ["bash", "read"],
          sendMessage: unboundSend(() => false),
        });
        const { default: installExtension } = await import("../src/pi-extension.js");
        installExtension(pi);

        handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const staged = takeWorkflowRuntime();
        assert.ok(staged);
        handoffWorkflowRuntime(staged);

        const { pi: pi2, handlers: handlers2 } = fakeExtensionHost({
          activeTools,
          sendMessage: unboundSend(() => secondBound),
        });
        installExtension(pi2);

        const fakeRun = {
          runId: "bg-prebind",
          snapshot: { name: "t", agentCount: 0 },
          result: { agentCount: 0, result: { verdict: "prebind-ok" } },
        };
        const mgr = staged.manager;
        const origGet = mgr.getRun.bind(mgr);
        (mgr as { getRun: (id: string) => unknown }).getRun = (id: string) =>
          id === "bg-prebind" ? fakeRun : origGet(id);
        // Ensure flush can see the in-memory pending marker (not only disk).
        const origListLive = mgr.listLiveRuns?.bind(mgr);
        (mgr as { listLiveRuns: () => unknown[] }).listLiveRuns = () => {
          const live = origListLive ? origListLive() : [];
          return live.some((r: { runId?: string }) => r?.runId === "bg-prebind") ? live : [...live, fakeRun];
        };
        mgr.emit("complete", { runId: "bg-prebind" });
        assert.equal(delivered().length, 0, "must not deliver while runtime unbound");

        secondBound = true;
        handlers2.session_start?.[0]?.(
          { reason: "reload" },
          {
            cwd: process.cwd(),
            model: undefined,
            modelRegistry: {},
            sessionManager: {
              getSessionId: () => "s-prebind",
            },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );
        assert.ok(
          delivered().some((c) => c.includes("prebind-ok")),
          "session_start must flush the pre-bind queue",
        );
        discardWorkflowRuntime();
        _resetDeliveryRegistriesForTests();
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("keeps the manager when session_start spells the same project differently (Windows)", {
    skip: process.platform !== "win32" && "only Windows has case-insensitive spellings of one directory",
  }, async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-samecwd-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime();
        const { default: installExtension } = await import("../src/pi-extension.js");
        const first = fakeExtensionHost();
        installExtension(first.pi);
        first.handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const factoryRuntime = takeWorkflowRuntime();
        assert.ok(factoryRuntime);
        handoffWorkflowRuntime(factoryRuntime);

        const second = fakeExtensionHost();
        installExtension(second.pi);
        const cwd = resolve(process.cwd());
        const otherSpelling = cwd === cwd.toUpperCase() ? cwd.toLowerCase() : cwd.toUpperCase();
        second.handlers.session_start?.[0]?.(
          { reason: "reload" },
          sessionStartContext("same-project-session", { cwd: otherSpelling }),
        );
        second.handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const kept = claimWorkflowRuntime().compatible;
        assert.equal(
          kept?.manager,
          factoryRuntime.manager,
          "another spelling of the same project is not a project switch",
        );
        if (kept) handoffWorkflowRuntime(kept);
        discardWorkflowRuntime();
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("hands off on resume and fork into another spelling of the same project (Windows)", {
    skip: process.platform !== "win32" && "only Windows has case-insensitive spellings of one directory",
  }, async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-alias-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-dw-session-alias-"));
    const parent = mkdtempSync(join(tmpdir(), "pi-dw-alias-project-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        const { default: installExtension } = await import("../src/pi-extension.js");
        const { WorkflowManager } = await import("../src/workflow-manager.js");
        const project = join(realpathSync.native(parent), "MixedCase");
        mkdirSync(project);
        const spellings = {
          lower: project.toLowerCase(),
          upper: project.toUpperCase(),
          lowerDrive: project[0].toLowerCase() + project.slice(1),
          slashes: project.replaceAll("\\", "/"),
          extendedLength: `\\\\?\\${project}`,
        };

        for (const reason of ["resume", "fork"] as const) {
          for (const [name, spelling] of Object.entries(spellings)) {
            discardWorkflowRuntime();
            const manager = new WorkflowManager({ cwd: project });
            const paused: string[] = [];
            manager.listLiveRuns = (() => [{ runId: name, status: "running" }]) as typeof manager.listLiveRuns;
            manager.pause = ((id: string) => {
              paused.push(id);
              return true;
            }) as typeof manager.pause;
            handoffWorkflowRuntime({ cwd: project, extensionBuild: WORKFLOW_EXTENSION_BUILD, manager });

            const { pi, handlers } = fakeExtensionHost();
            installExtension(pi);

            const target = join(sessionDir, `${reason}-${name}.jsonl`);
            writeFileSync(
              target,
              `${JSON.stringify({ type: "session", id: name, cwd: spelling, timestamp: new Date().toISOString() })}\n`,
            );
            handlers.session_shutdown?.[0]?.({ reason, targetSessionFile: target });

            const label = `${reason} into ${name} spelling`;
            assert.deepEqual(paused, [], `${label} must keep the live run running`);
            assert.equal(takeWorkflowRuntime()?.manager, manager, `${label} must hand off the live manager`);
          }
        }
        discardWorkflowRuntime();
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("a switch to another project releases the delivery of the session the old manager served", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-release-"));
    const otherProject = mkdtempSync(join(tmpdir(), "pi-dw-other-project-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime();
        const { default: installExtension } = await import("../src/pi-extension.js");
        const { _getSessionDeliveryEndpointForTests } = await import("../src/task-panel.js");

        const first = fakeExtensionHost();
        installExtension(first.pi);
        first.handlers.session_start?.[0]?.({ reason: "startup" }, sessionStartContext("home-session"));
        assert.ok(_getSessionDeliveryEndpointForTests("home-session"), "the first session is bound");
        first.handlers.session_shutdown?.[0]?.({ reason: "new" });

        const second = fakeExtensionHost();
        installExtension(second.pi);
        second.handlers.session_start?.[0]?.(
          { reason: "new" },
          sessionStartContext("other-session", { cwd: otherProject }),
        );
        assert.equal(
          _getSessionDeliveryEndpointForTests("home-session"),
          undefined,
          "the session of the replaced manager no longer holds a delivery endpoint",
        );
        second.handlers.session_shutdown?.[0]?.({ reason: "quit" });
        discardWorkflowRuntime();
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it("rebuilds the manager when session_start ctx.cwd differs from factory cwd", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-crosscwd-"));
    const otherProject = mkdtempSync(join(tmpdir(), "pi-dw-other-project-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime();
        const { pi, handlers, activeTools } = fakeExtensionHost({ activeTools: ["bash", "read"] });
        const { default: installExtension } = await import("../src/pi-extension.js");
        installExtension(pi);

        handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const factoryRuntime = takeWorkflowRuntime();
        assert.ok(factoryRuntime);
        const factoryManager = factoryRuntime.manager;
        assert.equal(resolve(factoryManager.getCwd()), resolve(process.cwd()));
        handoffWorkflowRuntime(factoryRuntime);

        const { pi: pi2, handlers: handlers2 } = fakeExtensionHost({ activeTools });
        installExtension(pi2);

        handlers2.session_start?.[0]?.(
          { reason: "resume" },
          sessionStartContext("foreign-session", { cwd: otherProject }),
        );

        handlers2.session_shutdown?.[0]?.({ reason: "reload" });
        // Process-wide slot: claimable via process.cwd() even though the manager
        // owns otherProject. Next factory (which only knows process.cwd()) must
        // receive the same manager.
        const rebuilt = claimWorkflowRuntime().compatible;
        assert.ok(rebuilt, "rebuilt runtime must be claimable via process.cwd() (factory path)");
        assert.equal(resolve(rebuilt.manager.getCwd()), resolve(otherProject));
        assert.notEqual(rebuilt.manager, factoryManager, "must not keep the source-project manager");
        // Round-trip: a third factory install must adopt the claimed manager.
        handoffWorkflowRuntime(rebuilt);
        const { pi: pi3, handlers: handlers3 } = fakeExtensionHost({ activeTools });
        installExtension(pi3);
        handlers3.session_start?.[0]?.(
          { reason: "reload" },
          sessionStartContext("foreign-session-2", { cwd: otherProject }),
        );
        handlers3.session_shutdown?.[0]?.({ reason: "reload" });
        const again = claimWorkflowRuntime().compatible;
        assert.ok(again);
        assert.equal(again.manager, rebuilt.manager, "round-trip reload must keep the same live manager");
        discardWorkflowRuntime();
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it("pauses in-flight runs and discards on quit/unknown shutdown (nothing will claim)", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-quit-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime();
        {
          const { handlers, paused } = await installWithLiveRun("shutdown-unknown");
          handlers.session_shutdown?.[0]?.();
          assert.deepEqual(paused, ["shutdown-unknown"], "missing shutdown reason must pause the live run");
          assert.equal(takeWorkflowRuntime(), undefined, "session_shutdown with no reason must not stage a handoff");
        }
        {
          const { handlers, paused } = await installWithLiveRun("shutdown-quit");
          handlers.session_shutdown?.[0]?.({ reason: "quit" });
          assert.deepEqual(paused, ["shutdown-quit"], "quit must pause the live run before process teardown");
          assert.equal(
            takeWorkflowRuntime(),
            undefined,
            "session_shutdown(quit) must not stage a handoff — process is exiting",
          );
        }
        {
          const { handlers, paused } = await installWithLiveRun("shutdown-manual");
          handlers.session_shutdown?.[0]?.({ reason: "manual" });
          assert.deepEqual(paused, ["shutdown-manual"], "unknown shutdown reasons must pause the live run");
          assert.equal(takeWorkflowRuntime(), undefined, "unknown shutdown reasons must not stage a handoff");
        }
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("sessionFileCwd (read-only header probe)", () => {
  it("reads cwd from the session header without creating sidecars", async () => {
    const { sessionFileCwd } = await import("../src/pi-extension.js");
    const dir = mkdtempSync(join(tmpdir(), "pi-dw-session-probe-"));
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(
        file,
        JSON.stringify({
          type: "session",
          id: "abc",
          cwd: "/tmp/target-project",
          timestamp: new Date().toISOString(),
        }) +
          "\n" +
          JSON.stringify({ type: "message", role: "user", content: "hi" }) +
          "\n",
      );
      const before = new Set(readdirSync(dir));
      assert.equal(sessionFileCwd(file), resolve("/tmp/target-project"));
      const after = new Set(readdirSync(dir));
      assert.deepEqual([...after].sort(), [...before].sort(), "probe must not create files or dirs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for missing, empty, or non-session files", async () => {
    const { sessionFileCwd } = await import("../src/pi-extension.js");
    assert.equal(sessionFileCwd(undefined), undefined);
    assert.equal(sessionFileCwd("/no/such/file.jsonl"), undefined);
    const dir = mkdtempSync(join(tmpdir(), "pi-dw-session-probe-bad-"));
    try {
      const empty = join(dir, "empty.jsonl");
      writeFileSync(empty, "");
      assert.equal(sessionFileCwd(empty), undefined);
      const other = join(dir, "other.jsonl");
      writeFileSync(other, `${JSON.stringify({ type: "message", role: "user" })}\n`);
      assert.equal(sessionFileCwd(other), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

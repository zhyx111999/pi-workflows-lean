/**
 * Tests for the extension entry point: tool and command registration, the
 * parent-prompt hooks, and live-runtime handoff across session replacement.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  takeWorkflowRuntime,
} from "../src/extension-reload.js";
import { PARENT_PROMPT_MESSAGE_TYPE, PARENT_WORKFLOW_PROMPT } from "../src/parent-prompt.js";
import { useHostSessionClass } from "../src/task-panel/host-session-capture.js";
import { _resetDeliveryRegistriesForTests } from "../src/task-panel.js";
import { getWorkflowSettingsPath } from "../src/workflow-settings.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { FakeHostSession, type HostMessage, sendMessageTo } from "./helpers/fake-host-session.js";

describe("workflow extension - tool availability", () => {
  it("registers exactly the two subagents tools and hands the live runtime across reload", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime();
        const registeredTools: string[] = [];
        const registeredCommands: string[] = [];
        const activeTools = ["bash", "read"];
        const handlers: Record<string, Array<(...args: any[]) => any>> = {};
        const pi = {
          registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
          registerCommand: (name: string) => registeredCommands.push(name),
          getCommands: () => registeredCommands.map((name) => ({ name })),
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: () => {},
        } as unknown as ExtensionAPI;
        const { default: installExtension } = await import("../src/pi-extension.js");

        installExtension(pi);

        assert.deepEqual(registeredTools, ["subagents", "subagents_control"]);
        assert.deepEqual(registeredCommands.sort(), [
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
        handlers.session_start[0](
          {},
          {
            cwd: process.cwd(),
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "session-1" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );

        assert.deepEqual(activeTools, ["bash", "read", "subagents", "subagents_control"]);
        assert.equal(handlers.input.length, 1, "session_start does not add another input hook");
        assert.equal(handlers.before_agent_start.length, 1, "session_start does not add another start hook");

        handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const staged = takeWorkflowRuntime();
        assert.ok(staged, "session_shutdown(reload) stages the live manager for the next extension generation");
        handoffWorkflowRuntime(staged);

        const secondHandlers: Record<string, Array<(...args: any[]) => any>> = {};
        const secondPi = {
          registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!secondHandlers[event]) secondHandlers[event] = [];
            secondHandlers[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: () => {},
        } as unknown as ExtensionAPI;
        installExtension(secondPi);
        assert.equal(takeWorkflowRuntime(), undefined, "the fresh factory consumes the staged runtime");

        secondHandlers.session_start?.[0]?.(
          { reason: "reload" },
          {
            cwd: process.cwd(),
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "session-2" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );

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
        const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
        const sent: string[] = [];
        const handlers: Record<string, Array<(...args: any[]) => any>> = {};
        const pi = {
          registerTool: () => {},
          registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
            commands.set(name, spec.handler);
          },
          getCommands: () => [...commands.keys()].map((name) => ({ name })),
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(handler);
          },
          getActiveTools: () => [],
          setActiveTools: () => {},
          sendMessage: (message: { content?: string }) => {
            sent.push(message.content ?? "");
          },
        } as unknown as ExtensionAPI;
        const { default: installExtension } = await import("../src/pi-extension.js");

        installExtension(pi);
        handlers.session_start[0](
          {},
          {
            cwd: process.cwd(),
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "legacy-settings-session" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );

        assert.equal(commands.has("workflows-trigger"), false);
        await commands.get("workflows-progress")?.("status", {});
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

          const activeTools = ["bash", "read"];
          const handlers: Record<string, Array<(...args: any[]) => any>> = {};
          const pi = {
            registerTool: () => {},
            registerCommand: () => {},
            getCommands: () => [],
            on: (eventName: string, handler: (...args: any[]) => any) => {
              if (!handlers[eventName]) handlers[eventName] = [];
              handlers[eventName].push(handler);
            },
            getActiveTools: () => [...activeTools],
            setActiveTools: (tools: string[]) => {
              activeTools.splice(0, activeTools.length, ...tools);
            },
            sendMessage: () => {},
          } as unknown as ExtensionAPI;
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
          const secondHandlers: Record<string, Array<(...args: any[]) => any>> = {};
          const secondPi = {
            registerTool: () => {},
            registerCommand: () => {},
            getCommands: () => [],
            on: (eventName: string, handler: (...args: any[]) => any) => {
              if (!secondHandlers[eventName]) secondHandlers[eventName] = [];
              secondHandlers[eventName].push(handler);
            },
            getActiveTools: () => [...activeTools],
            setActiveTools: (tools: string[]) => {
              activeTools.splice(0, activeTools.length, ...tools);
            },
            sendMessage: sendMessageTo(hostSession),
          } as unknown as ExtensionAPI;
          installExtension(secondPi);
          assert.equal(takeWorkflowRuntime(), undefined, "second generation claims the staged runtime");

          secondHandlers.session_start?.[0]?.(
            { reason },
            {
              cwd: process.cwd(),
              model: undefined,
              modelRegistry: {},
              sessionManager: {
                getSessionId: () => `session-${reason}`,
              },
              ui: { setWidget: () => {}, notify: () => {} },
            },
          );

          const fakeRun = {
            runId: "bg-1",
            sessionId: `session-${reason}`,
            snapshot: { name: "t", agentCount: 0 },
            result: { agentCount: 0, result: { verdict: `ok-${reason}` } },
          };
          const origGet = staged.manager.getRun.bind(staged.manager);
          (staged.manager as { getRun: (id: string) => unknown }).getRun = (id: string) =>
            id === "bg-1" ? fakeRun : origGet(id);
          staged.manager.emit("complete", { runId: "bg-1" });
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
        const { default: installExtension } = await import("../src/pi-extension.js");
        const makePi = (handlers: Record<string, Array<(...args: any[]) => any>>) =>
          ({
            registerTool: () => {},
            registerCommand: () => {},
            getCommands: () => [],
            on: (event: string, handler: (...args: any[]) => any) => {
              if (!handlers[event]) handlers[event] = [];
              handlers[event].push(handler);
            },
            getActiveTools: () => ["bash"],
            setActiveTools: () => {},
            sendMessage: () => {},
          }) as unknown as ExtensionAPI;

        const installWithLiveRun = (runId: string) => {
          discardWorkflowRuntime();
          const seedHandlers: Record<string, Array<(...args: any[]) => any>> = {};
          installExtension(makePi(seedHandlers));
          seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
          const staged = takeWorkflowRuntime();
          assert.ok(staged, "seed reload must expose the manager for live-run injection");

          const paused: string[] = [];
          staged.manager.listLiveRuns = (() => [{ runId, status: "running" }]) as typeof staged.manager.listLiveRuns;
          staged.manager.pause = ((id: string) => {
            paused.push(id);
            return true;
          }) as typeof staged.manager.pause;
          handoffWorkflowRuntime(staged);

          const handlers: Record<string, Array<(...args: any[]) => any>> = {};
          installExtension(makePi(handlers));
          return { handlers, paused };
        };

        // resume + no targetSessionFile → discard
        {
          const { handlers, paused } = installWithLiveRun("resume-no-target");
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
          const { handlers, paused } = installWithLiveRun("resume-missing-header");
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
          const { handlers, paused } = installWithLiveRun("resume-foreign-cwd");
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
          const { handlers, paused } = installWithLiveRun("resume-same-cwd");
          handlers.session_shutdown?.[0]?.({ reason: "resume", targetSessionFile: same });
          assert.deepEqual(paused, [], "same-project resume must keep the live run running");
          const staged = takeWorkflowRuntime();
          assert.ok(staged, "resume with readable same-cwd header must hand off");
          discardWorkflowRuntime();
        }

        // fork without a session file still hands off (new fork file may not exist yet)
        {
          const { handlers, paused } = installWithLiveRun("fork-no-target");
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
          const { handlers, paused } = installWithLiveRun("fork-foreign-cwd");
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
          location: "project",
        });
        createWorkflowStorage(otherProject).save({
          name: "same",
          description: "from-B",
          script: "export TARGET_B",
          location: "project",
        });

        discardWorkflowRuntime();
        discardWorkflowRuntime();

        const commands: Array<{
          name: string;
          description?: string;
          handler: (args: string, ctx: unknown) => unknown;
        }> = [];
        const handlers: Record<string, Array<(...args: any[]) => any>> = {};
        const pi = {
          registerTool: () => {},
          registerCommand: (
            name: string,
            spec: { description?: string; handler: (args: string, ctx: unknown) => unknown },
          ) => {
            commands.push({ name, description: spec.description, handler: spec.handler });
          },
          getCommands: () => commands.map((c) => ({ name: c.name, description: c.description })),
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(handler);
          },
          getActiveTools: () => ["bash"],
          setActiveTools: () => {},
          sendMessage: () => {},
        } as unknown as ExtensionAPI;

        const { default: installExtension } = await import("../src/pi-extension.js");
        installExtension(pi);

        assert.equal(
          commands.some((c) => c.name === "same"),
          false,
          "factory must not register project saved commands before session_start",
        );

        handlers.session_start?.[0]?.(
          { reason: "resume" },
          {
            cwd: otherProject,
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "session-b" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );

        const savedCmd = commands.find((c) => c.name === "same");
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
          const activeTools = ["bash", "read"];
          const handlers: Record<string, Array<(...args: any[]) => any>> = {};
          const pi = {
            registerTool: () => {},
            registerCommand: () => {},
            getCommands: () => [],
            on: (event: string, handler: (...args: any[]) => any) => {
              if (!handlers[event]) handlers[event] = [];
              handlers[event].push(handler);
            },
            getActiveTools: () => [...activeTools],
            setActiveTools: (tools: string[]) => {
              activeTools.splice(0, activeTools.length, ...tools);
            },
            sendMessage: () => {},
          } as unknown as ExtensionAPI;
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
        const activeTools = ["bash", "read"];
        const handlers: Record<string, Array<(...args: any[]) => any>> = {};
        useHostSessionClass(FakeHostSession);
        const hostSession = new FakeHostSession("s-prebind");
        const delivered = () => hostSession.received.map(({ message }) => message.content);
        const pi = {
          registerTool: () => {},
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: (msg: HostMessage, options?: unknown) => {
            if (!(pi as { _bound?: boolean })._bound) {
              throw new Error("Extension runtime not initialized");
            }
            sendMessageTo(hostSession)(msg, options);
          },
          _bound: false,
        } as unknown as ExtensionAPI & { _bound: boolean };
        const { default: installExtension } = await import("../src/pi-extension.js");
        installExtension(pi);

        handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const staged = takeWorkflowRuntime();
        assert.ok(staged);
        handoffWorkflowRuntime(staged);

        const handlers2: Record<string, Array<(...args: any[]) => any>> = {};
        const pi2 = {
          registerTool: () => {},
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers2[event]) handlers2[event] = [];
            handlers2[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: (msg: HostMessage, options?: unknown) => {
            if (!(pi2 as { _bound?: boolean })._bound) {
              throw new Error("Extension runtime not initialized");
            }
            sendMessageTo(hostSession)(msg, options);
          },
          _bound: false,
        } as unknown as ExtensionAPI & { _bound: boolean };
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

        pi2._bound = true;
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
        const piFor = (handlers: Record<string, Array<(...args: any[]) => any>>) =>
          ({
            registerTool: () => {},
            registerCommand: () => {},
            getCommands: () => [],
            on: (event: string, handler: (...args: any[]) => any) => {
              if (!handlers[event]) handlers[event] = [];
              handlers[event].push(handler);
            },
            getActiveTools: () => [],
            setActiveTools: () => {},
            sendMessage: () => {},
          }) as unknown as ExtensionAPI;
        const { default: installExtension } = await import("../src/pi-extension.js");
        const first: Record<string, Array<(...args: any[]) => any>> = {};
        installExtension(piFor(first));
        first.session_shutdown?.[0]?.({ reason: "reload" });
        const factoryRuntime = takeWorkflowRuntime();
        assert.ok(factoryRuntime);
        handoffWorkflowRuntime(factoryRuntime);

        const second: Record<string, Array<(...args: any[]) => any>> = {};
        installExtension(piFor(second));
        const cwd = resolve(process.cwd());
        const otherSpelling = cwd === cwd.toUpperCase() ? cwd.toLowerCase() : cwd.toUpperCase();
        second.session_start?.[0]?.(
          { reason: "reload" },
          {
            cwd: otherSpelling,
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "same-project-session" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
        );
        second.session_shutdown?.[0]?.({ reason: "reload" });
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

  it("rebuilds the manager when session_start ctx.cwd differs from factory cwd", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-control-extension-crosscwd-"));
    const otherProject = mkdtempSync(join(tmpdir(), "pi-dw-other-project-"));
    try {
      await withFakeHomeAsync(fakeHome, async () => {
        discardWorkflowRuntime();
        const activeTools = ["bash", "read"];
        const handlers: Record<string, Array<(...args: any[]) => any>> = {};
        const pi = {
          registerTool: () => {},
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: () => {},
        } as unknown as ExtensionAPI;
        const { default: installExtension } = await import("../src/pi-extension.js");
        installExtension(pi);

        handlers.session_shutdown?.[0]?.({ reason: "reload" });
        const factoryRuntime = takeWorkflowRuntime();
        assert.ok(factoryRuntime);
        const factoryManager = factoryRuntime.manager;
        assert.equal(resolve(factoryManager.getCwd()), resolve(process.cwd()));
        handoffWorkflowRuntime(factoryRuntime);

        const handlers2: Record<string, Array<(...args: any[]) => any>> = {};
        const pi2 = {
          registerTool: () => {},
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers2[event]) handlers2[event] = [];
            handlers2[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: () => {},
        } as unknown as ExtensionAPI;
        installExtension(pi2);

        handlers2.session_start?.[0]?.(
          { reason: "resume" },
          {
            cwd: otherProject,
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "foreign-session" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
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
        const handlers3: Record<string, Array<(...args: any[]) => any>> = {};
        const pi3 = {
          registerTool: () => {},
          registerCommand: () => {},
          getCommands: () => [],
          on: (event: string, handler: (...args: any[]) => any) => {
            if (!handlers3[event]) handlers3[event] = [];
            handlers3[event].push(handler);
          },
          getActiveTools: () => [...activeTools],
          setActiveTools: (tools: string[]) => {
            activeTools.splice(0, activeTools.length, ...tools);
          },
          sendMessage: () => {},
        } as unknown as ExtensionAPI;
        installExtension(pi3);
        handlers3.session_start?.[0]?.(
          { reason: "reload" },
          {
            cwd: otherProject,
            model: undefined,
            modelRegistry: {},
            sessionManager: { getSessionId: () => "foreign-session-2" },
            ui: { setWidget: () => {}, notify: () => {} },
          },
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
        const activeTools = ["bash", "read"];
        const makePi = (handlers: Record<string, Array<(...args: any[]) => any>>) =>
          ({
            registerTool: () => {},
            registerCommand: () => {},
            getCommands: () => [],
            on: (event: string, handler: (...args: any[]) => any) => {
              if (!handlers[event]) handlers[event] = [];
              handlers[event].push(handler);
            },
            getActiveTools: () => [...activeTools],
            setActiveTools: (tools: string[]) => {
              activeTools.splice(0, activeTools.length, ...tools);
            },
            sendMessage: () => {},
          }) as unknown as ExtensionAPI;
        const { default: installExtension } = await import("../src/pi-extension.js");

        const installWithLiveRun = (runId: string) => {
          discardWorkflowRuntime();
          const seedHandlers: Record<string, Array<(...args: any[]) => any>> = {};
          installExtension(makePi(seedHandlers));
          seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
          const staged = takeWorkflowRuntime();
          assert.ok(staged, "seed reload must expose the manager for live-run injection");

          const paused: string[] = [];
          staged.manager.listLiveRuns = (() => [{ runId, status: "running" }]) as typeof staged.manager.listLiveRuns;
          staged.manager.pause = ((id: string) => {
            paused.push(id);
            return true;
          }) as typeof staged.manager.pause;
          handoffWorkflowRuntime(staged);

          const handlers: Record<string, Array<(...args: any[]) => any>> = {};
          installExtension(makePi(handlers));
          return { handlers, paused };
        };

        {
          const { handlers, paused } = installWithLiveRun("shutdown-unknown");
          handlers.session_shutdown?.[0]?.();
          assert.deepEqual(paused, ["shutdown-unknown"], "missing shutdown reason must pause the live run");
          assert.equal(takeWorkflowRuntime(), undefined, "session_shutdown with no reason must not stage a handoff");
        }
        {
          const { handlers, paused } = installWithLiveRun("shutdown-quit");
          handlers.session_shutdown?.[0]?.({ reason: "quit" });
          assert.deepEqual(paused, ["shutdown-quit"], "quit must pause the live run before process teardown");
          assert.equal(
            takeWorkflowRuntime(),
            undefined,
            "session_shutdown(quit) must not stage a handoff — process is exiting",
          );
        }
        {
          const { handlers, paused } = installWithLiveRun("shutdown-manual");
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

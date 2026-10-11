/**
 * Shared test doubles for the Pi ExtensionAPI surface that command-registration
 * code touches (getCommands / registerCommand) plus a notify-capturing command
 * context. Centralising these removes the copy-pasted `pi: any` mocks and the
 * per-test `as never` casts across the command test files.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface RegisteredCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => unknown;
}

export interface CommandRegistryPi {
  /** Typed as ExtensionAPI for call sites; backed by the in-memory registry. */
  pi: ExtensionAPI;
  /** Commands registered so far (most code registers, then we inspect/invoke). */
  commands: RegisteredCommand[];
  /** Messages delivered via pi.sendMessage, captured for assertions. */
  sent: Array<{ customType?: string; content?: string }>;
}

/**
 * A Pi mock that records registered commands and sent messages.
 *
 * @param existing - command names to pretend are already registered, so
 *   idempotency guards (isRegistered) can be exercised.
 */
export function makeCommandRegistryPi(existing: string[] = []): CommandRegistryPi {
  const commands: RegisteredCommand[] = [];
  const sent: Array<{ customType?: string; content?: string }> = [];
  const names = () => [...existing, ...commands.map((c) => c.name)];

  const pi = {
    getCommands: () => names().map((name) => ({ name })),
    registerCommand: (name: string, spec: Omit<RegisteredCommand, "name">) => {
      commands.push({ name, ...spec });
    },
    sendMessage: (msg: { customType?: string; content?: string }) => {
      sent.push(msg);
    },
  } as unknown as ExtensionAPI;

  return { pi, commands, sent };
}

export interface NotifyCtx {
  ctx: ExtensionCommandContext;
  notified: Array<{ message: string; type?: string }>;
}

/** A command context that captures ui.notify calls and no-ops the rest. */
export function makeNotifyCtx(mode?: "tui" | "rpc" | "json" | "print"): NotifyCtx {
  const notified: Array<{ message: string; type?: string }> = [];
  const ctx = {
    ...(mode ? { mode, hasUI: mode === "tui" || mode === "rpc" } : {}),
    ui: {
      notify: (message: string, type?: string) => notified.push({ message, type }),
      setStatus: () => {},
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notified };
}

/** A registered command as the extension host keeps it. */
export interface HostCommand {
  description?: string;
  handler: (args: string, ctx: unknown) => unknown;
}

/** An extension host double that records what one extension generation registers. */
export interface FakeExtensionHost {
  pi: ExtensionAPI;
  /** Tool names passed to registerTool, in order. */
  tools: string[];
  /** Registered commands by name, in registration order. */
  commands: Map<string, HostCommand>;
  /** Event handlers by event name, in registration order. */
  handlers: Record<string, Array<(...args: any[]) => any>>;
  /** The session's active tools; setActiveTools replaces the array's contents, so generations can share it. */
  activeTools: string[];
}

/**
 * A fresh ExtensionAPI for one extension generation. `sendMessage` stands in
 * for the host's delivery path (a no-op by default); `tools` and `activeTools`
 * may be shared with another generation.
 */
export function fakeExtensionHost(
  options: {
    activeTools?: string[];
    tools?: string[];
    sendMessage?: (message: never, options?: never) => unknown;
  } = {},
): FakeExtensionHost {
  const tools = options.tools ?? [];
  const activeTools = options.activeTools ?? [];
  const commands = new Map<string, HostCommand>();
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  const pi = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: (name: string, spec: HostCommand) => commands.set(name, spec),
    getCommands: () => [...commands].map(([name, { description }]) => ({ name, description })),
    on: (event: string, handler: (...args: any[]) => any) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools.splice(0, activeTools.length, ...names);
    },
    sendMessage: options.sendMessage ?? (() => {}),
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, handlers, activeTools };
}

/** The session_start context the extension reads, for a session with `sessionId`. */
export function sessionStartContext(
  sessionId: string | undefined,
  overrides: { cwd?: string; sessionFile?: string; ui?: Record<string, unknown> } = {},
) {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    model: undefined,
    modelRegistry: {},
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => overrides.sessionFile },
    ui: { setWidget: () => {}, notify: () => {}, ...overrides.ui },
  };
}

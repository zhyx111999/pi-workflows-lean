import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export type CommandOwner = "builtin" | "saved";
export declare function isCommandRegistered(pi: ExtensionAPI, name: string): boolean;
export declare function commandOwner(pi: ExtensionAPI, name: string): CommandOwner | undefined;
/** Claim a command only after this extension has successfully registered it. */
export declare function claimCommand(pi: ExtensionAPI, name: string, owner: CommandOwner): boolean;

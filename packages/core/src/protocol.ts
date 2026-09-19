import type { Deck } from "./schema.js";

export const PROTOCOL_VERSION = 2 as const;

export type HostToWebviewMessage =
  | { version: 2; type: "deck"; text: string; deck: Deck; revision: string; uri: string; linkedUri: string }
  | { version: 2; type: "invalidDeck"; text: string; revision: string; message: string; gitConflict: boolean; uri: string; linkedUri: string }
  | { version: 2; type: "documentEditResult"; requestId: string; accepted: boolean; revision: string; text: string; deck?: Deck; reason?: "stale" | "invalid" | "applyFailed"; message?: string }
  | { version: 2; type: "historyResult"; requestId: string; command: "undo" | "redo"; ok: boolean; revision: string; text: string; deck?: Deck; error?: string }
  | { version: 2; type: "assetImported"; requestId: string; reference?: string; storage?: "embedded" | "linked"; error?: string }
  | { version: 2; type: "fontSelected"; requestId: string; family?: string; error?: string };

export type WebviewToHostMessage =
  | { version: 2; type: "ready" }
  | { version: 2; type: "replaceDocument"; requestId: string; baseRevision: string; text: string }
  | { version: 2; type: "history"; requestId: string; command: "undo" | "redo" }
  | { version: 2; type: "importAsset"; requestId: string; name: string; mime: string; base64: string }
  | { version: 2; type: "selectMedia"; requestId: string; kind: "image" | "video" }
  | { version: 2; type: "linkMedia"; requestId: string; kind: "image" | "video"; uri: string }
  | { version: 2; type: "embedMedia"; elementIds?: string[] }
  | { version: 2; type: "selectFont"; requestId: string; current: string }
  | { version: 2; type: "command"; command: "undo" | "redo" | "save" | "exportPdf" | "exportPng" | "exportPptx" | "exportWeb" | "present" | "presenter" | "configureMcp" | "resolveGitConflict" | "openTextEditor"; slideIds?: string[] };

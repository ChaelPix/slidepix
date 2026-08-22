import type { Deck } from "./schema.js";

export const PROTOCOL_VERSION = 1 as const;

export type HostToWebviewMessage =
  | { version: 1; type: "deck"; text: string; deck: Deck; uri: string }
  | { version: 1; type: "invalidDeck"; text: string; message: string; uri: string }
  | { version: 1; type: "assetImported"; requestId: string; reference?: string; error?: string };

export type WebviewToHostMessage =
  | { version: 1; type: "ready" }
  | { version: 1; type: "replaceDocument"; text: string }
  | { version: 1; type: "importAsset"; requestId: string; name: string; mime: string; base64: string }
  | { version: 1; type: "command"; command: "save" | "exportPdf" | "exportPng" | "present" | "presenter" | "configureMcp"; slideIds?: string[] };

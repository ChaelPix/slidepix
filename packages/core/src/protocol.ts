import type { Deck } from "./schema.js";

export const PROTOCOL_VERSION = 1 as const;

export type HostToWebviewMessage =
  | { version: 1; type: "deck"; text: string; deck: Deck; uri: string; linkedUri: string }
  | { version: 1; type: "invalidDeck"; text: string; message: string; uri: string; linkedUri: string }
  | { version: 1; type: "assetImported"; requestId: string; reference?: string; storage?: "embedded" | "linked"; error?: string };

export type WebviewToHostMessage =
  | { version: 1; type: "ready" }
  | { version: 1; type: "replaceDocument"; text: string }
  | { version: 1; type: "importAsset"; requestId: string; name: string; mime: string; base64: string }
  | { version: 1; type: "selectMedia"; requestId: string; kind: "image" | "video" }
  | { version: 1; type: "linkMedia"; requestId: string; kind: "image" | "video"; uri: string }
  | { version: 1; type: "embedMedia"; elementIds?: string[] }
  | { version: 1; type: "command"; command: "save" | "exportPdf" | "exportPng" | "present" | "presenter" | "configureMcp"; slideIds?: string[] };

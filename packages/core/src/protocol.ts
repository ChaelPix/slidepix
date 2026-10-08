import type { Deck } from "./schema.js";

export const PROTOCOL_VERSION = 2 as const;

export type HostToWebviewMessage =
  | { version: 2; type: "deck"; text: string; deck: Deck; revision: string; uri: string; linkedUri: string; canUndo?: boolean; canRedo?: boolean }
  | { version: 2; type: "invalidDeck"; text: string; revision: string; message: string; gitConflict: boolean; uri: string; linkedUri: string }
  | { version: 2; type: "documentEditResult"; requestId: string; accepted: boolean; revision: string; text: string; deck?: Deck; reason?: "stale" | "invalid" | "applyFailed"; message?: string; canUndo?: boolean; canRedo?: boolean }
  | { version: 2; type: "historyResult"; requestId: string; command: "undo" | "redo"; ok: boolean; revision: string; text: string; deck?: Deck; error?: string; canUndo?: boolean; canRedo?: boolean }
  | { version: 2; type: "assetImported"; requestId: string; reference?: string; storage?: "embedded" | "linked"; error?: string }
  | { version: 2; type: "fontSelected"; requestId: string; family?: string; error?: string }
  | { version: 2; type: "manimScriptSelected"; requestId: string; script?: string; scenes?: string[]; error?: string }
  | { version: 2; type: "manimScriptCreated"; requestId: string; script?: string; scene?: string; scenes?: string[]; error?: string }
  | { version: 2; type: "manimScenesListed"; requestId: string; scenes?: string[]; contentFingerprint?: string; error?: string }
  | { version: 2; type: "manimRenderResult"; requestId: string; ok: boolean; elementId: string; settingsFingerprint?: string; error?: string }
  | { version: 2; type: "manimRenderAllResult"; requestId: string; ok: boolean; rendered: number; skipped: number; error?: string; results?: { elementId: string; settingsFingerprint: string }[] }
  | { version: 2; type: "notify"; notificationId: string; status: "progress" | "success" | "error" | "dismiss"; message?: string; progress?: number; elementId?: string; elementProgress?: number }
  | { version: 2; type: "collaboration"; status: LiveCollaborationStatus; role: "host" | "guest" | "none"; canEdit: boolean; hostName?: string; self?: LivePeer; peers: LivePeer[]; temporaryMirror?: boolean }
  | { version: 2; type: "assetsUpdated"; references: string[] };

export type LiveCollaborationStatus = "off" | "hosting" | "joined" | "reconnecting" | "ended";

export type LivePose = { id: string; x: number; y: number; width: number; height: number; rotation: number };

export type LivePeer = {
  id: string;
  name: string;
  color: string;
  slideId?: string;
  elementIds: string[];
  editingElementId?: string;
  preview?: { slideId: string; poses: LivePose[] };
};

export type WebviewToHostMessage =
  | { version: 2; type: "ready" }
  | { version: 2; type: "replaceDocument"; requestId: string; baseRevision: string; text: string }
  | { version: 2; type: "history"; requestId: string; command: "undo" | "redo" }
  | { version: 2; type: "importAsset"; requestId: string; name: string; mime: string; base64: string }
  | { version: 2; type: "selectMedia"; requestId: string; kind: "image" | "video" }
  | { version: 2; type: "linkMedia"; requestId: string; kind: "image" | "video"; uri: string }
  | { version: 2; type: "embedMedia"; elementIds?: string[] }
  | { version: 2; type: "selectFont"; requestId: string; current: string }
  | { version: 2; type: "selectManimScript"; requestId: string; elementId: string }
  | { version: 2; type: "createManimScript"; requestId: string; elementId: string }
  | { version: 2; type: "openManimScript"; script: string }
  | { version: 2; type: "listManimScenes"; requestId: string; script: string }
  | { version: 2; type: "renderManim"; requestId: string; elementId: string }
  | { version: 2; type: "renderAllManim"; requestId: string }
  | { version: 2; type: "setupManim" }
  | { version: 2; type: "presence"; slideId?: string; elementIds: string[]; editingElementId?: string; preview?: { slideId: string; poses: LivePose[] } }
  | { version: 2; type: "command"; command: "undo" | "redo" | "save" | "exportPdf" | "exportPng" | "exportPptx" | "exportWeb" | "present" | "presenter" | "configureMcp" | "resolveGitConflict" | "openTextEditor" | "startLive" | "copyLiveInvite" | "stopLive" | "saveLiveCopy"; slideIds?: string[]; requestId?: string }
  | { version: 2; type: "saveExport"; format: "pdf" | "png"; data: string }
  | { version: 2; type: "log"; level: "info" | "warn" | "error"; message: string };

import type { LivePose, WebviewToHostMessage } from "@slidepix/core";
import type * as vscode from "vscode";

export type LivePresence = Extract<WebviewToHostMessage, { type: "presence" }>;

export interface LiveDeckHost {
  locate(document: vscode.TextDocument): { deckPath: string; linkedRoots: string[] } | undefined;
  isGuest(document: vscode.TextDocument): boolean;
  canUseManim(document: vscode.TextDocument): boolean;
  start(document: vscode.TextDocument): Promise<void>;
  join(invite?: string): Promise<void>;
  copyInvite(document: vscode.TextDocument): Promise<void>;
  stop(document?: vscode.TextDocument): Promise<void>;
  saveCopy(document: vscode.TextDocument): Promise<void>;
  saveOnHost(document: vscode.TextDocument): Promise<void>;
  importAsset(document: vscode.TextDocument, bytes: Uint8Array, name: string, mime: string): Promise<{ reference: string; storage: "embedded" } | { error: string }>;
  embedOnHost(document: vscode.TextDocument, elementIds?: string[]): Promise<boolean>;
  presence(document: vscode.TextDocument, presence: LivePresence): void;
  ensureAssets(document: vscode.TextDocument): Promise<void>;
  announce(document: vscode.TextDocument): void;
  documentChanged(document: vscode.TextDocument): void;
  panelClosed(document: vscode.TextDocument): Promise<void>;
}

export type { LivePose };

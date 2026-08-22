import type { HostToWebviewMessage, WebviewToHostMessage } from "@slidepix/core";

type VsCodeApi = {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

const fallback: VsCodeApi = {
  postMessage: (message) => console.info("SlidePix host message", message),
  getState: () => undefined,
  setState: () => undefined
};

export const vscode = window.acquireVsCodeApi?.() ?? fallback;

type WithoutVersion<T> = T extends unknown ? Omit<T, "version"> : never;

export function postMessage(message: WithoutVersion<WebviewToHostMessage>): void {
  vscode.postMessage({ version: 1, ...message } as WebviewToHostMessage);
}

export function onHostMessage(handler: (message: HostToWebviewMessage) => void): () => void {
  const listener = (event: MessageEvent<HostToWebviewMessage>) => {
    if (event.data?.version === 1) handler(event.data);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

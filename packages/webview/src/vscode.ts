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

export const vscode = typeof window === "undefined" ? fallback : window.acquireVsCodeApi?.() ?? fallback;

type WithoutVersion<T> = T extends unknown ? Omit<T, "version"> : never;

export function postMessage(message: WithoutVersion<WebviewToHostMessage>): void {
  vscode.postMessage({ version: 2, ...message } as WebviewToHostMessage);
}

export function onHostMessage(handler: (message: HostToWebviewMessage) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: MessageEvent<HostToWebviewMessage>) => {
    if (event.data?.version === 2) handler(event.data);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

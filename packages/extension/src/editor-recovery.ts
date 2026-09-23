export type EditorRecoveryHost<Tab> = {
  isResolved(key: string): boolean;
  hasDocument(key: string): boolean;
  reopen(tab: Tab): Promise<void>;
  report(error: unknown): void;
};

export const EDITOR_RESOLVE_TIMEOUT_MS = 1500;
const RETRY_COOLDOWN_MS = 10_000;

/**
 * Cursor can hold a file's text model without synchronizing it to extensions.
 * The workbench then fails the custom editor before `resolveCustomTextEditor`
 * runs, so an active tab that never resolves and has no extension-side
 * document is reopened once after the host forces synchronization.
 */
export class EditorResolveRecovery<Tab> {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();

  constructor(private readonly host: EditorRecoveryHost<Tab>, private readonly timeoutMs = EDITOR_RESOLVE_TIMEOUT_MS, private readonly now = () => Date.now()) {}

  watch(key: string, tab: Tab): void {
    if (this.timers.has(key) || this.host.isResolved(key)) return;
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (this.host.isResolved(key) || this.host.hasDocument(key)) return;
      const last = this.attempts.get(key);
      if (last !== undefined && this.now() - last < RETRY_COOLDOWN_MS) return;
      this.attempts.set(key, this.now());
      this.host.reopen(tab).catch((error: unknown) => this.host.report(error));
    }, this.timeoutMs));
  }

  resolved(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.attempts.delete(key);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

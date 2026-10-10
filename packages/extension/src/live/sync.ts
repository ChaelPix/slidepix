import { mergeDecksLive, parseDeckText, type DeckMergeResolution } from "@slidepix/core";
import { LIVE_LIMITS } from "./limits";

export type LiveEdit = { requestId: string; baseRevision: string; text: string };

export type HostDecision =
  | { kind: "applied"; text: string }
  | { kind: "rebase"; revision: string; text: string }
  | { kind: "rejected"; reason: "invalid" | "conflict"; message: string; revision: string; text: string };

type Revision = { revision: string; text: string };

export class HostSequencer {
  private ring: Revision[] = [];
  private bytes = 0;

  constructor(private readonly revisionOf: (text: string) => string) {}

  remember(text: string): boolean {
    const revision = this.revisionOf(text);
    if (this.ring.at(-1)?.revision === revision) return false;
    this.ring.push({ revision, text });
    this.bytes += text.length;
    while (this.ring.length > LIVE_LIMITS.revisionRing || (this.bytes > LIVE_LIMITS.revisionRingBytes && this.ring.length > 1)) {
      const removed = this.ring.shift();
      if (removed) this.bytes -= removed.text.length;
    }
    return true;
  }

  knownTexts(): string[] {
    return this.ring.map((item) => item.text);
  }

  current(): Revision {
    const latest = this.ring.at(-1);
    if (!latest) throw new Error("Host sequencer has no deck.");
    return latest;
  }

  decide(edit: LiveEdit): HostDecision {
    const current = this.current();
    const incoming = parseDeckText(edit.text);
    if (!incoming.ok) {
      return { kind: "rejected", reason: "invalid", message: incoming.message, revision: current.revision, text: current.text };
    }
    const host = parseDeckText(current.text);
    if (!host.ok) {
      return { kind: "rejected", reason: "conflict", message: "The host deck is not a valid document right now.", revision: current.revision, text: current.text };
    }
    if (edit.baseRevision === current.revision) return { kind: "applied", text: edit.text };
    const baseEntry = [...this.ring].reverse().find((item) => item.revision === edit.baseRevision);
    if (!baseEntry) return { kind: "rebase", revision: current.revision, text: current.text };
    const base = parseDeckText(baseEntry.text);
    if (!base.ok) return { kind: "rebase", revision: current.revision, text: current.text };
    const merged = mergeDecksLive(base.deck, host.deck, incoming.deck, "theirs");
    if (!merged.ok || !merged.text) {
      const message = merged.conflicts[0]?.message ?? "The edit could not be merged.";
      return { kind: "rejected", reason: "conflict", message, revision: current.revision, text: current.text };
    }
    return { kind: "applied", text: merged.text };
  }
}

export type GuestStep = { documentText: string; edit?: LiveEdit; error?: string };

export class GuestSync {
  confirmedText: string;
  confirmedRevision: string;
  localText: string;
  inflight?: LiveEdit;

  constructor(text: string, private readonly revisionOf: (text: string) => string, private readonly requestId: () => string) {
    this.confirmedText = text;
    this.confirmedRevision = revisionOf(text);
    this.localText = text;
  }

  localEdit(text: string): LiveEdit | undefined {
    this.localText = text;
    return this.enqueue();
  }

  onState(revision: string, text: string): GuestStep {
    return this.adopt(revision, text, true);
  }

  onRebase(revision: string, text: string, requestId: string): GuestStep {
    if (this.inflight?.requestId !== requestId) return { documentText: this.localText };
    return this.adopt(revision, text, true);
  }

  onRejected(revision: string, text: string, message: string, requestId: string): GuestStep {
    if (this.inflight?.requestId !== requestId) return { documentText: this.localText };
    const sent = this.inflight?.text;
    const pending = this.localText;
    this.inflight = undefined;
    this.confirmedText = text;
    this.confirmedRevision = revision;
    if (!sent || pending === sent) {
      this.localText = text;
      return { documentText: text, error: message };
    }
    const merged = mergeDocument(sent, pending, text, "ours");
    if (!merged.ok) {
      this.localText = pending;
      return { documentText: pending, error: message };
    }
    this.localText = merged.text;
    return { documentText: merged.text, edit: this.enqueue(), error: message };
  }

  private adopt(revision: string, text: string, resend: boolean): GuestStep {
    const local = this.localText;
    this.inflight = undefined;
    if (local === this.confirmedText || local === text) {
      this.confirmedText = text;
      this.confirmedRevision = revision;
      this.localText = text;
      return { documentText: text };
    }
    const merged = mergeDocument(this.confirmedText, local, text, "ours");
    this.confirmedText = text;
    this.confirmedRevision = revision;
    if (!merged.ok) {
      this.localText = text;
      return { documentText: text, error: merged.error };
    }
    this.localText = merged.text;
    return { documentText: merged.text, edit: resend ? this.enqueue() : undefined, error: merged.text === text ? undefined : undefined };
  }

  private enqueue(): LiveEdit | undefined {
    if (this.inflight || this.localText === this.confirmedText) return undefined;
    this.inflight = { requestId: this.requestId(), baseRevision: this.confirmedRevision, text: this.localText };
    return this.inflight;
  }
}

function mergeDocument(
  baseText: string,
  oursText: string,
  theirsText: string,
  prefer: Exclude<DeckMergeResolution, "base">
): { ok: true; text: string } | { ok: false; error: string } {
  const base = parseDeckText(baseText);
  const ours = parseDeckText(oursText);
  const theirs = parseDeckText(theirsText);
  if (!base.ok || !ours.ok || !theirs.ok) return { ok: false, error: "The shared deck is not valid." };
  const merged = mergeDecksLive(base.deck, ours.deck, theirs.deck, prefer);
  if (!merged.ok || !merged.text) return { ok: false, error: merged.conflicts[0]?.message ?? "The shared edit could not be merged." };
  return { ok: true, text: merged.text };
}

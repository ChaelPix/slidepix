import { describe, expect, it } from "vitest";
import { createDeck, serializeDeck } from "@slidepix/core";
import { revisionForText } from "../document-revision";
import { GuestSync, HostSequencer } from "./sync";

describe("live sync", () => {
  it("converges three peers that edit at the same time", () => {
    const base = createDeck("Live");
    const text = serializeDeck(base);
    const host = new HostSequencer(revisionForText);
    host.remember(text);
    let ids = 0;
    const guest = (label: string) => new GuestSync(text, revisionForText, () => `${label}-${ids += 1}`);
    const left = guest("left");
    const right = guest("right");
    const leftDeck = structuredClone(base);
    leftDeck.slides[0]!.title = "Left";
    const rightDeck = structuredClone(base);
    rightDeck.slides[0]!.notes = "Right";
    const leftEdit = left.localEdit(serializeDeck(leftDeck));
    const rightEdit = right.localEdit(serializeDeck(rightDeck));
    expect(leftEdit && rightEdit).toBeTruthy();
    const first = host.decide(leftEdit!);
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") return;
    host.remember(first.text);
    const second = host.decide(rightEdit!);
    expect(second.kind).toBe("applied");
    if (second.kind !== "applied") return;
    host.remember(second.text);
    const published = host.current();
    const leftStep = left.onState(published.revision, published.text);
    const rightStep = right.onState(published.revision, published.text);
    expect(leftStep.documentText).toBe(published.text);
    expect(rightStep.documentText).toBe(published.text);
    expect(published.text).toContain("Left");
    expect(published.text).toContain("Right");
  });

  it("asks a guest to rebase when the base revision is unknown", () => {
    const host = new HostSequencer(revisionForText);
    host.remember(serializeDeck(createDeck("Live")));
    const decision = host.decide({ requestId: "1", baseRevision: "missing", text: serializeDeck(createDeck("Other")) });
    expect(decision.kind).toBe("rebase");
  });

  it("rejects an invalid edit and an invalid host document", () => {
    const host = new HostSequencer(revisionForText);
    const valid = serializeDeck(createDeck("Live"));
    host.remember(valid);
    expect(host.decide({ requestId: "1", baseRevision: revisionForText(valid), text: "{" }).kind).toBe("rejected");
    host.remember("{");
    const again = host.decide({ requestId: "2", baseRevision: revisionForText(valid), text: valid });
    expect(again.kind).toBe("rejected");
  });

  it("replays a local edit after the host sends a new base", () => {
    const base = createDeck("Live");
    const text = serializeDeck(base);
    const guest = new GuestSync(text, revisionForText, () => "req");
    const local = structuredClone(base);
    local.slides[0]!.title = "Mine";
    guest.localEdit(serializeDeck(local));
    const remote = structuredClone(base);
    remote.slides[0]!.notes = "Host";
    const step = guest.onRebase(revisionForText(serializeDeck(remote)), serializeDeck(remote));
    expect(step.documentText).toContain("Mine");
    expect(step.documentText).toContain("Host");
    expect(step.edit?.baseRevision).toBe(revisionForText(serializeDeck(remote)));
  });

  it("keeps a newer local edit when the in-flight edit is rejected", () => {
    const base = createDeck("Live");
    const text = serializeDeck(base);
    let count = 0;
    const guest = new GuestSync(text, revisionForText, () => `req-${count += 1}`);
    const sent = structuredClone(base);
    sent.slides[0]!.title = "Sent";
    guest.localEdit(serializeDeck(sent));
    const newer = structuredClone(sent);
    newer.slides[0]!.notes = "Newer";
    expect(guest.localEdit(serializeDeck(newer))).toBeUndefined();
    const step = guest.onRejected(revisionForText(text), text, "conflict");
    expect(step.error).toBe("conflict");
    expect(step.documentText).toContain("Newer");
    expect(step.documentText).not.toContain("Sent");
    expect(step.edit?.text).toContain("Newer");
    expect(step.edit?.baseRevision).toBe(revisionForText(text));
  });

  it("adopts the host text when the rejected edit is still the latest local text", () => {
    const base = createDeck("Live");
    const text = serializeDeck(base);
    const guest = new GuestSync(text, revisionForText, () => "req");
    const sent = structuredClone(base);
    sent.slides[0]!.title = "Sent";
    guest.localEdit(serializeDeck(sent));
    const step = guest.onRejected(revisionForText(text), text, "conflict");
    expect(step.documentText).toBe(text);
    expect(step.edit).toBeUndefined();
  });
});

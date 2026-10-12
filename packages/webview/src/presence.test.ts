import { describe, expect, it } from "vitest";
import { createDeck, type Deck, type LivePeer } from "@slidepix/core";
import { ghostPoses, localPreview, peerMarks, shouldSendPresence, textLockHolder } from "./presence";

function peer(patch: Partial<LivePeer> & Pick<LivePeer, "id">): LivePeer {
  return { name: patch.id, color: "#e85d4c", elementIds: [], ...patch };
}

describe("presence", () => {
  it("limits presence updates to 15 Hz", () => {
    expect(shouldSendPresence(1_000, 1_050)).toBe(false);
    expect(shouldSendPresence(1_000, 1_066)).toBe(true);
  });

  it("locks text that another peer is editing", () => {
    const peers = [peer({ id: "self" }), peer({ id: "alice", editingElementId: "title" })];
    expect(textLockHolder(peers, "self", "title")?.id).toBe("alice");
    expect(textLockHolder(peers, "alice", "title")).toBeUndefined();
  });

  it("marks slides and returns ghost poses for the current slide", () => {
    const peers = [peer({
      id: "alice",
      color: "#3d8bfd",
      slideId: "slide-a",
      preview: { slideId: "slide-a", poses: [{ id: "box", x: 10, y: 20, width: 30, height: 40, rotation: 0 }] }
    })];
    expect(peerMarks(peers).get("slide-a")).toEqual(["#3d8bfd"]);
    expect(ghostPoses(peers, "slide-a")).toHaveLength(1);
    expect(ghostPoses(peers, "slide-b")).toHaveLength(0);
  });

  it("reports a pose only while it differs from the confirmed deck", () => {
    const deck = moved(createDeck("Presence"), 12);
    const confirmed = createDeck("Presence");
    confirmed.slides[0]!.id = deck.slides[0]!.id;
    confirmed.slides[0]!.elements[0]!.id = deck.slides[0]!.elements[0]!.id;
    const id = deck.slides[0]!.elements[0]!.id;
    expect(localPreview(deck, confirmed, deck.slides[0]!.id, [id])?.poses[0]?.x).toBe(12);
    expect(localPreview(confirmed, confirmed, confirmed.slides[0]!.id, [id])).toBeUndefined();
  });
});

function moved(deck: Deck, x: number): Deck {
  const next = structuredClone(deck);
  next.slides[0]!.elements[0]!.x = x;
  return next;
}

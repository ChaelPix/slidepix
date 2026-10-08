import type { Deck, LivePeer, LivePose } from "@slidepix/core";

export type CollaborationView = {
  status: "off" | "hosting" | "joined" | "reconnecting" | "ended";
  role: "host" | "guest" | "none";
  canEdit: boolean;
  hostName?: string;
  self?: LivePeer;
  peers: LivePeer[];
};

const idle: CollaborationView = { status: "off", role: "none", canEdit: true, peers: [] };
let current = idle;
const listeners = new Set<() => void>();
const assetVersions = new Map<string, number>();
let assetClock = 0;

export function collaborationView(): CollaborationView {
  return current;
}

export function setCollaboration(next: CollaborationView): void {
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeCollaboration(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function canEditDocument(): boolean {
  return current.canEdit && current.status !== "ended";
}

export function noteAssets(references: string[]): void {
  assetClock += 1;
  for (const reference of references) assetVersions.set(reference, assetClock);
  for (const listener of listeners) listener();
}

export function assetCacheKey(reference: string): string {
  const version = assetVersions.get(reference);
  return version ? String(version) : "";
}

export function textLockHolder(peers: LivePeer[], selfId: string | undefined, elementId: string): LivePeer | undefined {
  return peers.find((peer) => peer.id !== selfId && peer.editingElementId === elementId);
}

export function shouldSendPresence(lastSentAt: number, now: number, minIntervalMs = 66): boolean {
  return now - lastSentAt >= minIntervalMs;
}

export function peerMarks(peers: LivePeer[]): Map<string, string[]> {
  const marks = new Map<string, string[]>();
  for (const peer of peers) {
    if (!peer.slideId) continue;
    const colors = marks.get(peer.slideId) ?? [];
    colors.push(peer.color);
    marks.set(peer.slideId, colors);
  }
  return marks;
}

export function ghostPoses(peers: LivePeer[], slideId: string): { peer: LivePeer; pose: LivePose }[] {
  return peers.flatMap((peer) => peer.preview?.slideId === slideId ? peer.preview.poses.map((pose) => ({ peer, pose })) : []);
}

export function localPreview(deck: Deck | undefined, confirmed: Deck | undefined, slideId: string | undefined, elementIds: string[]): { slideId: string; poses: LivePose[] } | undefined {
  if (!deck || !confirmed || !slideId || !elementIds.length) return undefined;
  const slide = deck.slides.find((item) => item.id === slideId);
  const base = confirmed.slides.find((item) => item.id === slideId);
  if (!slide || !base) return undefined;
  const poses: LivePose[] = [];
  for (const id of elementIds) {
    const live = slide.elements.find((item) => item.id === id);
    const saved = base.elements.find((item) => item.id === id);
    if (!live || !saved) continue;
    if (live.x === saved.x && live.y === saved.y && live.width === saved.width && live.height === saved.height && live.rotation === saved.rotation) continue;
    poses.push({ id, x: live.x, y: live.y, width: live.width, height: live.height, rotation: live.rotation });
  }
  return poses.length ? { slideId, poses } : undefined;
}

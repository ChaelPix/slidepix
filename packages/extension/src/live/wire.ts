import { z } from "zod";
import { LIVE_LIMITS } from "./limits";

const poseSchema = z.object({
  id: z.string().min(1).max(200),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
  rotation: z.number().finite()
});

const previewSchema = z.object({
  slideId: z.string().min(1).max(200),
  poses: z.array(poseSchema).max(200)
});

export const controlFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocol: z.literal(1), name: z.string().min(1).max(80), secret: z.string().min(16).max(200) }),
  z.object({ type: z.literal("welcome"), protocol: z.literal(1), revision: z.string().min(1), text: z.string().max(LIVE_LIMITS.maxControlFrameBytes), hostName: z.string().max(80), deckName: z.string().max(255), relativePath: z.string().min(1).max(1024) }),
  z.object({ type: z.literal("edit"), requestId: z.string().min(1).max(80), baseRevision: z.string().min(1).max(128), text: z.string().max(LIVE_LIMITS.maxControlFrameBytes) }),
  z.object({ type: z.literal("state"), revision: z.string().min(1).max(128), text: z.string().max(LIVE_LIMITS.maxControlFrameBytes) }),
  z.object({ type: z.literal("rebase"), requestId: z.string().min(1).max(80), revision: z.string().min(1).max(128), text: z.string().max(LIVE_LIMITS.maxControlFrameBytes) }),
  z.object({ type: z.literal("rejected"), requestId: z.string().min(1).max(80), reason: z.enum(["invalid", "conflict", "denied"]), message: z.string().max(500), revision: z.string().min(1).max(128), text: z.string().max(LIVE_LIMITS.maxControlFrameBytes) }),
  z.object({ type: z.literal("invalid"), message: z.string().max(500) }),
  z.object({ type: z.literal("save") }),
  z.object({ type: z.literal("saved"), ok: z.boolean(), message: z.string().max(500).optional() }),
  z.object({ type: z.literal("bye"), message: z.string().max(500).optional() }),
  z.object({
    type: z.literal("presence"),
    peerId: z.string().min(1).max(200).optional(),
    name: z.string().max(80).optional(),
    slideId: z.string().max(200).optional(),
    elementIds: z.array(z.string().max(200)).max(200),
    editingElementId: z.string().max(200).optional(),
    preview: previewSchema.optional()
  }),
  z.object({ type: z.literal("assetRequest"), requestId: z.string().min(1).max(80), reference: z.string().min(1).max(1024), storage: z.enum(["embedded", "linked"]) }),
  z.object({ type: z.literal("assetOffer"), requestId: z.string().min(1).max(80), reference: z.string().max(1024), storage: z.enum(["embedded", "linked"]), size: z.number().int().nonnegative().max(LIVE_LIMITS.maxAssetBytes), sha256: z.string().length(64) }),
  z.object({ type: z.literal("assetMissing"), requestId: z.string().min(1).max(80), message: z.string().max(500) }),
  z.object({ type: z.literal("assetUpload"), requestId: z.string().min(1).max(80), name: z.string().min(1).max(255), mime: z.string().max(127), size: z.number().int().nonnegative().max(LIVE_LIMITS.maxAssetBytes), sha256: z.string().length(64) }),
  z.object({ type: z.literal("assetStored"), requestId: z.string().min(1).max(80), reference: z.string().min(1).max(1024), storage: z.literal("embedded") }),
  z.object({ type: z.literal("assetRejected"), requestId: z.string().min(1).max(80), message: z.string().max(500) }),
  z.object({ type: z.literal("assetBegin"), requestId: z.string().min(1).max(80), size: z.number().int().nonnegative().max(LIVE_LIMITS.maxAssetBytes), sha256: z.string().length(64) }),
  z.object({ type: z.literal("embedMedia"), elementIds: z.array(z.string().max(200)).max(500).optional() })
]);

export type ControlFrame = z.infer<typeof controlFrameSchema>;

export function encodeFrame(frame: ControlFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.length > LIVE_LIMITS.maxControlFrameBytes) throw new Error("Live frame exceeds the control limit.");
  if (frame.type === "presence" && body.length > LIVE_LIMITS.maxPresenceBytes) throw new Error("Presence update is too large.");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export function decodeFrame(bytes: Buffer): ControlFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Live frame is not valid JSON.");
  }
  const result = controlFrameSchema.safeParse(parsed);
  if (!result.success) throw new Error("Live frame does not match the protocol.");
  if (result.data.type === "presence" && bytes.length > LIVE_LIMITS.maxPresenceBytes) throw new Error("Presence update is too large.");
  return result.data;
}

export class FrameDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): ControlFrame[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: ControlFrame[] = [];
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length > LIVE_LIMITS.maxControlFrameBytes) throw new Error("Live frame exceeds the control limit.");
      if (this.pending.length < 4 + length) break;
      frames.push(decodeFrame(this.pending.subarray(4, 4 + length)));
      this.pending = this.pending.subarray(4 + length);
    }
    return frames;
  }
}

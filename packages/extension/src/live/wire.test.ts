import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, FrameDecoder } from "./wire";

describe("live frames", () => {
  it("round-trips a control frame", () => {
    const frame = { type: "hello" as const, protocol: 1 as const, name: "Ada", secret: "a".repeat(43) };
    const encoded = encodeFrame(frame);
    expect(new FrameDecoder().push(encoded)).toEqual([frame]);
  });

  it("waits for a truncated frame and rejects an oversized header", () => {
    const decoder = new FrameDecoder();
    const encoded = encodeFrame({ type: "save" });
    expect(decoder.push(encoded.subarray(0, 3))).toEqual([]);
    expect(decoder.push(encoded.subarray(3))).toEqual([{ type: "save" }]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(20 * 1024 * 1024);
    expect(() => decoder.push(header)).toThrow(/control limit/);
  });

  it("rejects a frame that does not match the protocol", () => {
    const body = Buffer.from(JSON.stringify({ type: "hello", protocol: 1, name: "", secret: "short" }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    expect(() => decodeFrame(body)).toThrow(/protocol/);
  });
});

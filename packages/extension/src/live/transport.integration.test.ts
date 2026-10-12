import { describe, expect, it } from "vitest";
import { openLiveEndpoint, sha256 } from "./transport";

describe("iroh transport", () => {
  it("connects two local endpoints and exchanges an edit and a media file", async () => {
    const host = await openLiveEndpoint({ mode: "disabled", urls: [] });
    const guest = await openLiveEndpoint({ mode: "disabled", urls: [] });
    const received: string[] = [];
    const media = new Promise<Buffer>((resolve) => {
      host.accept((link) => {
        const hello = link.takeHello();
        if (hello) received.push(hello.name);
        link.onFrame((frame) => {
          if (frame.type === "edit") received.push(frame.text);
        });
        link.onAsset((asset) => resolve(Buffer.from(asset.bytes)));
      });
    });
    const link = await guest.connect(host.ticket);
    await link.send({ type: "hello", protocol: 1, name: "Ada", secret: "a".repeat(43) });
    await link.send({ type: "edit", requestId: "1", baseRevision: "base", text: "{\"ok\":true}" });
    const bytes = Buffer.from("pixels");
    await link.sendAsset("asset-1", bytes, sha256(bytes));
    await expect.poll(() => received.join(","), { timeout: 10_000 }).toContain("Ada");
    expect(await media).toEqual(bytes);
    link.close();
    await host.close();
    await guest.close();
  }, 20_000);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { cssUrls, describeExportError, firstPresentedTime, frameIsBlank, inlineImages, playHud, urlToDataUri, withTimeout } from "./export-capture";

const PNG_BYTES = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
  0, 0, 0, 13, 73, 68, 65, 84, 8, 153, 99, 96, 96, 96, 248, 15, 0, 1, 4, 1, 0, 84, 109, 140, 210, 0, 0, 0, 0, 73, 69, 78,
  68, 174, 66, 96, 130
]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("describeExportError", () => {
  it("formats Error instances with name and message", () => {
    expect(describeExportError(new TypeError("boom"))).toContain("TypeError: boom");
  });

  it("describes HTMLImageElement error events instead of [object Event]", () => {
    const event = new Event("error");
    Object.defineProperty(event, "target", {
      configurable: true,
      value: { currentSrc: "https://assets.example/photo.png", constructor: { name: "HTMLImageElement" } }
    });
    expect(describeExportError(event)).toMatch(/HTMLImageElement error event \(src=.*photo\.png/);
    expect(describeExportError(event)).not.toContain("[object Event]");
  });
});

describe("first video frame", () => {
  it("asks for the first presented time instead of the unloaded zero frame", () => {
    expect(firstPresentedTime(15)).toBeCloseTo(1 / 30);
    expect(firstPresentedTime(0)).toBe(0.04);
    expect(firstPresentedTime(Number.NaN)).toBe(0.04);
  });

  it("treats an all-black bitmap as blank and a lit bitmap as a real frame", () => {
    expect(frameIsBlank(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]))).toBe(true);
    expect(frameIsBlank(new Uint8ClampedArray([200, 20, 20, 255, 0, 0, 0, 255]))).toBe(false);
  });
});

describe("playHud", () => {
  it("centers a play triangle that points to the right", () => {
    const hud = playHud(400, 300);
    expect(hud.cx).toBe(200);
    expect(hud.cy).toBe(150);
    expect(hud.radius).toBeCloseTo(42);
    expect(hud.triangle[1][0]).toBeGreaterThan(hud.triangle[0][0]);
    expect(hud.triangle[0][1]).toBeLessThan(hud.cy);
    expect(hud.triangle[2][1]).toBeGreaterThan(hud.cy);
  });
});

describe("cssUrls", () => {
  it("extracts quoted and unquoted url() values", () => {
    expect(cssUrls(`url(https://a/x.png), url("https://b/y.jpg")`)).toEqual(["https://a/x.png", "https://b/y.jpg"]);
  });
});

describe("withTimeout", () => {
  it("rejects when the promise never settles", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => undefined), 50, "too slow");
    const assertion = expect(pending).rejects.toThrow("too slow");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    vi.useRealTimers();
  });
});

describe("inlineImages", () => {
  it("leaves data-URI images unchanged", async () => {
    stubComputedStyle();
    const root = el("div");
    const img = el("img");
    const data = "data:image/png;base64,AAAA";
    img.setAttribute("src", data);
    root.children.push(img);
    const restore = await inlineImages(root as unknown as HTMLElement);
    expect(img.getAttribute("src")).toBe(data);
    restore();
    expect(img.getAttribute("src")).toBe(data);
  });

  it("replaces a loaded image with a fetched data URI and restores it", async () => {
    stubPngFetch();
    stubComputedStyle();
    const root = el("div");
    const img = el("img");
    img.setAttribute("src", "https://assets.example/photo.png");
    img.complete = true;
    img.naturalWidth = 8;
    img.naturalHeight = 8;
    root.children.push(img);
    const restore = await inlineImages(root as unknown as HTMLElement);
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    restore();
    expect(img.getAttribute("src")).toBe("https://assets.example/photo.png");
  });

  it("reports an image that failed to decode", async () => {
    const root = el("div");
    const img = el("img");
    img.setAttribute("src", "https://assets.example/missing.png");
    img.complete = true;
    img.naturalWidth = 0;
    root.children.push(img);
    await expect(inlineImages(root as unknown as HTMLElement)).rejects.toThrow(/Image failed to load: https:\/\/assets\.example\/missing\.png/);
  });

  it("replaces CSS background urls with fetched data URIs and restores them", async () => {
    stubPngFetch();
    const root = el("div");
    const slide = el("div");
    slide.style.backgroundImage = 'url("https://assets.example/bg.png")';
    root.children.push(slide);
    vi.stubGlobal("getComputedStyle", (node: FakeEl) => ({ backgroundImage: node.style.backgroundImage || "none" }));
    const restore = await inlineImages(root as unknown as HTMLElement);
    expect(slide.style.backgroundImage).toMatch(/^url\("data:image\/png;base64,/);
    restore();
    expect(slide.style.backgroundImage).toBe('url("https://assets.example/bg.png")');
  });
});

describe("urlToDataUri", () => {
  it("returns existing data URIs", async () => {
    expect(await urlToDataUri("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });

  it("fetches non-data URLs as data URIs", async () => {
    stubPngFetch();
    expect(await urlToDataUri("https://assets.example/photo.png")).toMatch(/^data:image\/png;base64,/);
  });

  it("throws a readable error when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })));
    await expect(urlToDataUri("https://assets.example/missing.png")).rejects.toThrow(/404 Not Found/);
  });
});

type FakeEl = {
  tagName: string;
  src: string;
  currentSrc: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  style: { backgroundImage: string };
  children: FakeEl[];
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): FakeEl[];
};

function el(tag: string): FakeEl {
  const attrs = new Map<string, string>();
  const node: FakeEl = {
    tagName: tag.toUpperCase(),
    src: "",
    currentSrc: "",
    complete: false,
    naturalWidth: 0,
    naturalHeight: 0,
    style: { backgroundImage: "" },
    children: [],
    setAttribute(name, value) {
      attrs.set(name, value);
      if (name === "src") this.src = value;
    },
    getAttribute(name) {
      return attrs.get(name) ?? null;
    },
    querySelectorAll(selector) {
      const all = descendants(this);
      if (selector === "img") return all.filter((item) => item.tagName === "IMG");
      if (selector === "*") return all;
      return [];
    }
  };
  return node;
}

function descendants(node: FakeEl): FakeEl[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function stubComputedStyle(): void {
  vi.stubGlobal("getComputedStyle", () => ({ backgroundImage: "none" }));
}

function stubPngFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(PNG_BYTES, { status: 200, headers: { "Content-Type": "image/png" } })));
}

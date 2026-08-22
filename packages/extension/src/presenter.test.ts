import { describe, expect, it } from "vitest";
import { createDeck } from "@slidepix/core";
import { presenterHtml } from "./presenter";

describe("presenter panel HTML", () => {
  it("double-buffers frame changes and rejects stale rapid-click loads", () => {
    const html = presenterHtml({ port: 8123, url: (pathname) => `http://127.0.0.1:8123${pathname}?token=test` }, createDeck("Presenter"));

    expect(html).toContain("function swapFrame");
    expect(html).toContain("shell.dataset.request!==request");
    expect(html).toContain("if(frame!==next)frame.remove()");
    expect(html).toContain("swapFrame('current',i)");
    expect(html).toContain("swapFrame('next',i+1)");
    expect(html).toContain(".frame-shell{position:relative");
    expect(html).toContain("background:#ffffff");
  });
});

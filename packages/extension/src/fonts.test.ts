import { describe, expect, it } from "vitest";
import { cssFontFamily, fontFamilyFromFilename } from "./fonts";

describe("system font picker helpers", () => {
  it("turns common font filenames into readable family names", () => {
    expect(fontFamilyFromFilename("HelveticaNeue-BoldItalic.ttf")).toBe("Helvetica Neue");
    expect(fontFamilyFromFilename("Noto_Sans_Regular.otf")).toBe("Noto Sans");
    expect(fontFamilyFromFilename("README.txt")).toBeUndefined();
  });

  it("creates a safe CSS family with an appropriate fallback", () => {
    expect(cssFontFamily('Example "Sans"')).toBe('"Example \\"Sans\\"", sans-serif');
    expect(cssFontFamily("JetBrains Mono")).toBe('"JetBrains Mono", monospace');
  });
});

import * as path from "node:path";
import type * as Playwright from "playwright-core";

export function rendererPlaywright(): typeof Playwright {
  return require(path.join(__dirname, "..", "vendor", "playwright-core")) as typeof Playwright;
}

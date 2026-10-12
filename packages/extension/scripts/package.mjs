import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.platform === "darwin"
  ? `darwin-${process.arch}`
  : process.platform === "win32"
    ? `win32-${process.arch}`
    : `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
const packed = spawnSync("pnpm", ["exec", "vsce", "package", "--no-dependencies", "--allow-missing-repository", "--target", target], {
  cwd: extension,
  stdio: "inherit"
});
process.exit(packed.status ?? 1);

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];

for (const target of targets) {
  const staged = spawnSync(process.execPath, ["scripts/stage-native.mjs", `--target=${target}`], { cwd: extension, stdio: "inherit" });
  if (staged.status !== 0) process.exit(staged.status ?? 1);
  const packed = spawnSync("pnpm", ["exec", "vsce", "package", "--no-dependencies", "--allow-missing-repository", "--target", target], { cwd: extension, stdio: "inherit" });
  if (packed.status !== 0) process.exit(packed.status ?? 1);
}

import { createRequire } from "node:module";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "dist", "native", "iroh");

const platforms = {
  "darwin-arm64": { pkg: "@number0/iroh-darwin-arm64", file: "iroh.darwin-arm64.node" },
  "linux-x64": { pkg: "@number0/iroh-linux-x64-gnu", file: "iroh.linux-x64-gnu.node" },
  "linux-arm64": { pkg: "@number0/iroh-linux-arm64-gnu", file: "iroh.linux-arm64-gnu.node" },
  "win32-x64": { pkg: "@number0/iroh-win32-x64-msvc", file: "iroh.win32-x64-msvc.node" },
  "win32-arm64": { pkg: "@number0/iroh-win32-arm64-msvc", file: "iroh.win32-arm64-msvc.node" }
};

const requested = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length);
const current = process.platform === "darwin"
  ? `darwin-${process.arch}`
  : process.platform === "win32"
    ? `win32-${process.arch}`
    : `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
const target = requested || current;
const spec = platforms[target];
if (!spec) {
  console.error(`Live collaboration is not available on ${target}. Supported targets: ${Object.keys(platforms).join(", ")}.`);
  process.exit(1);
}

const loader = require.resolve("@number0/iroh");
const irohRequire = createRequire(loader);
let binary;
try {
  binary = irohRequire.resolve(`${spec.pkg}/${spec.file}`);
} catch {
  console.error(`Missing ${spec.pkg}. Install optional dependencies for ${target} before packaging.`);
  process.exit(1);
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(loader, path.join(destination, "index.js"));
cpSync(binary, path.join(destination, spec.file));
console.log(`Staged ${spec.file} into dist/native/iroh`);

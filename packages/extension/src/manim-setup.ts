import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { formatManimLogChunk, resolveManimLaunch, uvInstallCommand, venvManimCandidates, type ManimLaunch } from "./manim-render.js";

export async function ensureManimLaunch(deckPath: string, configuredExecutable: string, log: (text: string) => void): Promise<ManimLaunch | undefined> {
  const resolved = resolveManimLaunch(deckPath, configuredExecutable);
  log(`Checking Manim: ${resolved.command} ${resolved.args.join(" ")}${resolved.cwd ? ` (cwd ${resolved.cwd})` : ""}\n`);
  if (await manimLaunchWorks(resolved)) {
    log("Manim is available.\n");
    return resolved;
  }
  log("Manim was not found. Opening setup.\n");
  return promptManimSetup(deckPath, log);
}

let setupInFlight: Promise<ManimLaunch | undefined> | undefined;

export async function promptManimSetup(deckPath: string, log: (text: string) => void): Promise<ManimLaunch | undefined> {
  if (setupInFlight) return setupInFlight;
  setupInFlight = openManimSetup(deckPath, log).finally(() => { setupInFlight = undefined; });
  return setupInFlight;
}

async function openManimSetup(deckPath: string, log: (text: string) => void): Promise<ManimLaunch | undefined> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "Find Manim…", description: "Browse, or use .venv/bin/manim or .venv/Scripts/manim.exe" },
      { label: "Install Manim", description: "Install uv if needed, then uv tool install manim" },
      { label: "Install uv", description: "Install Astral uv" }
    ],
    { title: "Set up Manim", placeHolder: "Choose how SlidePix should find Manim Community", ignoreFocusOut: true }
  );
  log(`Manim setup choice: ${choice?.label ?? "dismissed"}\n`);
  if (choice?.label === "Find Manim…") return chooseManimExecutable(deckPath);
  if (choice?.label === "Install uv") {
    await installUv(log, false);
    return undefined;
  }
  if (choice?.label === "Install Manim") return installManim(deckPath, log);
  return undefined;
}

async function chooseManimExecutable(deckPath: string): Promise<ManimLaunch | undefined> {
  const searched = await searchNearbyManim(path.dirname(deckPath));
  const picks = [
    ...searched.map((candidate) => ({ label: candidate, description: "Found near the deck" })),
    { label: "Browse…", description: "Select manim or manim.exe" }
  ];
  const picked = await vscode.window.showQuickPick(picks, { title: "Select Manim", placeHolder: "SlidePix looks for .venv/bin/manim and .venv/Scripts/manim.exe" });
  if (!picked) return undefined;
  const executable = picked.label === "Browse…" ? await browseForManim() : picked.label;
  if (!executable) return undefined;
  await saveManimExecutable(executable);
  return { command: executable, args: [] };
}

async function browseForManim(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: "Select the Manim executable"
  });
  return picked?.[0]?.fsPath;
}

async function installManim(deckPath: string, log: (text: string) => void): Promise<ManimLaunch | undefined> {
  const confirmed = await vscode.window.showWarningMessage(
    "Install uv from Astral if it is missing, then install Manim Community with uv tool install manim?",
    { modal: true },
    "Install"
  );
  if (confirmed !== "Install") return undefined;
  const uv = await uvExecutable() ?? await installUv(log, true);
  if (!uv) return undefined;
  log(`\n$ ${uv} tool install manim\n`);
  await runLogged(uv, ["tool", "install", "manim"], log);
  const binDir = (await capture(uv, ["tool", "dir", "--bin"])).trim();
  const manimName = process.platform === "win32" ? "manim.exe" : "manim";
  const manim = binDir ? path.join(binDir, manimName) : manimName;
  if (!(await pathExists(manim)) && manim !== manimName) {
    throw new Error("uv installed Manim, but SlidePix could not locate the manim executable.");
  }
  await saveManimExecutable(manim);
  void vscode.window.showInformationMessage(`Manim is ready: ${manim}`);
  return { command: manim, args: [] };
}

async function installUv(log: (text: string) => void, alreadyConfirmed: boolean): Promise<string | undefined> {
  const existing = await uvExecutable();
  if (existing) {
    void vscode.window.showInformationMessage(`uv is already available: ${existing}`);
    return existing;
  }
  if (!alreadyConfirmed) {
    const confirmed = await vscode.window.showWarningMessage(
      "Install uv from Astral (https://astral.sh/uv)?",
      { modal: true },
      "Install"
    );
    if (confirmed !== "Install") return undefined;
  }
  const command = uvInstallCommand(process.platform);
  log(`\n$ ${command.command} ${command.args.join(" ")}\n`);
  await runLogged(command.command, command.args, log);
  const installed = await uvExecutable();
  if (!installed) throw new Error("The uv installer finished, but SlidePix could not find uv. Open a new terminal and check that ~/.local/bin is on PATH.");
  void vscode.window.showInformationMessage(`uv is ready: ${installed}`);
  return installed;
}

async function uvExecutable(): Promise<string | undefined> {
  const home = os.homedir();
  const candidates = [
    "uv",
    path.join(home, ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv"),
    path.join(home, ".local", "bin", "uv"),
    path.join(home, "AppData", "Roaming", "uv", "uv.exe"),
    path.join(home, ".cargo", "bin", process.platform === "win32" ? "uv.exe" : "uv")
  ];
  for (const candidate of candidates) {
    if (candidate === "uv") {
      if (await commandWorks("uv", ["--version"])) return "uv";
      continue;
    }
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

async function searchNearbyManim(startDirectory: string): Promise<string[]> {
  const found: string[] = [];
  let directory = path.resolve(startDirectory);
  const { root } = path.parse(directory);
  for (let depth = 0; depth < 8; depth += 1) {
    for (const candidate of venvManimCandidates(directory)) {
      if (await pathExists(candidate)) found.push(candidate);
    }
    if (directory === root) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return found;
}

async function saveManimExecutable(executable: string): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration("slidepix").update("manim.executable", executable, target);
}

export async function manimLaunchWorks(launch: ManimLaunch): Promise<boolean> {
  return commandWorks(launch.command, [...launch.args, "--version"], launch.cwd);
}

function commandWorks(command: string, args: string[], cwd?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 20_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function runLogged(command: string, args: string[], log: (text: string) => void, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    let tail = "";
    const push = (chunk: Buffer | string) => {
      const text = formatManimLogChunk(String(chunk));
      tail = (tail + text).slice(-12_000);
      log(text);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(tail.trim() || `${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(target));
    return true;
  } catch {
    return false;
  }
}

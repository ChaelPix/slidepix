import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

export class LiveFileSystemProvider implements vscode.FileSystemProvider {
  private readonly roots = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  mount(sessionId: string, workspaceDir: string): void {
    this.roots.set(sessionId, workspaceDir);
  }

  unmount(sessionId: string): void {
    this.roots.delete(sessionId);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const info = await stat(this.disk(uri));
    return {
      type: info.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: info.ctimeMs,
      mtime: info.mtimeMs,
      size: info.size
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const entries = await readdir(this.disk(uri), { withFileTypes: true });
    return entries.map((entry) => [entry.name, entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await mkdir(this.disk(uri), { recursive: true });
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return readFile(this.disk(uri));
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const target = this.disk(uri);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async delete(uri: vscode.Uri, options?: { recursive?: boolean }): Promise<void> {
    await rm(this.disk(uri), { recursive: options?.recursive ?? false, force: true });
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(source: vscode.Uri, target: vscode.Uri, options?: { overwrite?: boolean }): Promise<void> {
    if (!options?.overwrite) {
      try {
        await stat(this.disk(target));
        throw vscode.FileSystemError.FileExists(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await mkdir(path.dirname(this.disk(target)), { recursive: true });
    await rename(this.disk(source), this.disk(target));
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri: source }, { type: vscode.FileChangeType.Created, uri: target }]);
  }

  private disk(uri: vscode.Uri): string {
    const root = this.roots.get(uri.authority);
    if (!root) throw vscode.FileSystemError.FileNotFound(uri);
    const relative = uri.path.replace(/^\/+/, "");
    const resolved = path.resolve(root, ...relative.split("/").filter(Boolean));
    const base = path.resolve(root);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw vscode.FileSystemError.NoPermissions(uri);
    return resolved;
  }
}

export function liveDocumentUri(sessionId: string, relativePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: "slidepix-live", authority: sessionId, path: `/${relativePath.replace(/^\/+/, "")}` });
}

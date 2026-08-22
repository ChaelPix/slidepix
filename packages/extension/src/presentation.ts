import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { renderDeckDocument, type Deck } from "@slidepix/core";
import { resolveAssetPath } from "@slidepix/core/assets";

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf"
};

export class PresentationServer {
  private server?: Server;
  private sockets = new Set<WebSocket>();
  private index = 0;
  readonly token = crypto.randomUUID();
  port = 0;

  constructor(
    readonly deck: Deck,
    readonly deckPath: string,
    private readonly onState?: (index: number) => void
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const websocket = new WebSocketServer({ noServer: true });
    websocket.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.send(JSON.stringify({ type: "state", index: this.index }));
      socket.on("message", (data) => this.handleCommand(String(data)));
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server = createServer((request, response) => void this.respond(request.url ?? "/", response));
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/ws" || url.searchParams.get("token") !== this.token) return socket.destroy();
      websocket.handleUpgrade(request, socket, head, (ws) => websocket.emit("connection", ws, request));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
  }

  url(pathname: string): string {
    return `http://127.0.0.1:${this.port}${pathname}?token=${encodeURIComponent(this.token)}`;
  }

  command(command: "next" | "previous" | "first" | "last"): void {
    const count = this.deck.slides.filter((slide) => !slide.hidden).length;
    if (command === "next") this.index = Math.min(count - 1, this.index + 1);
    if (command === "previous") this.index = Math.max(0, this.index - 1);
    if (command === "first") this.index = 0;
    if (command === "last") this.index = Math.max(0, count - 1);
    this.broadcast();
  }

  dispose(): void {
    for (const socket of this.sockets) socket.close();
    this.server?.close();
    this.server = undefined;
  }

  private handleCommand(raw: string): void {
    try {
      const message = JSON.parse(raw) as { type?: string; command?: string };
      if (message.type === "command" && ["next", "previous", "first", "last"].includes(message.command ?? "")) this.command(message.command as "next" | "previous" | "first" | "last");
    } catch { /* ignore malformed client messages */ }
  }

  private broadcast(): void {
    const message = JSON.stringify({ type: "state", index: this.index });
    for (const socket of this.sockets) if (socket.readyState === 1) socket.send(message);
    this.onState?.(this.index);
  }

  private async respond(rawUrl: string, response: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (url.searchParams.get("token") !== this.token) return send(response, 403, "text/plain", "Forbidden");
    try {
      if (url.pathname.startsWith("/asset/")) {
        const reference = decodeURIComponent(url.pathname.slice("/asset/".length));
        const filePath = resolveAssetPath(this.deckPath, reference);
        const bytes = await readFile(filePath);
        return send(response, 200, MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream", bytes);
      }
      const asset = (reference: string) => this.url(`/asset/${encodeURIComponent(reference)}`);
      if (url.pathname === "/audience") {
        const html = renderDeckDocument(this.deck, asset, { mode: "present" }).replace("</body>", `${audienceBridge(this.port, this.token)}</body>`);
        return send(response, 200, "text/html; charset=utf-8", html);
      }
      if (url.pathname === "/print") return send(response, 200, "text/html; charset=utf-8", renderDeckDocument(this.deck, asset, { mode: "print" }));
      if (url.pathname === "/contact") {
        const ids = url.searchParams.get("ids")?.split(",").filter(Boolean);
        const columns = Number(url.searchParams.get("columns")) || undefined;
        return send(response, 200, "text/html; charset=utf-8", renderDeckDocument(this.deck, asset, { mode: "contact", selectedSlideIds: ids, columns }));
      }
      if (url.pathname === "/frame") {
        const slides = this.deck.slides.filter((slide) => !slide.hidden);
        const target = slides[Number(url.searchParams.get("index")) || 0];
        return send(response, 200, "text/html; charset=utf-8", renderDeckDocument(this.deck, asset, { mode: "contact", selectedSlideIds: target ? [target.id] : [], columns: 1 }).replace("</head>", `<style>body{overflow:hidden}main{padding:0!important;display:block!important;transform-origin:top left;transform:scale(min(calc(100vw / ${this.deck.size.width}),calc(100vh / ${this.deck.size.height})))}</style></head>`));
      }
      send(response, 404, "text/plain", "Not found");
    } catch (error) {
      send(response, 500, "text/plain", error instanceof Error ? error.message : "Render error");
    }
  }
}

function audienceBridge(port: number, token: string): string {
  return `<script>(function(){const socket=new WebSocket('ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}');function command(c){if(c==='next'&&window.slidepixAdvance?.())return;socket.send(JSON.stringify({type:'command',command:c}))}socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='state')window.slidepixShow?.(m.index)};addEventListener('keydown',e=>{const c=['ArrowRight','ArrowDown',' ','PageDown'].includes(e.key)?'next':['ArrowLeft','ArrowUp','PageUp'].includes(e.key)?'previous':null;if(c){e.preventDefault();command(c)}});addEventListener('click',()=>command('next'))})();</script>`;
}

function send(response: import("node:http").ServerResponse, status: number, contentType: string, body: string | Uint8Array): void {
  response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(body);
}

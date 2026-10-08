import { createHash } from "node:crypto";
import * as path from "node:path";
import { LIVE_LIMITS } from "./limits";
import { decodeFrame, encodeFrame, type ControlFrame } from "./wire";

const ALPN = [...Buffer.from("slidepix/live/1")];

export type RelayConfig = { mode: "default" | "custom" | "disabled"; urls: string[] };

export type LiveEndpoint = {
  id: string;
  ticket: string;
  online: boolean;
  close(): Promise<void>;
  accept(handler: (link: LiveLink) => void): void;
  connect(ticket: string): Promise<LiveLink>;
};

export type LiveLink = {
  remoteId: string;
  takeHello(): Extract<ControlFrame, { type: "hello" }> | undefined;
  send(frame: ControlFrame): Promise<void>;
  onFrame(handler: (frame: ControlFrame) => void): void;
  sendAsset(requestId: string, bytes: Uint8Array, sha256: string): Promise<void>;
  onAsset(handler: (payload: { requestId: string; bytes: Uint8Array; sha256: string }) => void): void;
  close(): void;
  readonly closed: Promise<void>;
};

type SendStream = { writeAll(buf: number[]): Promise<void>; finish(): Promise<void> };
type RecvStream = { readExact(size: number): Promise<number[]>; readToEnd(sizeLimit: number): Promise<number[]> };
type BiStream = { send: SendStream; recv: RecvStream };
type Connection = {
  remoteId(): { toString(): string };
  openBi(): Promise<BiStream>;
  acceptBi(): Promise<BiStream>;
  close(errorCode: bigint, reason: number[]): void;
  closed(): Promise<string>;
  setMaxConcurrentBiStreams(count: bigint): void;
};
type Endpoint = {
  id(): { toString(): string };
  addr(): { toString(): string };
  online(): Promise<void>;
  acceptNext(): Promise<{ accept(): Promise<{ connect(): Promise<Connection> }> } | null>;
  connect(addr: unknown, alpn: number[]): Promise<Connection>;
  close(): Promise<void>;
  isClosed(): boolean;
};
type IrohModule = {
  Endpoint: {
    bind(options?: { alpns?: number[][] }, relayMode?: unknown): Promise<Endpoint>;
    builder(): { applyN0DisableRelay(): void; alpns(alpns: number[][]): void; bind(): Promise<Endpoint> };
  };
  EndpointTicket: {
    fromAddr(addr: { toString(): string }): { toString(): string };
    fromString(value: string): { endpointAddr(): unknown };
  };
  RelayMode: { customFromUrls(urls: string[]): unknown };
};

export async function openLiveEndpoint(relay: RelayConfig): Promise<LiveEndpoint> {
  const iroh = loadIroh();
  const endpoint = await bindEndpoint(iroh, relay);
  const online = relay.mode === "disabled" ? false : await waitUntilOnline(endpoint);
  const ticket = iroh.EndpointTicket.fromAddr(endpoint.addr()).toString();
  let accepting = false;
  return {
    id: endpoint.id().toString(),
    ticket,
    online,
    close: () => endpoint.close(),
    accept(handler) {
      if (accepting) return;
      accepting = true;
      void acceptLoop(endpoint, handler);
    },
    async connect(inviteTicket: string) {
      const addr = iroh.EndpointTicket.fromString(inviteTicket).endpointAddr();
      const connection = await endpoint.connect(addr, ALPN);
      connection.setMaxConcurrentBiStreams(32n);
      const stream = await connection.openBi();
      return new IrohLink(connection, stream.send, stream.recv);
    }
  };
}

export async function waitUntilOnline(endpoint: { online(): Promise<void> }, timeoutMs = LIVE_LIMITS.onlineTimeoutMs): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      endpoint.online().then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function loadIroh(): IrohModule {
  const staged = path.join(__dirname, "native", "iroh");
  try {
    return require(staged) as IrohModule;
  } catch {
    try {
      return require("@number0/iroh") as IrohModule;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Live collaboration is not available on this platform (${process.platform}/${process.arch}). ${detail}`);
    }
  }
}

async function bindEndpoint(iroh: IrohModule, relay: RelayConfig): Promise<Endpoint> {
  if (relay.mode === "disabled") {
    const builder = iroh.Endpoint.builder();
    builder.applyN0DisableRelay();
    builder.alpns([ALPN]);
    return builder.bind();
  }
  const mode = relay.mode === "custom" ? iroh.RelayMode.customFromUrls(relay.urls) : undefined;
  return iroh.Endpoint.bind({ alpns: [ALPN] }, mode);
}

async function acceptLoop(endpoint: Endpoint, handler: (link: LiveLink) => void): Promise<void> {
  while (!endpoint.isClosed()) {
    const incoming = await endpoint.acceptNext();
    if (!incoming) return;
    try {
      const connection = await (await incoming.accept()).connect();
      connection.setMaxConcurrentBiStreams(32n);
      const stream = await connection.acceptBi();
      const first = await readFrame(stream.recv);
      if (first.type !== "hello") {
        connection.close(1n, [...Buffer.from("expected hello")]);
        continue;
      }
      handler(new IrohLink(connection, stream.send, stream.recv, first));
    } catch {
      /* A refused handshake does not stop the session. */
    }
  }
}

class IrohLink implements LiveLink {
  readonly remoteId: string;
  readonly closed: Promise<void>;
  private hello?: Extract<ControlFrame, { type: "hello" }>;
  private frameHandler?: (frame: ControlFrame) => void;
  private assetHandler?: (payload: { requestId: string; bytes: Uint8Array; sha256: string }) => void;
  private readonly queued: ControlFrame[] = [];
  private readonly queuedAssets: { requestId: string; bytes: Uint8Array; sha256: string }[] = [];

  constructor(private readonly connection: Connection, private readonly sendStream: SendStream, recv: RecvStream, initial?: ControlFrame) {
    this.remoteId = connection.remoteId().toString();
    if (initial?.type === "hello") this.hello = initial;
    else if (initial) this.queued.push(initial);
    this.closed = connection.closed().then(() => undefined, () => undefined);
    void this.readControl(recv);
    void this.acceptAssets();
  }

  takeHello(): Extract<ControlFrame, { type: "hello" }> | undefined {
    const hello = this.hello;
    this.hello = undefined;
    return hello;
  }

  onFrame(handler: (frame: ControlFrame) => void): void {
    this.frameHandler = handler;
    for (const frame of this.queued.splice(0)) handler(frame);
  }

  onAsset(handler: (payload: { requestId: string; bytes: Uint8Array; sha256: string }) => void): void {
    this.assetHandler = handler;
    for (const asset of this.queuedAssets.splice(0)) handler(asset);
  }

  async send(frame: ControlFrame): Promise<void> {
    await writeFrame(this.sendStream, frame);
  }

  async sendAsset(requestId: string, bytes: Uint8Array, sha256: string): Promise<void> {
    if (bytes.byteLength > LIVE_LIMITS.maxAssetBytes) throw new Error("Media files are limited to 100 MB.");
    const stream = await this.connection.openBi();
    await writeFrame(stream.send, { type: "assetBegin", requestId, size: bytes.byteLength, sha256 });
    const chunk = 64 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
      await stream.send.writeAll([...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunk))]);
    }
    await stream.send.finish();
  }

  close(): void {
    this.connection.close(0n, []);
  }

  private async readControl(recv: RecvStream): Promise<void> {
    try {
      while (true) {
        const frame = await readFrame(recv);
        if (frame.type === "assetBegin") continue;
        if (this.frameHandler) this.frameHandler(frame);
        else this.queued.push(frame);
      }
    } catch {
      this.close();
    }
  }

  private async acceptAssets(): Promise<void> {
    try {
      while (true) {
        const stream = await this.connection.acceptBi();
        void this.readAsset(stream).catch(() => undefined);
      }
    } catch {
      /* Connection closed. */
    }
  }

  private async readAsset(stream: BiStream): Promise<void> {
    const frame = await readFrame(stream.recv);
    if (frame.type !== "assetBegin") return;
    const bytes = Buffer.from(await stream.recv.readToEnd(frame.size));
    if (bytes.byteLength !== frame.size || sha256(bytes) !== frame.sha256) return;
    const payload = { requestId: frame.requestId, bytes, sha256: frame.sha256 };
    if (this.assetHandler) this.assetHandler(payload);
    else this.queuedAssets.push(payload);
  }
}

async function readFrame(recv: RecvStream): Promise<ControlFrame> {
  const header = Buffer.from(await recv.readExact(4));
  const length = header.readUInt32BE(0);
  if (length > LIVE_LIMITS.maxControlFrameBytes) throw new Error("Live frame exceeds the control limit.");
  return decodeFrame(Buffer.from(await recv.readExact(length)));
}

async function writeFrame(send: SendStream, frame: ControlFrame): Promise<void> {
  await send.writeAll([...encodeFrame(frame)]);
}

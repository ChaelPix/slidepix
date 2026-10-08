import { timingSafeEqual } from "node:crypto";

const PREFIX = "slidepix-live:1:";

export function encodeInvite(ticket: string, secret: Buffer): string {
  if (secret.length !== 32) throw new Error("Live invite secret must be 32 bytes.");
  if (!ticket || ticket.includes(".")) throw new Error("Live ticket is empty or contains a separator.");
  return `${PREFIX}${ticket}.${secret.toString("base64url")}`;
}

export function encodeJoinUri(scheme: string, invite: string): string {
  return `${scheme}://slidepix.slidepix/join?invite=${encodeURIComponent(invite)}`;
}

export function decodeInvite(value: string): { ticket: string; secret: Buffer } | undefined {
  const invite = extractInvite(value);
  if (!invite?.startsWith(PREFIX)) return undefined;
  const body = invite.slice(PREFIX.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ticket = body.slice(0, dot);
  const secret = Buffer.from(body.slice(dot + 1), "base64url");
  if (!ticket || secret.length !== 32) return undefined;
  return { ticket, secret };
}

export function secretsMatch(received: string, expected: Buffer): boolean {
  const got = Buffer.from(received, "base64url");
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

export function fingerprint(endpointId: string): string {
  const compact = endpointId.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const body = compact.padEnd(8, "0").slice(0, 8);
  return `${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

function extractInvite(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith(PREFIX)) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.searchParams.get("invite") ?? undefined;
  } catch {
    return undefined;
  }
}

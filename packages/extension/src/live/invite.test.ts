import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeInvite, encodeInvite, encodeJoinUri, fingerprint, secretsMatch } from "./invite";

describe("live invite", () => {
  it("round-trips a ticket and secret", () => {
    const secret = randomBytes(32);
    const invite = encodeInvite("ticketvalue", secret);
    expect(decodeInvite(invite)).toEqual({ ticket: "ticketvalue", secret });
    expect(decodeInvite(encodeJoinUri("cursor", invite))?.ticket).toBe("ticketvalue");
    expect(secretsMatch(secret.toString("base64url"), secret)).toBe(true);
  });

  it("rejects altered and incomplete invitations", () => {
    const secret = randomBytes(32);
    const invite = encodeInvite("ticketvalue", secret);
    expect(decodeInvite(invite.slice(0, -2))).toBeUndefined();
    expect(decodeInvite("slidepix-live:1:onlyticket")).toBeUndefined();
    expect(decodeInvite("not an invite")).toBeUndefined();
    expect(fingerprint("abcd1234wxyz")).toBe("ABCD-1234");
  });
});

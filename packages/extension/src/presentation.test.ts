import { describe, expect, it } from "vitest";
import { createDeck, duplicateSlide } from "@slidepix/core";
import { PresentationServer, renderPresenterFrame } from "./presentation";

describe("PresentationServer navigation", () => {
  it("broadcasts only when the visible slide index changes", () => {
    const deck = createDeck("Navigation boundary");
    deck.slides.push(duplicateSlide(deck.slides[0]!));
    const states: number[] = [];
    const server = new PresentationServer(deck, "/unused.slidepix.json", (index) => states.push(index));

    server.command("next");
    server.command("next");
    server.command("previous");
    server.command("previous");

    expect(states).toEqual([1, 0]);
  });

  it("opens forward slides at their initial step and previous slides at their completed step", () => {
    const deck = createDeck("Animation navigation");
    deck.slides.push(duplicateSlide(deck.slides[0]!));
    const sent: string[] = [];
    const server = new PresentationServer(deck, "/unused.slidepix.json");
    const socket = { readyState: 1, send: (message: string) => sent.push(message) };
    (server as unknown as { sockets: Set<typeof socket> }).sockets.add(socket);

    server.command("next");
    server.command("previous");

    expect(sent.map((message) => JSON.parse(message).animationState)).toEqual(["initial", "final"]);
  });

  it("renders a stable end-of-deck frame instead of accidentally rendering every slide", () => {
    const deck = createDeck("Presenter frame boundary");
    deck.slides.push(duplicateSlide(deck.slides[0]!));
    const html = renderPresenterFrame(deck, 99);

    expect(html).toContain("End of presentation");
    expect(html).not.toContain("slidepix-slide");
    expect(html).toContain("background:#ffffff");
  });

  it("reloads a connected audience without changing the session token", () => {
    const deck = createDeck("Hot reload");
    const server = new PresentationServer(deck, "/talks/fourier.slidepix.json");
    const sent: string[] = [];
    const socket = { readyState: 1, send: (message: string) => sent.push(message) };
    (server as unknown as { sockets: Set<typeof socket> }).sockets.add(socket);
    const token = server.token;
    const next = createDeck("Updated");
    next.slides.push(duplicateSlide(next.slides[0]!));

    server.replaceDeck(next);
    server.command("next");

    expect(server.token).toBe(token);
    expect(server.deck).toBe(next);
    expect(JSON.parse(sent[0]!).type).toBe("reload");
    expect(JSON.parse(sent[1]!).index).toBe(1);
  });

  it("falls back to slide navigation when presenter control has no audience connection", () => {
    const deck = createDeck("Presenter fallback");
    deck.slides.push(duplicateSlide(deck.slides[0]!));
    const states: number[] = [];
    const server = new PresentationServer(deck, "/unused.slidepix.json", (index) => states.push(index));

    server.control("next");

    expect(states).toEqual([1]);
  });
});

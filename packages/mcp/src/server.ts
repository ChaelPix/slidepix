import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { loadDeck, renderSlidesToPng, selectSlides } from "./tools";

const selectorSchema = {
  deckPath: z.string().min(1).describe("Absolute path to a .slidepix.json deck"),
  slideIds: z.array(z.string()).optional().describe("Slide IDs to select"),
  indices: z.array(z.number().int().positive()).optional().describe("1-based slide indices to select")
};

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "slidepix", version: "0.1.0" },
    { instructions: "Use list_slides before inspect_slides or render_slides when slide identifiers are not already known. These tools are read-only." }
  );

  server.registerTool("list_slides", {
    description: "List the slides and dimensions in a SlidePix deck without modifying it.",
    inputSchema: z.object({ deckPath: selectorSchema.deckPath })
  }, async ({ deckPath }) => {
    const deck = await loadDeck(deckPath);
    return { content: [{ type: "text", text: JSON.stringify({
      title: deck.metadata.title,
      dimensions: deck.size,
      slides: deck.slides.map((slide, index) => ({ id: slide.id, index: index + 1, title: slide.title, hidden: slide.hidden, hasNotes: Boolean(slide.notes.trim()) }))
    }, null, 2) }] };
  });

  server.registerTool("inspect_slides", {
    description: "Inspect structured slide and element metadata without modifying the deck.",
    inputSchema: z.object(selectorSchema)
  }, async ({ deckPath, slideIds, indices }) => {
    const deck = await loadDeck(deckPath);
    const slides = selectSlides(deck, slideIds, indices);
    return { content: [{ type: "text", text: JSON.stringify(slides.map((slide) => ({
      id: slide.id,
      index: deck.slides.findIndex((item) => item.id === slide.id) + 1,
      title: slide.title,
      notes: slide.notes,
      transition: slide.transition,
      timeline: slide.timeline,
      elements: slide.elements
    })), null, 2) }] };
  });

  server.registerTool("render_slides", {
    description: "Render one or more SlidePix slides into one PNG contact sheet for visual review.",
    inputSchema: z.object({
      ...selectorSchema,
      layout: z.enum(["grid", "row", "column"]).default("grid"),
      columns: z.number().int().positive().max(10).optional(),
      scale: z.number().min(0.1).max(3).default(1)
    })
  }, async ({ deckPath, slideIds, indices, layout, columns, scale }) => {
    const deck = await loadDeck(deckPath);
    const slides = selectSlides(deck, slideIds, indices);
    if (!slides.length) throw new Error("No slides selected.");
    const image = await renderSlidesToPng(deckPath, deck, slides, { layout, columns, scale });
    return { content: [
      { type: "image", data: image.toString("base64"), mimeType: "image/png" },
      { type: "text", text: `Rendered ${slides.length} slide${slides.length === 1 ? "" : "s"} from ${deck.metadata.title}.` }
    ] };
  });

  return server;
}

serveStdio(buildServer);

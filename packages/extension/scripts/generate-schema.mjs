import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { deckSchema } from "../../core/dist/index.js";

const directory = resolve("schema");
await mkdir(directory, { recursive: true });
const schema = z.toJSONSchema(deckSchema, { target: "draft-7" });
schema.title = "SlidePix deck";
schema.description = "A versioned SlidePix presentation deck.";
await writeFile(resolve(directory, "slidepix.schema.json"), `${JSON.stringify(schema, null, 2)}\n`);

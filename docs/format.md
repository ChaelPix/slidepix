# SlidePix deck format

Decks are strict, versioned JSON files ending in `.slidepix.json`. A deck named
`talk.slidepix.json` stores imported media in `talk.assets/`. All coordinates
are logical slide units and `(0, 0)` is the top-left corner.

The generated JSON Schema is contributed to VS Code for validation and
completion. To edit the JSON directly, use **Reopen Editor With… → Text Editor**.

Element IDs are unique. `morphKey` is intentionally preserved when a slide is
duplicated so matching elements can morph between slides.

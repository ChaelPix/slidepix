# SlidePix examples

## Manim demo

`slidepix-manim-demo.slidepix.json` shows linked Manim Community scripts and
embedded renders:

- `slidepix-manim-demo.manim.py` — `IntroStill` (PNG) and `MotionClip` (MP4)
- `slidepix-manim-demo.assets/` — content-addressed render output

Open `slidepix-manim-demo.slidepix.json` in SlidePix: renders are already
embedded, so no terminal setup is required. After editing
`slidepix-manim-demo.manim.py`, use **Render** on each Manim element in the
properties panel.

Maintainers can regenerate committed assets with
`node scripts/build-manim-demo.mjs` (uses the repo `uv` environment).

## Fourier

`manim/fourier.slidepix.json` is a short French talk on the Fourier transform.
Scenes live in `manim/fourier.manim.py`:

- `HarmonicsStill` — three odd harmonics and their sum (PNG)
- `BuildSquare` — partial sums toward a square wave (MP4)
- `TimeToFrequency` — a pure sine and the peak that tracks its frequency (MP4)
- `RectPulse` — a pulse of height A on `[0, X]`, and the sinc that widens as X shrinks (MP4)
- `EpicycleDraw` — rotating radii whose last point traces a closed outline (MP4)

Renders are already embedded in `manim/fourier.assets/`. After editing a scene,
select the Manim element and click **Render**.

## Product demo

`slidepix-demo.slidepix.json` is the canonical light-theme product demo and
visual-regression deck. It intentionally covers Markdown, LaTeX, highlighted
code, image border/radius/crop/fade, shapes, animations, ordinary transitions,
morph, Markdown tables with centered headers, transparent paint, shape shadows,
an embedded H.264 video, and a poster frame.

The generated hero image is stored by content hash in
`slidepix-demo.assets/`. Its production prompt requested a bright 16:9 soft-3D
visual of white slide cards flowing from a code editor into a presentation
screen, with blue, coral, and yellow accents, no readable text, no logos, no
people, and no watermark.

## Rebuild flow

1. Build core so the generator uses the current schema:

   ```sh
   pnpm --filter @slidepix/core build
   ```

2. Build the first six slides with the hero asset reference:

   ```sh
   node scripts/build-demo.mjs <hero-hash.png>
   ```

3. Export a frame for every visible slide:

   ```sh
   node scripts/render-smoke.mjs examples/slidepix-demo.slidepix.json /tmp/slidepix-demo
   ```

4. Assemble the exact-size PNG frames into a browser-safe demo reel:

   ```sh
   ffmpeg -y -framerate 0.4 -pattern_type glob \
     -i '/tmp/slidepix-demo/slides/slide-*.png' \
     -vf 'fps=30,format=yuv420p' -c:v libx264 -crf 20 \
     -movflags +faststart /tmp/slidepix-demo/slidepix-demo.mp4
   ```

5. Content-hash and copy the MP4 plus `slide-01.png` poster into
   `slidepix-demo.assets/`, then rerun `build-demo.mjs` with all three
   references:

   ```sh
   node scripts/build-demo.mjs <hero.png> <reel.mp4> <poster.png>
   ```

6. Run the smoke renderer again and visually inspect the contact sheet, PDF,
   and `slides/` frames. `packages/core/src/example.test.ts` enforces the
   feature coverage and checks every embedded asset exists.

Do not hand-edit content hashes. If an asset changes, generate its new SHA-256
name and update the deck through `build-demo.mjs`.

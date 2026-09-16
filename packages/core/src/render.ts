import MarkdownIt from "markdown-it";
import katex from "katex";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import cssLanguage from "highlight.js/lib/languages/css";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
// markdown-it-katex does not publish TypeScript declarations.
// @ts-ignore The plugin follows MarkdownIt's standard PluginSimple shape.
import markdownItKatex from "markdown-it-katex";
import type { Deck, ImageElement, MediaStorage, Slide, SlideElement } from "./schema.js";

for (const [name, language] of Object.entries({ bash, c, cpp, css: cssLanguage, java, javascript, json, markdown: markdownLanguage, python, rust, typescript, xml })) {
  hljs.registerLanguage(name, language);
}
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, language) {
    const requested = language.trim().toLowerCase();
    const selected = requested && hljs.getLanguage(requested) ? requested : undefined;
    const highlighted = selected ? hljs.highlight(code, { language: selected }) : hljs.highlightAuto(code);
    const lang = escapeHtml((selected ?? requested) || "text");
    return `<pre class="slidepix-code" data-language="${lang}"><code class="hljs">${highlighted.value}</code></pre>`;
  }
}).use(markdownItKatex, { output: "mathml", throwOnError: false });

markdown.validateLink = (url) => /^(https?:|mailto:|#)/i.test(url);

export type AssetResolver = (reference: string, storage: MediaStorage) => string;

export type PresentationTextRun = {
  kind: "text";
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
} | {
  kind: "math";
  latex: string;
};

export type PresentationCodeRun = {
  text: string;
  token?: string;
};

export type PresentationMarkdownBlock = {
  type: "paragraph" | "heading" | "list-item";
  runs: PresentationTextRun[];
  level?: number;
  ordered?: boolean;
} | {
  type: "code";
  code: string;
  language: string;
  runs: PresentationCodeRun[];
} | {
  type: "math";
  latex: string;
} | {
  type: "table";
  rows: PresentationTextRun[][][];
  headerRow: boolean;
};

export function renderMarkdown(source: string): string {
  return markdown.render(source);
}

export function renderPresentationMathMl(latex: string, displayMode = false): string {
  return katex.renderToString(latex, { output: "mathml", throwOnError: true, displayMode });
}

/**
 * Parses the same configured Markdown dialect used by renderMarkdown into a
 * presentation-neutral structure. Non-HTML exporters consume this instead of
 * maintaining a second Markdown interpretation.
 */
export function parsePresentationMarkdown(source: string): PresentationMarkdownBlock[] {
  const tokens = markdown.parse(source, {});
  const blocks: PresentationMarkdownBlock[] = [];
  const lists: Array<{ ordered: boolean }> = [];
  let headingLevel: number | undefined;
  let inListItem = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.type === "heading_open") {
      headingLevel = Number(token.tag.slice(1)) || 1;
      continue;
    }
    if (token.type === "heading_close") {
      headingLevel = undefined;
      continue;
    }
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      lists.push({ ordered: token.type === "ordered_list_open" });
      continue;
    }
    if (token.type === "bullet_list_close" || token.type === "ordered_list_close") {
      lists.pop();
      continue;
    }
    if (token.type === "list_item_open") {
      inListItem = true;
      continue;
    }
    if (token.type === "list_item_close") {
      inListItem = false;
      continue;
    }
    if (token.type === "table_open") {
      const rows: PresentationTextRun[][][] = [];
      let row: PresentationTextRun[][] | undefined;
      let headerRow = false;
      for (index += 1; index < tokens.length && tokens[index]!.type !== "table_close"; index += 1) {
        const tableToken = tokens[index]!;
        if (tableToken.type === "thead_open") headerRow = true;
        else if (tableToken.type === "tr_open") row = [];
        else if (tableToken.type === "tr_close" && row) {
          rows.push(row);
          row = undefined;
        } else if (tableToken.type === "inline" && row) {
          row.push(parseInlineRuns(tableToken.children ?? []));
        }
      }
      blocks.push({ type: "table", rows, headerRow });
      continue;
    }
    if (token.type === "inline") {
      const runs = parseInlineRuns(token.children ?? []);
      if (headingLevel !== undefined) blocks.push({ type: "heading", level: headingLevel, runs });
      else if (inListItem && lists.length) blocks.push({ type: "list-item", level: lists.length - 1, ordered: lists.at(-1)!.ordered, runs });
      else blocks.push({ type: "paragraph", runs });
      continue;
    }
    if (token.type === "fence" || token.type === "code_block") {
      const language = token.info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
      blocks.push({ type: "code", code: token.content, language, runs: highlightCodeRuns(token.content, language) });
      continue;
    }
    if (token.type === "math_block") blocks.push({ type: "math", latex: token.content.trim() });
  }
  return blocks;
}

function parseInlineRuns(tokens: Array<{ type: string; content: string; attrGet(name: string): string | null }>): PresentationTextRun[] {
  const runs: PresentationTextRun[] = [];
  const style = { bold: false, italic: false, strike: false, href: undefined as string | undefined };
  for (const token of tokens) {
    if (token.type === "strong_open") style.bold = true;
    else if (token.type === "strong_close") style.bold = false;
    else if (token.type === "em_open") style.italic = true;
    else if (token.type === "em_close") style.italic = false;
    else if (token.type === "s_open") style.strike = true;
    else if (token.type === "s_close") style.strike = false;
    else if (token.type === "link_open") style.href = token.attrGet("href") ?? undefined;
    else if (token.type === "link_close") style.href = undefined;
    else if (token.type === "math_inline") runs.push({ kind: "math", latex: token.content });
    else if (token.type === "softbreak" || token.type === "hardbreak") pushTextRun(runs, "\n", style);
    else if (token.type === "code_inline") pushTextRun(runs, token.content, { ...style, code: true });
    else if (token.type === "text") pushTextRun(runs, token.content, style);
    else if (token.type === "image") pushTextRun(runs, token.content, style);
  }
  return runs;
}

function pushTextRun(
  runs: PresentationTextRun[],
  text: string,
  style: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; href?: string }
): void {
  if (!text) return;
  const next: Extract<PresentationTextRun, { kind: "text" }> = {
    kind: "text",
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.strike ? { strike: true } : {}),
    ...(style.code ? { code: true } : {}),
    ...(style.href ? { href: style.href } : {})
  };
  const previous = runs.at(-1);
  if (previous?.kind === "text" && sameRunStyle(previous, next)) previous.text += text;
  else runs.push(next);
}

function sameRunStyle(left: Extract<PresentationTextRun, { kind: "text" }>, right: Extract<PresentationTextRun, { kind: "text" }>): boolean {
  return left.bold === right.bold && left.italic === right.italic && left.strike === right.strike && left.code === right.code && left.href === right.href;
}

function highlightCodeRuns(code: string, requestedLanguage: string): PresentationCodeRun[] {
  const selected = requestedLanguage && hljs.getLanguage(requestedLanguage) ? requestedLanguage : undefined;
  const html = selected ? hljs.highlight(code, { language: selected }).value : hljs.highlightAuto(code).value;
  const runs: PresentationCodeRun[] = [];
  const classes: string[] = [];
  for (const match of html.matchAll(/<span class="([^"]+)">|<\/span>|([^<]+)/g)) {
    if (match[1]) classes.push(match[1].split(/\s+/).find((value) => value.startsWith("hljs-")) ?? "");
    else if (match[0] === "</span>") classes.pop();
    else if (match[2]) {
      const text = decodeHtml(match[2]);
      const token = [...classes].reverse().find(Boolean);
      const previous = runs.at(-1);
      if (previous && previous.token === token) previous.text += text;
      else runs.push({ text, ...(token ? { token } : {}) });
    }
  }
  return runs;
}

function decodeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? "";
  });
}

export function roundedEdgeFadeMask(width: number, height: number, borderRadius: number, edgeFade: number): string | undefined {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const fade = Math.min(Math.max(0, edgeFade), Math.min(safeWidth, safeHeight) / 2);
  if (fade <= 0) return undefined;
  const radius = Math.min(Math.max(0, borderRadius), Math.min(safeWidth, safeHeight) / 2);
  const inset = Math.min(fade * 0.72, Math.min(safeWidth, safeHeight) / 2 - 0.01);
  const blur = Math.max(0.5, fade * 0.36);
  const innerRadius = Math.max(0, radius - inset);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${token(safeWidth)} ${token(safeHeight)}"><defs><filter id="fade" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${token(blur)}"/></filter></defs><rect x="${token(inset)}" y="${token(inset)}" width="${token(Math.max(0.01, safeWidth - inset * 2))}" height="${token(Math.max(0.01, safeHeight - inset * 2))}" rx="${token(innerRadius)}" fill="white" filter="url(#fade)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function renderSlideMarkup(
  deck: Deck,
  slide: Slide,
  visibleIndex: number,
  resolveAsset: AssetResolver = (value) => value
): string {
  const elements = [...slide.elements]
    .filter((element) => !element.hidden)
    .sort((a, b) => a.z - b.z)
    .map((element) => renderElement(element, resolveAsset))
    .join("");
  const background = slide.background ?? deck.layouts[slide.layout ?? ""]?.background ?? deck.theme.background;
  const pageNumber = deck.pageNumbers.enabled && !slide.hidePageNumber
    ? `<div class="slidepix-page-number" style="${attr(`color:${css(deck.pageNumbers.color)};font-size:${deck.pageNumbers.fontSize}px`)}">${visibleIndex + 1}</div>`
    : "";
  return `<section class="slidepix-slide" data-slide-id="${attr(slide.id)}" style="${attr(`width:${deck.size.width}px;height:${deck.size.height}px;background:${css(background)}`)}">${elements}${pageNumber}</section>`;
}

export function renderDeckDocument(
  deck: Deck,
  resolveAsset: AssetResolver = (value) => value,
  options: { mode?: "print" | "present" | "contact" | "frame"; selectedSlideIds?: string[]; columns?: number } = {}
): string {
  const mode = options.mode ?? "print";
  const selected = options.selectedSlideIds?.length ? new Set(options.selectedSlideIds) : undefined;
  const slides = deck.slides.filter((slide) => !slide.hidden && (!selected || selected.has(slide.id)));
  const markup = slides.map((slide) => {
    const visibleIndex = deck.slides.filter((item) => !item.hidden).findIndex((item) => item.id === slide.id);
    return renderSlideMarkup(deck, slide, visibleIndex, resolveAsset);
  }).join("");
  const columns = Math.max(1, options.columns ?? Math.ceil(Math.sqrt(slides.length)));
  const runtime = mode === "present" ? presentationScript(deck) : mode === "frame" ? frameScript(deck) : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${baseStyles(deck, mode, columns)}</style></head><body class="mode-${mode}"><main>${markup}</main>${runtime}</body></html>`;
}

function renderElement(element: SlideElement, resolveAsset: AssetResolver): string {
  const base = `left:${element.x}px;top:${element.y}px;width:${element.width}px;height:${element.height}px;transform:rotate(${element.rotation}deg);opacity:${element.opacity};z-index:${element.z}`;
  const common = `class="slidepix-element slidepix-${element.type}" data-element-id="${attr(element.id)}" data-morph-key="${attr(element.morphKey)}" style="${attr(base)}"`;
  switch (element.type) {
    case "text": {
      const align = element.style.verticalAlign === "middle" ? "center" : element.style.verticalAlign === "bottom" ? "flex-end" : "flex-start";
      const style = `font-family:${css(element.style.fontFamily)};font-size:${element.style.fontSize}px;font-weight:${css(String(element.style.fontWeight))};color:${css(element.style.color)};text-align:${element.style.textAlign};line-height:${element.style.lineHeight};padding:${element.style.padding}px;justify-content:${align}`;
      return `<div ${common}><div class="slidepix-text-content" style="${attr(style)}">${renderMarkdown(element.markdown)}</div></div>`;
    }
    case "image":
      return `<div ${common}>${imageMarkup(element, resolveAsset)}</div>`;
    case "video": {
      const autoplay = element.playback.mode === "autoplay" ? " autoplay" : "";
      const muted = element.playback.muted ? " muted" : "";
      const loop = element.playback.loop ? " loop" : "";
      const controls = element.playback.controls ? " controls" : "";
      const poster = element.poster ? ` poster="${attr(resolveAsset(element.poster, "embedded"))}"` : "";
      return `<div ${common}><video src="${attr(resolveAsset(element.src, element.storage))}"${poster}${autoplay}${muted}${loop}${controls} playsinline style="${attr(`border-radius:${element.borderRadius}px`)}"></video></div>`;
    }
    case "shape": {
      const clip = element.shape === "triangle" ? "clip-path:polygon(50% 0,100% 100%,0 100%);" : "";
      const radius = element.shape === "ellipse" ? "50%" : `${element.borderRadius}px`;
      const shadow = element.shadow.enabled ? `filter:drop-shadow(${element.shadow.offsetX}px ${element.shadow.offsetY}px ${element.shadow.blur}px ${css(element.shadow.color)});` : "";
      return `<div ${common}><div class="slidepix-shape-content" style="${attr(`${clip}${shadow}background:${css(element.fill)};border:${element.strokeWidth}px solid ${css(element.stroke)};border-radius:${radius}`)}"></div></div>`;
    }
    case "table": {
      const vertical = element.style.verticalAlign === "middle" ? "center" : element.style.verticalAlign === "bottom" ? "flex-end" : "flex-start";
      const rows = Array.from({ length: element.rows }, (_, row) => {
        const tag = element.headerRow && row === 0 ? "th" : "td";
        const fill = tag === "th" ? element.style.headerFill : element.style.cellFill;
        const cells = Array.from({ length: element.columns }, (_, column) => {
          const source = element.cells[row]?.[column] ?? "";
          const textAlign = tag === "th" ? "center" : element.style.textAlign;
          return `<${tag} style="${attr(`background:${css(fill)};border:${element.style.borderWidth}px solid ${css(element.style.borderColor)};padding:${element.style.padding}px;text-align:${textAlign}`)}"><div class="slidepix-table-cell" style="${attr(`justify-content:${vertical}`)}">${renderMarkdown(source)}</div></${tag}>`;
        }).join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      const style = `font-family:${css(element.style.fontFamily)};font-size:${element.style.fontSize}px;font-weight:${css(String(element.style.fontWeight))};color:${css(element.style.color)}`;
      return `<div ${common}><table class="slidepix-table-content" style="${attr(style)}"><tbody>${rows}</tbody></table></div>`;
    }
  }
}

function imageMarkup(element: ImageElement, resolveAsset: AssetResolver): string {
  const crop = element.crop;
  const width = 100 / crop.width;
  const height = 100 / crop.height;
  const left = -(crop.x / crop.width) * 100;
  const top = -(crop.y / crop.height) * 100;
  const mask = roundedEdgeFadeMask(element.width, element.height, element.borderRadius, element.edgeFade);
  const fade = mask ? `-webkit-mask-image:${mask};mask-image:${mask};-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;` : "";
  return `<div class="slidepix-image-clip" style="${attr(`border-radius:${element.borderRadius}px;border:${element.border.width}px solid ${css(element.border.color)};${fade}`)}"><img src="${attr(resolveAsset(element.src, element.storage))}" alt="${attr(element.alt ?? "")}" style="${attr(`width:${width}%;height:${height}%;left:${left}%;top:${top}%`)}"></div>`;
}

function baseStyles(deck: Deck, mode: string, columns: number): string {
  const contact = mode === "contact";
  return `
@import url("data:text/css,");
*{box-sizing:border-box}html{-webkit-text-size-adjust:none;text-size-adjust:none}html,body{margin:0;background:${css(deck.theme.background)};color:${css(deck.theme.foreground)};font-family:${css(deck.theme.fontFamily)}}
main{${contact ? `display:grid;grid-template-columns:repeat(${columns},${deck.size.width}px);gap:32px;padding:32px;width:max-content` : ""}}
.slidepix-slide{position:relative;overflow:hidden;isolation:isolate;page-break-inside:avoid;break-inside:avoid}
.slidepix-element{position:absolute;transform-origin:center center;overflow:visible}
.slidepix-text-content{width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden}
.slidepix-text-content>*:first-child{margin-top:0}.slidepix-text-content>*:last-child{margin-bottom:0}
.slidepix-text-content h1,.slidepix-text-content h2,.slidepix-text-content h3{line-height:1.08;margin:.25em 0}.slidepix-text-content h1{font-size:1.3em}.slidepix-text-content h2{font-size:1.15em}.slidepix-text-content h3{font-size:1em}
.slidepix-table-content{width:100%;height:100%;border-collapse:collapse;table-layout:fixed}.slidepix-table-content tr{height:auto}.slidepix-table-content th,.slidepix-table-content td{overflow:hidden}.slidepix-table-cell{width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden}.slidepix-table-cell>*:first-child{margin-top:0}.slidepix-table-cell>*:last-child{margin-bottom:0}
.slidepix-code{padding:.45em .6em;border-radius:.25em;background:#111827;color:#e2e8f0;white-space:pre-wrap;overflow:hidden}
.slidepix-code .hljs-keyword,.slidepix-code .hljs-selector-tag,.slidepix-code .hljs-literal{color:#c084fc}.slidepix-code .hljs-string,.slidepix-code .hljs-attr{color:#a7f3d0}.slidepix-code .hljs-number,.slidepix-code .hljs-symbol{color:#fbbf24}.slidepix-code .hljs-title,.slidepix-code .hljs-function .hljs-title{color:#7dd3fc}.slidepix-code .hljs-built_in,.slidepix-code .hljs-type{color:#f9a8d4}.slidepix-code .hljs-comment,.slidepix-code .hljs-quote{color:#94a3b8;font-style:italic}.slidepix-code .hljs-meta{color:#fb923c}.slidepix-code .hljs-variable,.slidepix-code .hljs-params{color:#e2e8f0}
.katex{font-size:1em}.katex-display{display:block;margin:.4em 0;text-align:center}.katex-html{display:none!important}.katex-mathml{display:inline-block}.katex-display .katex-mathml{display:block}.katex-mathml annotation{display:none}
.slidepix-image-clip,.slidepix-image-clip img,.slidepix-video video,.slidepix-shape-content{position:absolute;width:100%;height:100%}
.slidepix-image-clip{overflow:hidden}.slidepix-image-clip img{max-width:none;object-fit:fill}
.slidepix-video video{object-fit:cover}.slidepix-shape-content{inset:0}
.slidepix-page-number{position:absolute;right:32px;bottom:20px;z-index:2147483647}
@page{size:${deck.size.width}px ${deck.size.height}px;margin:0}
@media print{html,body{background:transparent}.slidepix-slide{margin:0}}
	body.mode-present{overflow:hidden}.mode-present main{position:relative;width:100vw;height:100vh;overflow:hidden}.mode-present .slidepix-slide{display:none;position:absolute;left:0;top:0;transform-origin:top left}
	body.mode-present .slidepix-slide.active,.mode-present .slidepix-slide.transitioning{display:block}
	body.mode-frame{overflow:hidden}.mode-frame main{position:relative;width:100vw;height:100vh}.mode-frame .slidepix-slide{position:absolute;left:0;top:0;transform-origin:top left}
	`;
}

function frameScript(deck: Deck): string {
  return `<script>(function(){
const slide=document.querySelector('.slidepix-slide');
function fit(){if(!slide)return;const k=Math.min(innerWidth/${deck.size.width},innerHeight/${deck.size.height});slide.style.transform='scale('+k+')';slide.style.left=(innerWidth-${deck.size.width}*k)/2+'px';slide.style.top=(innerHeight-${deck.size.height}*k)/2+'px'}
addEventListener('resize',fit);fit()
})();</script>`;
}

function presentationScript(deck: Deck): string {
  const transitions = JSON.stringify(deck.slides.filter((slide) => !slide.hidden).map((slide) => slide.transition));
  const timelines = JSON.stringify(deck.slides.filter((slide) => !slide.hidden).map((slide) => slide.timeline));
  return `<script>(function(){
const slides=[...document.querySelectorAll('.slidepix-slide')],transitions=${transitions},timelines=${timelines};let index=0,step=0,transitionRun=0;
function fitSlide(s){if(!s)return;const k=Math.min(innerWidth/${deck.size.width},innerHeight/${deck.size.height});s.style.transform='scale('+k+')';s.style.left=(innerWidth-${deck.size.width}*k)/2+'px';s.style.top=(innerHeight-${deck.size.height}*k)/2+'px'}
function fit(){for(const s of slides)if(s.classList.contains('active')||s.classList.contains('transitioning'))fitSlide(s)}
function rotation(e){const m=e.style.transform.match(/rotate\\(([-\\d.]+)deg\\)/);return Number(m?.[1]||0)}
function snapshot(slide){const map=new Map;if(!slide)return map;for(const e of slide.querySelectorAll('[data-morph-key]')){const image=e.querySelector('img'),clip=e.querySelector('.slidepix-image-clip');map.set(e.dataset.morphKey,{x:e.offsetLeft,y:e.offsetTop,width:e.offsetWidth,height:e.offsetHeight,rotation:rotation(e),opacity:getComputedStyle(e).opacity,image:image?{width:image.style.width,height:image.style.height,left:image.style.left,top:image.style.top}:null,radius:clip?.style.borderRadius})}return map}
function morph(slide,from,transition){for(const e of slide.querySelectorAll('[data-morph-key]')){const prior=from.get(e.dataset.morphKey),duration=transition.durationMs||500,easing=transition.easing||'ease-in-out';if(!prior){e.animate([{opacity:0},{opacity:e.style.opacity||1}],{duration,easing});continue}const sx=prior.width/Math.max(1,e.offsetWidth),sy=prior.height/Math.max(1,e.offsetHeight),dx=prior.x+prior.width/2-(e.offsetLeft+e.offsetWidth/2),dy=prior.y+prior.height/2-(e.offsetTop+e.offsetHeight/2),targetRotation=rotation(e);e.animate([{transform:'translate('+dx+'px,'+dy+'px) rotate('+prior.rotation+'deg) scale('+sx+','+sy+')',opacity:prior.opacity},{transform:'translate(0,0) rotate('+targetRotation+'deg) scale(1,1)',opacity:e.style.opacity||1}],{duration,easing});const image=e.querySelector('img');if(image&&prior.image)image.animate([prior.image,{width:image.style.width,height:image.style.height,left:image.style.left,top:image.style.top}],{duration,easing});const clip=e.querySelector('.slidepix-image-clip');if(clip&&prior.radius)clip.animate([{borderRadius:prior.radius},{borderRadius:clip.style.borderRadius}],{duration,easing})}}
function cancelAnimations(slide){if(!slide)return;for(const e of slide.querySelectorAll('[data-element-id]'))for(const animation of e.getAnimations?.()||[])animation.cancel()}
function reset(){step=0;const s=slides[index],line=timelines[index]||[],initial=new Map;cancelAnimations(s);for(const a of line)if(!initial.has(a.targetElementId))initial.set(a.targetElementId,a.phase==='exit');for(const [id,visible] of initial){const e=s?.querySelector('[data-element-id="'+CSS.escape(id)+'"]');if(e)e.style.visibility=visible?'visible':'hidden'}}
function finish(){const s=slides[index],line=timelines[index]||[];cancelAnimations(s);for(const a of line){const e=s?.querySelector('[data-element-id="'+CSS.escape(a.targetElementId)+'"]');if(e)e.style.visibility=a.phase==='exit'?'hidden':'visible'}step=line.length}
function pauseVideos(slide){if(!slide)return;for(const video of slide.querySelectorAll('video'))video.pause()}
function syncVideos(){slides.forEach((slide,slideIndex)=>{for(const video of slide.querySelectorAll('video')){if(slideIndex!==index){video.pause();continue}if(video.hasAttribute('autoplay'))video.play().catch(()=>{})}})}
function play(a,offset){const s=slides[index],e=s?.querySelector('[data-element-id="'+CSS.escape(a.targetElementId)+'"]');if(!e)return 0;const delay=(a.delayMs||0)+offset,duration=a.durationMs||0,fly=a.direction==='right'?['40px','0']:a.direction==='up'?['0','40px']:a.direction==='down'?['0','-40px']:['-40px','0'];setTimeout(()=>{if(a.phase==='entrance')e.style.visibility='visible';const from=a.effect==='appear'?{}:a.effect==='fly'?{opacity:0,translate:fly.join(' ')}:{opacity:0},to={opacity:a.phase==='exit'?0:1,translate:'0 0'};e.animate(a.phase==='exit'?[to,from]:[from,to],{duration,easing:a.easing||'ease-out',fill:'both'}).finished.then(()=>{if(a.phase==='exit')e.style.visibility='hidden'})},delay);return delay+duration}
function advance(){const line=timelines[index]||[];if(step>=line.length)return false;let cursor=0;do{const a=line[step++];cursor=play(a,a.trigger==='withPrevious'?0:cursor)}while(step<line.length&&line[step].trigger!=='onClick');return true}
function stopSlideTransitions(){transitionRun++;for(const s of slides){for(const animation of s.getAnimations?.()||[])animation.cancel();s.classList.remove('transitioning');s.style.zIndex=''}}
function keepTransitionSlides(current,previous){current.classList.add('transitioning');current.style.zIndex='1';if(previous){previous.classList.add('transitioning');previous.style.zIndex='0'}}
function settleTransition(run,current,previous,animations){Promise.allSettled(animations.map(animation=>animation.finished)).then(()=>{if(run!==transitionRun)return;current.classList.remove('transitioning');current.style.zIndex='';if(previous){previous.classList.remove('transitioning');previous.style.zIndex=''}})}
function slideVector(type){const direction=type.slice(6);return direction==='left'?['-100%','0']:direction==='right'?['100%','0']:direction==='up'?['0','-100%']:['0','100%']}
function opposite(value){return value==='0'?'0':value.startsWith('-')?value.slice(1):'-'+value}
function slideTransition(current,previous,transition){const run=transitionRun,[x,y]=slideVector(transition.type),duration=transition.durationMs||0,easing=transition.easing||'ease-in-out',base=current.style.transform;keepTransitionSlides(current,previous);const animations=[current.animate([{transform:base+' translate('+x+','+y+')'},{transform:base}],{duration,easing})];if(previous){const priorBase=previous.style.transform;animations.push(previous.animate([{transform:priorBase},{transform:priorBase+' translate('+opposite(x)+','+opposite(y)+')'}],{duration,easing}))}settleTransition(run,current,previous,animations)}
	function show(next,animationState='initial'){const bounded=Math.max(0,Math.min(slides.length-1,next)),active=slides[index]?.classList.contains('active');if(bounded===index&&active){animationState==='final'?finish():reset();syncVideos();fit();return}const previous=active?slides[index]:null,before=snapshot(previous);pauseVideos(previous);stopSlideTransitions();index=bounded;slides.forEach((s,i)=>s.classList.toggle('active',i===index));const t=transitions[index]||{type:'none',durationMs:0},s=slides[index];animationState==='final'?finish():reset();fit();if(t.type==='morph')morph(s,before,t);else if(t.type==='fade')s.animate([{opacity:0},{opacity:1}],{duration:t.durationMs,easing:t.easing});else if(t.type.startsWith('slide-'))slideTransition(s,previous,t);syncVideos()}
window.slidepixShow=show;window.slidepixAdvance=advance;addEventListener('resize',fit);addEventListener('visibilitychange',()=>{if(document.hidden)slides.forEach(pauseVideos);else syncVideos()});addEventListener('keydown',e=>{if(e.key==='f')document.documentElement.requestFullscreen?.()});show(0)
})();</script>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
}

const attr = escapeHtml;
function css(value: string): string {
  return value.replace(/[;{}]/g, "");
}

function token(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

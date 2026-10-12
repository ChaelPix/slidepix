import JSZip from "jszip";
import { renderPresentationMathMl, type AnimationStep, type ImageElement, type Slide } from "@slidepix/core";

export type PptxExportWarningCode =
  | "font-not-embedded"
  | "color-approximated"
  | "edge-fade-approximated"
  | "markdown-layout-approximated"
  | "math-linearized"
  | "table-rotation-omitted"
  | "video-playback-approximated"
  | "easing-approximated"
  | "morph-match-ambiguous"
  | "manim-not-rendered";

export interface PptxExportWarning {
  code: PptxExportWarningCode;
  message: string;
  slideId?: string;
  elementId?: string;
}

export interface MathPatch {
  placeholder: string;
  latex: string;
  display: boolean;
  objectName: string;
  slideId: string;
  elementId: string;
}

export interface PicturePatch {
  objectName: string;
  crop?: ImageElement["crop"];
  borderRadius?: number;
  edgeFade?: number;
  border?: ImageElement["border"];
  opacity?: number;
  rotation?: number;
}

export interface PptxSlidePatch {
  slide: Slide;
  math: MathPatch[];
  pictures: PicturePatch[];
  animationTargets: Map<string, string[]>;
}

export function addPptxWarning(
  warnings: PptxExportWarning[],
  code: PptxExportWarningCode,
  message: string,
  slideId?: string,
  elementId?: string
): void {
  if (warnings.some((item) => item.code === code && item.message === message && item.slideId === slideId && item.elementId === elementId)) return;
  warnings.push({ code, message, ...(slideId ? { slideId } : {}), ...(elementId ? { elementId } : {}) });
}

export async function postProcessPptx(bytes: Buffer, patches: PptxSlidePatch[], warnings: PptxExportWarning[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  for (let index = 0; index < patches.length; index += 1) {
    const patch = patches[index]!;
    const filename = `ppt/slides/slide${index + 1}.xml`;
    const entry = zip.file(filename);
    if (!entry) throw new Error(`Generated PowerPoint is missing ${filename}.`);
    let xml = await entry.async("string");
    for (const math of patch.math) xml = replaceMathPlaceholder(xml, math, warnings);
    xml = normalizeDrawingParagraphs(xml);
    xml = wrapMathShapes(xml, patch.math);
    for (const picture of patch.pictures) xml = patchPicture(xml, picture, patch.slide.id, warnings);
    xml = addTransition(xml, patch.slide);
    xml = addAnimations(xml, patch, warnings);
    zip.file(filename, xml);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

function replaceMathPlaceholder(xml: string, patch: MathPatch, warnings: PptxExportWarning[]): string {
  const placeholderText = `<a:t>${patch.placeholder}</a:t>`;
  const run = [...xml.matchAll(/<a:r(?:\s[^>]*)?>[\s\S]*?<\/a:r>/g)].find((match) => match[0].includes(placeholderText));
  if (!run || run.index === undefined) {
    addPptxWarning(warnings, "math-linearized", `Could not locate equation placeholder; kept editable LaTeX: ${patch.latex}`, patch.slideId, patch.elementId);
    return xml;
  }
  try {
    const root = parseXmlFragment(renderPresentationMathMl(patch.latex, patch.display));
    const math = findNode(root, "math");
    if (!math) throw new Error("KaTeX did not produce MathML.");
    const omml = mathChildren(math).map(mathNodeToOmml).join("");
    if (!omml) throw new Error("No OfficeMath content.");
    const body = patch.display
      ? `<m:oMathPara><m:oMathParaPr><m:jc m:val="centerGroup"/></m:oMathParaPr><m:oMath>${omml}</m:oMath></m:oMathPara>`
      : `<m:oMath>${omml}</m:oMath>`;
    const equation = `<a14:m xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${body}</a14:m>`;
    return `${xml.slice(0, run.index)}${equation}${xml.slice(run.index + run[0].length)}`;
  } catch {
    addPptxWarning(warnings, "math-linearized", `PowerPoint equation conversion does not support this expression yet; kept editable LaTeX: ${patch.latex}`, patch.slideId, patch.elementId);
    return xml.replaceAll(patch.placeholder, escapeXml(patch.latex));
  }
}

function normalizeDrawingParagraphs(xml: string): string {
  return xml.replace(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g, (paragraph) => {
    let foundParagraphProperties = false;
    return paragraph.replace(/<a:pPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:pPr>)/g, (properties) => {
      if (foundParagraphProperties) return "";
      foundParagraphProperties = true;
      return properties;
    });
  });
}

function wrapMathShapes(xml: string, patches: MathPatch[]): string {
  const byObjectName = new Map<string, MathPatch[]>();
  for (const patch of patches) {
    const group = byObjectName.get(patch.objectName) ?? [];
    group.push(patch);
    byObjectName.set(patch.objectName, group);
  }
  for (const [objectName, math] of byObjectName) {
    xml = xml.replace(/<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g, (shape) => {
      if (!shape.includes(`name="${escapeXmlAttribute(objectName)}"`) || !shape.includes("<a14:m")) return shape;
      let fallback = shape;
      let mathIndex = 0;
      fallback = fallback.replace(/<a14:m\b[^>]*>[\s\S]*?<\/a14:m>/g, () => {
        const patch = math[mathIndex++];
        const text = patch?.latex ?? "equation";
        return `<a:r><a:rPr lang="en-US" dirty="0"><a:latin typeface="Cambria Math"/><a:ea typeface="Cambria Math"/><a:cs typeface="Cambria Math"/></a:rPr><a:t>${escapeXml(text)}</a:t></a:r>`;
      });
      return `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="a14" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main">${shape}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`;
    });
  }
  return xml;
}

function patchPicture(xml: string, patch: PicturePatch, slideId: string, warnings: PptxExportWarning[]): string {
  let found = false;
  const result = xml.replace(/<p:pic>[\s\S]*?<\/p:pic>/g, (picture) => {
    if (!picture.includes(`name="${escapeXmlAttribute(patch.objectName)}"`)) return picture;
    found = true;
    let next = picture;
    if (patch.crop && !isFullCrop(patch.crop)) {
      const srcRect = `<a:srcRect l="${percent(patch.crop.x)}" t="${percent(patch.crop.y)}" r="${percent(1 - patch.crop.x - patch.crop.width)}" b="${percent(1 - patch.crop.y - patch.crop.height)}"/>`;
      next = next.replace(/<a:srcRect\b[^>]*\/>/, "");
      next = next.replace(/(<a:blip\b[^>]*\/>|<a:blip\b[^>]*>[\s\S]*?<\/a:blip>)/, `$1${srcRect}`);
    }
    if ((patch.borderRadius ?? 0) > 0) {
      const adjustment = Math.round(Math.min(50000, Math.max(1, (patch.borderRadius! / 216) * 100000)));
      next = next.replace(/<a:prstGeom prst="[^"]+">[\s\S]*?<\/a:prstGeom>/, `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adjustment}"/></a:avLst></a:prstGeom>`);
    }
    if ((patch.rotation ?? 0) !== 0) next = next.replace(/<a:xfrm(?![^>]*\brot=)/, `<a:xfrm rot="${Math.round(patch.rotation! * 60000)}"`);
    if ((patch.opacity ?? 1) < 1) next = addBlipAlpha(next, Math.round(Math.max(0, patch.opacity!) * 100000));
    if ((patch.edgeFade ?? 0) > 0) next = insertBeforeClosing(next, "p:spPr", `<a:effectLst><a:softEdge rad="${Math.round(patch.edgeFade! * 6350)}"/></a:effectLst>`);
    if (patch.border && patch.border.width > 0) {
      const paint = parsePptxColor(patch.border.color);
      if (!paint) addPptxWarning(warnings, "color-approximated", `Image border color “${patch.border.color}” was exported as black.`, slideId);
      const value = paint ?? { color: "000000", transparency: 0 };
      const alpha = value.transparency ? `<a:alpha val="${(100 - value.transparency) * 1000}"/>` : "";
      next = insertBeforeClosing(next, "p:spPr", `<a:ln w="${Math.round(patch.border.width * 6350)}"><a:solidFill><a:srgbClr val="${value.color}">${alpha}</a:srgbClr></a:solidFill></a:ln>`);
    }
    return next;
  });
  if (!found) throw new Error(`Generated PowerPoint did not contain native picture object ${patch.objectName}.`);
  return result;
}

function addBlipAlpha(xml: string, alpha: number): string {
  if (/<a:blip\b[^>]*\/>/.test(xml)) return xml.replace(/<a:blip\b([^>]*)\/>/, `<a:blip$1><a:alphaModFix amt="${alpha}"/></a:blip>`);
  return xml.replace(/<a:blip\b([^>]*)>/, `<a:blip$1><a:alphaModFix amt="${alpha}"/>`);
}

function addTransition(xml: string, slide: Slide): string {
  if (slide.transition.type === "none") return xml;
  const speed = slide.transition.durationMs >= 750 ? "slow" : slide.transition.durationMs <= 300 ? "fast" : "med";
  let transition: string;
  if (slide.transition.type === "fade") transition = `<p:transition spd="${speed}"><p:fade/></p:transition>`;
  else if (slide.transition.type === "morph") {
    xml = ensureSlideNamespaces(xml, { mc: "http://schemas.openxmlformats.org/markup-compatibility/2006", p159: "http://schemas.microsoft.com/office/powerpoint/2015/09/main" });
    transition = `<mc:AlternateContent><mc:Choice Requires="p159"><p:transition><p159:morph option="byObject"/></p:transition></mc:Choice><mc:Fallback><p:transition spd="${speed}"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`;
  } else {
    const direction = ({ "slide-left": "l", "slide-right": "r", "slide-up": "u", "slide-down": "d" } as const)[slide.transition.type];
    transition = `<p:transition spd="${speed}"><p:push dir="${direction}"/></p:transition>`;
  }
  return insertAfterSlideProperties(xml, transition);
}

function addAnimations(xml: string, patch: PptxSlidePatch, warnings: PptxExportWarning[]): string {
  if (!patch.slide.timeline.length) return xml;
  const idsByName = shapeIdsByName(xml);
  let nextId = 3;
  const effects: string[] = [];
  const buildIds = new Set<number>();
  for (const step of patch.slide.timeline) {
    const ids = (patch.animationTargets.get(step.targetElementId) ?? []).map((name) => idsByName.get(name)).filter((id): id is number => id !== undefined);
    if (!ids.length) continue;
    const nodeType = step.trigger === "onClick" ? "clickEffect" : step.trigger === "withPrevious" ? "withEffect" : "afterEffect";
    const preset = animationPreset(step);
    effects.push(ids.map((shapeId) => {
      buildIds.add(shapeId);
      const effectId = nextId++;
      const behaviorId = nextId++;
      const setId = nextId++;
      const entrance = step.phase === "entrance";
      const set = `<p:set><p:cBhvr><p:cTn id="${setId}" dur="1" fill="hold"><p:stCondLst><p:cond delay="${entrance ? 0 : step.durationMs}"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="${entrance ? "visible" : "hidden"}"/></p:to></p:set>`;
      const effect = step.effect === "appear" ? "" : `<p:animEffect transition="${entrance ? "in" : "out"}" filter="${animationFilter(step)}"><p:cBhvr><p:cTn id="${behaviorId}" dur="${Math.max(1, step.durationMs)}"${timingAcceleration(step, warnings, patch.slide.id)}/><p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl></p:cBhvr></p:animEffect>`;
      return `<p:par><p:cTn id="${effectId}" presetID="${preset.id}" presetClass="${entrance ? "entr" : "exit"}" presetSubtype="${preset.subtype}" fill="hold" nodeType="${nodeType}"><p:stCondLst><p:cond delay="${Math.max(0, step.delayMs)}"/></p:stCondLst><p:childTnLst>${entrance ? `${set}${effect}` : `${effect}${set}`}</p:childTnLst></p:cTn></p:par>`;
    }).join(""));
  }
  if (!effects.length) return xml;
  const builds = [...buildIds].map((id) => `<p:bldP spid="${id}" grpId="0"/>`).join("");
  const timing = `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${effects.join("")}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst>${builds}</p:bldLst></p:timing>`;
  return insertBeforeSlideEnd(xml, timing);
}

function timingAcceleration(step: AnimationStep, warnings: PptxExportWarning[], slideId: string): string {
  const easing = step.easing.trim().toLowerCase();
  if (easing === "linear") return "";
  if (easing === "ease-in") return " accel=\"50000\"";
  if (easing === "ease-out") return " decel=\"50000\"";
  if (easing === "ease-in-out" || easing === "ease") return " accel=\"25000\" decel=\"25000\"";
  addPptxWarning(warnings, "easing-approximated", `Animation easing “${step.easing}” is exported as linear timing.`, slideId, step.targetElementId);
  return "";
}

function animationPreset(step: AnimationStep): { id: number; subtype: number } {
  if (step.effect === "appear") return { id: 1, subtype: 0 };
  if (step.effect === "fade") return { id: 10, subtype: 0 };
  return { id: 2, subtype: ({ left: 8, right: 6, up: 2, down: 4 } as const)[step.direction ?? "down"] };
}

function animationFilter(step: AnimationStep): string {
  if (step.effect === "fade") return "fade";
  const direction = ({ left: "Left", right: "Right", up: "Top", down: "Bottom" } as const)[step.direction ?? "down"];
  return step.phase === "entrance" ? `slide(from${direction})` : `slide(to${direction})`;
}

function shapeIdsByName(xml: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const match of xml.matchAll(/<p:cNvPr\s+[^>]*\bid="(\d+)"[^>]*\bname="([^"]*)"[^>]*>/g)) result.set(decodeXml(match[2]!), Number(match[1]));
  return result;
}

type XmlNode = { name: string; attrs: Record<string, string>; children: Array<XmlNode | string> };

function parseXmlFragment(xml: string): XmlNode {
  const root: XmlNode = { name: "root", attrs: {}, children: [] };
  const stack = [root];
  for (const match of xml.matchAll(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g)) {
    const token = match[0];
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); }
    else if (token.startsWith("<")) {
      const opening = /^<([\w:-]+)([^>]*)\/?\s*>$/.exec(token);
      if (!opening) continue;
      const node: XmlNode = { name: opening[1]!.split(":").at(-1)!, attrs: {}, children: [] };
      for (const attr of opening[2]!.matchAll(/([\w:-]+)="([^"]*)"/g)) node.attrs[attr[1]!.split(":").at(-1)!] = decodeXml(attr[2]!);
      stack.at(-1)!.children.push(node);
      if (!token.endsWith("/>")) stack.push(node);
    } else if (token) stack.at(-1)!.children.push(decodeXml(token));
  }
  return root;
}

function findNode(node: XmlNode, name: string): XmlNode | undefined {
  if (node.name === name) return node;
  for (const child of node.children) if (typeof child !== "string") {
    const found = findNode(child, name);
    if (found) return found;
  }
  return undefined;
}

function mathChildren(node: XmlNode): XmlNode[] {
  if (node.name === "semantics") return node.children.filter((child): child is XmlNode => typeof child !== "string" && child.name !== "annotation").slice(0, 1);
  const semantics = node.children.find((child): child is XmlNode => typeof child !== "string" && child.name === "semantics");
  return semantics ? mathChildren(semantics) : node.children.filter((child): child is XmlNode => typeof child !== "string");
}

function mathNodeToOmml(node: XmlNode): string {
  const children = node.children.filter((child): child is XmlNode => typeof child !== "string");
  const content = () => children.map(mathNodeToOmml).join("") || node.children.filter((child): child is string => typeof child === "string").map((text) => mathTextRun(text)).join("");
  switch (node.name) {
    case "math": case "semantics": case "mrow": case "mstyle": case "mpadded": return content();
    case "mi": case "mn": case "mo": return mathTextRun(textContent(node));
    case "mtext": return mathTextRun(textContent(node), true);
    case "mspace": return mathTextRun(" ", true);
    case "msup": return `<m:sSup><m:e>${childOmml(children, 0)}</m:e><m:sup>${childOmml(children, 1)}</m:sup></m:sSup>`;
    case "msub": return `<m:sSub><m:e>${childOmml(children, 0)}</m:e><m:sub>${childOmml(children, 1)}</m:sub></m:sSub>`;
    case "msubsup": return `<m:sSubSup><m:e>${childOmml(children, 0)}</m:e><m:sub>${childOmml(children, 1)}</m:sub><m:sup>${childOmml(children, 2)}</m:sup></m:sSubSup>`;
    case "mfrac": return `<m:f><m:num>${childOmml(children, 0)}</m:num><m:den>${childOmml(children, 1)}</m:den></m:f>`;
    case "msqrt": return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${content()}</m:e></m:rad>`;
    case "mroot": return `<m:rad><m:deg>${childOmml(children, 1)}</m:deg><m:e>${childOmml(children, 0)}</m:e></m:rad>`;
    case "mover": return accentOrLimit(node, true);
    case "munder": return accentOrLimit(node, false);
    case "munderover": return `<m:limUpp><m:e><m:limLow><m:e>${childOmml(children, 0)}</m:e><m:lim>${childOmml(children, 1)}</m:lim></m:limLow></m:e><m:lim>${childOmml(children, 2)}</m:lim></m:limUpp>`;
    case "mfenced": return `<m:d><m:dPr><m:begChr m:val="${escapeXmlAttribute(node.attrs.open ?? "(")}"/><m:endChr m:val="${escapeXmlAttribute(node.attrs.close ?? ")")}"/></m:dPr><m:e>${content()}</m:e></m:d>`;
    case "mtable": return `<m:m>${children.map(mathNodeToOmml).join("")}</m:m>`;
    case "mtr": return `<m:mr>${children.map(mathNodeToOmml).join("")}</m:mr>`;
    case "mtd": return `<m:e>${content()}</m:e>`;
    case "annotation": return "";
    default: throw new Error(`Unsupported MathML element ${node.name}`);
  }
}

function childOmml(children: XmlNode[], index: number): string { return children[index] ? mathNodeToOmml(children[index]!) : ""; }

function accentOrLimit(node: XmlNode, upper: boolean): string {
  const children = node.children.filter((child): child is XmlNode => typeof child !== "string");
  if (node.attrs.accent === "true" || node.attrs.accentunder === "true") {
    return `<m:acc><m:accPr><m:chr m:val="${escapeXmlAttribute(children[1] ? textContent(children[1]) : "")}"/></m:accPr><m:e>${childOmml(children, 0)}</m:e></m:acc>`;
  }
  return upper
    ? `<m:limUpp><m:e>${childOmml(children, 0)}</m:e><m:lim>${childOmml(children, 1)}</m:lim></m:limUpp>`
    : `<m:limLow><m:e>${childOmml(children, 0)}</m:e><m:lim>${childOmml(children, 1)}</m:lim></m:limLow>`;
}

function mathTextRun(value: string, normal = false): string { return `<m:r><m:rPr><m:sty m:val="${normal ? "p" : "i"}"/></m:rPr><m:t>${escapeXml(value)}</m:t></m:r>`; }
function textContent(node: XmlNode): string { return node.children.map((child) => typeof child === "string" ? child : textContent(child)).join(""); }

function parsePptxColor(value: string): { color: string; transparency: number } | undefined {
  const text = value.trim();
  let match = /^#([0-9a-f]{3})([0-9a-f])?$/i.exec(text);
  if (match) return { color: [...match[1]!].map((digit) => digit + digit).join("").toUpperCase(), transparency: match[2] ? Math.round((1 - Number.parseInt(match[2] + match[2], 16) / 255) * 100) : 0 };
  match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text);
  if (match) return { color: match[1]!.toUpperCase(), transparency: match[2] ? Math.round((1 - Number.parseInt(match[2], 16) / 255) * 100) : 0 };
  return undefined;
}

function insertAfterSlideProperties(xml: string, fragment: string): string {
  return xml.includes("</p:clrMapOvr>") ? xml.replace("</p:clrMapOvr>", `</p:clrMapOvr>${fragment}`) : xml.replace("</p:cSld>", `</p:cSld>${fragment}`);
}
function insertBeforeSlideEnd(xml: string, fragment: string): string {
  const ext = xml.indexOf("<p:extLst");
  return ext >= 0 ? `${xml.slice(0, ext)}${fragment}${xml.slice(ext)}` : xml.replace("</p:sld>", `${fragment}</p:sld>`);
}
function insertBeforeClosing(xml: string, tag: string, fragment: string): string { return xml.replace(`</${tag}>`, `${fragment}</${tag}>`); }
function ensureSlideNamespaces(xml: string, namespaces: Record<string, string>): string {
  return xml.replace(/<p:sld\b([^>]*)>/, (_opening, attributes: string) => {
    let next = attributes;
    for (const [prefix, uri] of Object.entries(namespaces)) if (!next.includes(`xmlns:${prefix}=`)) next += ` xmlns:${prefix}="${uri}"`;
    return `<p:sld${next}>`;
  });
}
function isFullCrop(crop: ImageElement["crop"]): boolean { return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1; }
function percent(value: number): number { return Math.round(Math.max(0, Math.min(1, value)) * 100000); }
function escapeXml(value: string): string { return value.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!); }
function escapeXmlAttribute(value: string): string { return escapeXml(value).replace(/"/g, "&quot;"); }
function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    if (entity[0] === "#") { const hex = entity[1]?.toLowerCase() === "x"; return String.fromCodePoint(Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)); }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? "";
  });
}

import Moveable from "react-moveable";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  duplicateSlide,
  type AnimationStep,
  type Deck,
  type HostToWebviewMessage,
  type Slide,
  type SlideElement,
  type Transition
} from "@slidepix/core";
import { SlideView } from "./SlideView";
import { useDeckStore } from "./store";
import { onHostMessage, postMessage } from "./vscode";

type Tab = "properties" | "layers" | "animations";
const transitionTypes: Transition["type"][] = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "morph"];
const pendingAssets = new Map<string, (reference?: string, error?: string) => void>();

export default function App() {
  const store = useDeckStore();
  const [tab, setTab] = useState<Tab>("properties");
  const [editingTextId, setEditingTextId] = useState<string>();
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);

  useEffect(() => onHostMessage((message) => handleHostMessage(message, store.setFromHost, store.setInvalid)), []);
  useEffect(() => { postMessage({ type: "ready" }); }, []);

  const deck = store.deck;
  const slide = deck?.slides.find((item) => item.id === store.selectedSlideId) ?? deck?.slides[0];
  const selected = slide?.elements.find((item) => item.id === store.selectedElementId);
  const target = selected && !selected.locked ? document.getElementById(`element-${selected.id}`) : null;

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!deck || !slide || !selected || editingTextId || ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement).tagName)) return;
      const delta = event.shiftKey ? 10 : 1;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        store.mutate((draft) => {
          const element = findElement(draft, slide.id, selected.id);
          if (!element) return;
          if (event.key === "ArrowLeft") element.x -= delta;
          if (event.key === "ArrowRight") element.x += delta;
          if (event.key === "ArrowUp") element.y -= delta;
          if (event.key === "ArrowDown") element.y += delta;
        });
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteElement(deck, slide.id, selected.id, store.mutate, store.selectElement);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [deck, slide, selected, editingTextId]);

  if (store.error) return <InvalidDeck message={store.error} />;
  if (!deck || !slide) return <div className="loading">Opening SlidePix…</div>;

  const assetUrl = (reference: string) => `${store.sourceUri?.replace(/\/$/, "")}/${reference}`;
  const importFile = async (file: File, kind: "image" | "video") => {
    if (file.size > 100 * 1024 * 1024) return void alert("Media files are limited to 100 MB per import.");
    const reference = await sendAsset(file);
    if (!reference) return;
    store.mutate((draft) => {
      const targetSlide = draft.slides.find((item) => item.id === slide.id)!;
      const common = baseElement(targetSlide.elements.length);
      targetSlide.elements.push(kind === "image"
        ? { ...common, type: "image", src: reference, crop: { x: 0, y: 0, width: 1, height: 1 }, borderRadius: 0, edgeFade: 0, border: { width: 0, color: "transparent" }, alt: file.name }
        : { ...common, type: "video", src: reference, poster: undefined, borderRadius: 0, playback: { mode: "manual", muted: false, loop: false, controls: true } });
    });
  };

  const addText = () => store.mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.elements.push({
    ...baseElement(slide.elements.length),
    type: "text",
    markdown: "Double-click to edit",
    style: { fontFamily: deck.theme.fontFamily, fontSize: 48, fontWeight: 400, color: deck.theme.foreground, textAlign: "left", verticalAlign: "top", lineHeight: 1.2, padding: 8 }
  }));
  const addShape = (shape: "rectangle" | "ellipse" | "triangle") => store.mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.elements.push({
    ...baseElement(slide.elements.length), type: "shape", shape, fill: deck.theme.accent, stroke: "transparent", strokeWidth: 0, borderRadius: 0
  }));

  return (
    <div className="app" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      if (!file) return;
      if (file.type.startsWith("image/")) void importFile(file, "image");
      else if (file.type.startsWith("video/")) void importFile(file, "video");
    }} onPaste={(event) => {
      const file = [...event.clipboardData.files][0];
      if (file?.type.startsWith("image/")) void importFile(file, "image");
      else if (event.clipboardData.getData("text/plain")) {
        const text = event.clipboardData.getData("text/plain");
        store.mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.elements.push({
          ...baseElement(slide.elements.length), type: "text", markdown: text,
          style: { fontFamily: deck.theme.fontFamily, fontSize: 42, fontWeight: 400, color: deck.theme.foreground, textAlign: "left", verticalAlign: "top", lineHeight: 1.2, padding: 8 }
        }));
      }
    }}>
      <Toolbar
        deck={deck}
        slide={slide}
        addText={addText}
        addShape={addShape}
        chooseImage={() => imageInput.current?.click()}
        chooseVideo={() => videoInput.current?.click()}
        selectedIds={store.selectedElementId ? [store.selectedElementId] : []}
      />
      <input ref={imageInput} hidden type="file" accept="image/*" onChange={(event) => event.target.files?.[0] && void importFile(event.target.files[0], "image")} />
      <input ref={videoInput} hidden type="file" accept="video/*" onChange={(event) => event.target.files?.[0] && void importFile(event.target.files[0], "video")} />
      <SlideRail deck={deck} selectedId={slide.id} select={store.selectSlide} mutate={store.mutate} />
      <main className="workspace">
        <div className="canvas-scroll">
          <div className="canvas-frame" style={{ width: deck.size.width * store.zoom, height: deck.size.height * store.zoom }}>
            <SlideView
              deck={deck}
              slide={slide}
              scale={store.zoom}
              interactive
              selectedElementId={store.selectedElementId}
              resolveAsset={assetUrl}
              onSelectElement={store.selectElement}
              onEditText={setEditingTextId}
            />
            {target && selected && (
              <Moveable
                target={target}
                draggable
                resizable
                rotatable
                snappable
                origin={false}
                zoom={1 / store.zoom}
                onDrag={({ left, top, target: elementTarget }) => {
                  elementTarget.style.left = `${left}px`;
                  elementTarget.style.top = `${top}px`;
                  store.mutate((draft) => { const element = findElement(draft, slide.id, selected.id); if (element) { element.x = left; element.y = top; } });
                }}
                onResize={({ width, height, drag, target: elementTarget }) => {
                  elementTarget.style.width = `${width}px`;
                  elementTarget.style.height = `${height}px`;
                  elementTarget.style.left = `${drag.left}px`;
                  elementTarget.style.top = `${drag.top}px`;
                  store.mutate((draft) => { const element = findElement(draft, slide.id, selected.id); if (element) { element.width = width; element.height = height; element.x = drag.left; element.y = drag.top; } });
                }}
                onRotate={({ rotation, target: elementTarget }) => {
                  elementTarget.style.transform = `rotate(${rotation}deg)`;
                  store.mutate((draft) => { const element = findElement(draft, slide.id, selected.id); if (element) element.rotation = rotation; });
                }}
              />
            )}
          </div>
        </div>
        <div className="notes"><label>Speaker notes</label><textarea value={slide.notes} onChange={(event) => store.mutate((draft) => { draft.slides.find((item) => item.id === slide.id)!.notes = event.target.value; })} /></div>
      </main>
      <Inspector tab={tab} setTab={setTab} deck={deck} slide={slide} element={selected} mutate={store.mutate} selectElement={store.selectElement} />
      <div className="zoom-control"><button onClick={() => store.setZoom(store.zoom - 0.1)}>−</button><span>{Math.round(store.zoom * 100)}%</span><button onClick={() => store.setZoom(store.zoom + 0.1)}>+</button></div>
      {editingTextId && <TextEditor deck={deck} slideId={slide.id} elementId={editingTextId} mutate={store.mutate} close={() => setEditingTextId(undefined)} />}
    </div>
  );
}

function Toolbar({ deck, slide, addText, addShape, chooseImage, chooseVideo, selectedIds }: {
  deck: Deck; slide: Slide; addText(): void; addShape(shape: "rectangle" | "ellipse" | "triangle"): void; chooseImage(): void; chooseVideo(): void; selectedIds: string[];
}) {
  return <header className="toolbar">
    <div className="brand"><span className="codicon codicon-preview" /> SlidePix</div>
    <button onClick={addText}><span className="codicon codicon-symbol-string" /> Text</button>
    <button onClick={chooseImage}><span className="codicon codicon-file-media" /> Image</button>
    <button onClick={chooseVideo}><span className="codicon codicon-device-camera-video" /> Video</button>
    <select aria-label="Add shape" defaultValue="" onChange={(event) => { if (event.target.value) addShape(event.target.value as "rectangle" | "ellipse" | "triangle"); event.target.value = ""; }}>
      <option value="" disabled>Shape…</option><option value="rectangle">Rectangle</option><option value="ellipse">Circle</option><option value="triangle">Triangle</option>
    </select>
    <span className="toolbar-spacer" />
    <button onClick={() => postMessage({ type: "command", command: "save" })}><span className="codicon codicon-save" /> Save</button>
    <button onClick={() => postMessage({ type: "command", command: "exportPng", slideIds: [slide.id] })}>Export PNG</button>
    <button onClick={() => postMessage({ type: "command", command: "exportPdf" })}>Export PDF</button>
    <button onClick={() => postMessage({ type: "command", command: "configureMcp" })}>MCP</button>
    <button className="primary" onClick={() => postMessage({ type: "command", command: "present" })}><span className="codicon codicon-play" /> Present</button>
    <button onClick={() => postMessage({ type: "command", command: "presenter" })}>Presenter</button>
  </header>;
}

function SlideRail({ deck, selectedId, select, mutate }: { deck: Deck; selectedId: string; select(id: string): void; mutate(fn: (deck: Deck) => void): void }) {
  const addSlide = () => mutate((draft) => draft.slides.push({ id: crypto.randomUUID(), title: `Slide ${draft.slides.length + 1}`, notes: "", hidden: false, hidePageNumber: false, transition: { type: "none", durationMs: 500, easing: "ease-in-out" }, timeline: [], elements: [] }));
  return <aside className="slide-rail">
    <div className="rail-header"><strong>Slides</strong><button title="Add slide" onClick={addSlide}>＋</button></div>
    <div className="rail-scroll">
      {deck.slides.map((slide, index) => <div key={slide.id} className="rail-entry">
        {index > 0 && <button className="transition-gap" title="Change transition" onClick={() => mutate((draft) => {
          const target = draft.slides[index]!;
          const current = transitionTypes.indexOf(target.transition.type);
          target.transition.type = transitionTypes[(current + 1) % transitionTypes.length]!;
        })}><span>{slide.transition.type === "none" ? "＋ transition" : slide.transition.type}</span></button>}
        <button className={`thumbnail ${selectedId === slide.id ? "active" : ""}`} onClick={() => select(slide.id)}>
          <span className="slide-index">{index + 1}</span>
          <div className="thumb-clip" style={{ width: 192, height: 108 }}><SlideView deck={deck} slide={slide} scale={0.1} /></div>
          <span className="slide-title">{slide.title}{slide.hidden ? " (hidden)" : ""}</span>
        </button>
        <div className="rail-actions">
          <button title="Duplicate" onClick={() => mutate((draft) => draft.slides.splice(index + 1, 0, duplicateSlide(draft.slides[index]!)))}>⧉</button>
          <button title="Move up" disabled={index === 0} onClick={() => mutate((draft) => { const [item] = draft.slides.splice(index, 1); if (item) draft.slides.splice(index - 1, 0, item); })}>↑</button>
          <button title="Move down" disabled={index === deck.slides.length - 1} onClick={() => mutate((draft) => { const [item] = draft.slides.splice(index, 1); if (item) draft.slides.splice(index + 1, 0, item); })}>↓</button>
          <button title="Hide" onClick={() => mutate((draft) => { draft.slides[index]!.hidden = !draft.slides[index]!.hidden; })}>◉</button>
          <button title="Delete" disabled={deck.slides.length === 1} onClick={() => mutate((draft) => draft.slides.splice(index, 1))}>×</button>
        </div>
      </div>)}
    </div>
  </aside>;
}

function Inspector({ tab, setTab, deck, slide, element, mutate, selectElement }: {
  tab: Tab; setTab(tab: Tab): void; deck: Deck; slide: Slide; element?: SlideElement; mutate(fn: (deck: Deck) => void): void; selectElement(id?: string): void;
}) {
  const update = (patch: Partial<SlideElement>) => element && mutate((draft) => Object.assign(findElement(draft, slide.id, element.id)!, patch));
  return <aside className="inspector">
    <nav>{(["properties", "layers", "animations"] as const).map((value) => <button className={tab === value ? "active" : ""} onClick={() => setTab(value)} key={value}>{value}</button>)}</nav>
    <div className="inspector-body">
      {tab === "properties" && <>
        <h3>{element ? element.type : "Slide"}</h3>
        {element ? <>
          <div className="field-grid">
            <NumberField label="X" value={element.x} onChange={(x) => update({ x })} />
            <NumberField label="Y" value={element.y} onChange={(y) => update({ y })} />
            <NumberField label="W" value={element.width} onChange={(width) => update({ width })} />
            <NumberField label="H" value={element.height} onChange={(height) => update({ height })} />
            <NumberField label="Rotate" value={element.rotation} onChange={(rotation) => update({ rotation })} />
            <NumberField label="Opacity" value={element.opacity} step={0.05} onChange={(opacity) => update({ opacity })} />
          </div>
          {element.type === "text" && <>
            <ColorField label="Text color" value={element.style.color} onChange={(color) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.color = color; })} />
            <NumberField label="Font size" value={element.style.fontSize} onChange={(fontSize) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.fontSize = fontSize; })} />
            <label>Font family<input value={element.style.fontFamily} onChange={(event) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.fontFamily = event.target.value; })} /></label>
            <label>Alignment<select value={element.style.textAlign} onChange={(event) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.textAlign = event.target.value as "left" | "center" | "right"; })}><option>left</option><option>center</option><option>right</option></select></label>
          </>}
          {element.type === "shape" && <ColorField label="Fill" value={element.fill} onChange={(fill) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.fill = fill; })} />}
          {(element.type === "image" || element.type === "video") && <NumberField label="Corner radius" value={element.borderRadius} onChange={(borderRadius) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image" || target?.type === "video") target.borderRadius = borderRadius; })} />}
          {element.type === "image" && <>
            <NumberField label="Edge fade" value={element.edgeFade} onChange={(edgeFade) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.edgeFade = edgeFade; })} />
            <h4>Crop (normalized)</h4><div className="field-grid">
              {(["x", "y", "width", "height"] as const).map((key) => <NumberField key={key} label={key} value={element.crop[key]} step={0.01} onChange={(value) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.crop[key] = Math.max(key === "width" || key === "height" ? 0.01 : 0, Math.min(1, value)); })} />)}
            </div>
            <label>Alt text<textarea value={element.alt ?? ""} onChange={(event) => update({ alt: event.target.value })} /></label>
          </>}
          {element.type === "video" && <>
            <label>Playback<select value={element.playback.mode} onChange={(event) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.mode = event.target.value as "manual" | "autoplay"; })}><option value="manual">Manual</option><option value="autoplay">Autoplay</option></select></label>
            <label><input type="checkbox" checked={element.playback.muted} onChange={(event) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.muted = event.target.checked; })} /> Muted</label>
            <label><input type="checkbox" checked={element.playback.loop} onChange={(event) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.loop = event.target.checked; })} /> Loop</label>
            <label><input type="checkbox" checked={element.playback.controls} onChange={(event) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.controls = event.target.checked; })} /> Controls</label>
          </>}
        </> : <>
          <label>Slide title<input value={slide.title} onChange={(event) => mutate((draft) => { draft.slides.find((item) => item.id === slide.id)!.title = event.target.value; })} /></label>
          <ColorField label="Background" value={slide.background ?? deck.theme.background} onChange={(background) => mutate((draft) => { draft.slides.find((item) => item.id === slide.id)!.background = background; })} />
          <label><input type="checkbox" checked={slide.hidePageNumber} onChange={(event) => mutate((draft) => { draft.slides.find((item) => item.id === slide.id)!.hidePageNumber = event.target.checked; })} /> Hide page number</label>
        </>}
      </>}
      {tab === "layers" && <><h3>Layers</h3>{[...slide.elements].sort((a, b) => b.z - a.z).map((item) => <div className={`layer-row ${item.id === element?.id ? "active" : ""}`} key={item.id} onClick={() => selectElement(item.id)}><span>{item.name ?? `${item.type} ${item.id.slice(0, 4)}`}</span><button onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.locked = !target.locked; }); }}>{item.locked ? "🔒" : "🔓"}</button><button onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.hidden = !target.hidden; }); }}>{item.hidden ? "○" : "●"}</button><button onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.z += 1; }); }}>↑</button><button onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.z -= 1; }); }}>↓</button></div>)}</>}
      {tab === "animations" && <><h3>Animation timeline</h3><button disabled={!element} onClick={() => element && mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.timeline.push(defaultAnimation(element.id)))}>＋ Add entrance</button>{slide.timeline.map((step, index) => <AnimationRow key={step.id} step={step} index={index} mutate={(patch) => mutate((draft) => Object.assign(draft.slides.find((item) => item.id === slide.id)!.timeline[index]!, patch))} remove={() => mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.timeline.splice(index, 1))} />)}</>}
    </div>
  </aside>;
}

function AnimationRow({ step, index, mutate, remove }: { step: AnimationStep; index: number; mutate(patch: Partial<AnimationStep>): void; remove(): void }) {
  return <div className="animation-row"><strong>{index + 1}. {step.effect}</strong><select value={step.effect} onChange={(e) => mutate({ effect: e.target.value as AnimationStep["effect"] })}><option>appear</option><option>fade</option><option>fly</option></select><select value={step.trigger} onChange={(e) => mutate({ trigger: e.target.value as AnimationStep["trigger"] })}><option value="onClick">on click</option><option value="withPrevious">with previous</option><option value="afterPrevious">after previous</option></select><NumberField label="Delay ms" value={step.delayMs} onChange={(delayMs) => mutate({ delayMs })} /><NumberField label="Duration ms" value={step.durationMs} onChange={(durationMs) => mutate({ durationMs })} /><button onClick={remove}>Remove</button></div>;
}

function TextEditor({ deck, slideId, elementId, mutate, close }: { deck: Deck; slideId: string; elementId: string; mutate(fn: (deck: Deck) => void): void; close(): void }) {
  const element = findElement(deck, slideId, elementId);
  if (element?.type !== "text") return null;
  return <div className="modal-backdrop" onMouseDown={close}><div className="text-editor" onMouseDown={(event) => event.stopPropagation()}><header><strong>Markdown · LaTeX · Code</strong><button onClick={close}>Done</button></header><textarea autoFocus value={element.markdown} onChange={(event) => mutate((draft) => { const target = findElement(draft, slideId, elementId); if (target?.type === "text") target.markdown = event.target.value; })} /><p>Use <code>$x^2$</code>, <code>$$…$$</code>, and fenced code blocks.</p></div></div>;
}

function NumberField({ label, value, step = 1, onChange }: { label: string; value: number; step?: number; onChange(value: number): void }) { return <label>{label}<input type="number" value={Number.isFinite(value) ? value : 0} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>; }
function ColorField({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) { return <label>{label}<span className="color-field"><input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(event) => onChange(event.target.value)} /><input value={value} onChange={(event) => onChange(event.target.value)} /></span></label>; }
function InvalidDeck({ message }: { message: string }) { return <div className="invalid"><h1>SlidePix could not open this deck</h1><pre>{message}</pre><p>Fix the JSON in the text editor. SlidePix will reopen the last valid preview automatically.</p></div>; }

function baseElement(z: number) { return { id: crypto.randomUUID(), morphKey: crypto.randomUUID(), x: 240, y: 240, width: 640, height: 360, rotation: 0, opacity: 1, z, locked: false, hidden: false } as const; }
function defaultAnimation(targetElementId: string): AnimationStep { return { id: crypto.randomUUID(), targetElementId, phase: "entrance", effect: "fade", trigger: "onClick", delayMs: 0, durationMs: 500, easing: "ease-out" }; }
function findElement(deck: Deck, slideId: string, elementId: string) { return deck.slides.find((item) => item.id === slideId)?.elements.find((item) => item.id === elementId); }
function deleteElement(deck: Deck, slideId: string, elementId: string, mutate: (fn: (deck: Deck) => void) => void, select: (id?: string) => void) { mutate((draft) => { const target = draft.slides.find((item) => item.id === slideId)!; target.elements = target.elements.filter((item) => item.id !== elementId); target.timeline = target.timeline.filter((step) => step.targetElementId !== elementId); }); select(); }
function handleHostMessage(message: HostToWebviewMessage, setDeck: (deck: Deck, uri: string) => void, setInvalid: (message: string, uri: string) => void) { if (message.type === "deck") setDeck(message.deck, message.uri); else if (message.type === "invalidDeck") setInvalid(message.message, message.uri); else if (message.type === "assetImported") { pendingAssets.get(message.requestId)?.(message.reference, message.error); pendingAssets.delete(message.requestId); } }
async function sendAsset(file: File): Promise<string | undefined> { const requestId = crypto.randomUUID(); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return new Promise((resolve) => { pendingAssets.set(requestId, (reference, error) => { if (error) alert(error); resolve(reference); }); postMessage({ type: "importAsset", requestId, name: file.name, mime: file.type, base64: btoa(binary) }); }); }

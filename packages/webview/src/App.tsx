import Moveable from "react-moveable";
import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import {
  duplicateSlide,
  elementSchema,
  renderMarkdown,
  type AnimationStep,
  type Deck,
  type HostToWebviewMessage,
  type MediaStorage,
  type Slide,
  type SlideElement,
  type Transition
} from "@slidepix/core";
import { SlideView } from "./SlideView";
import { clamp, cropZoomPercent, localPointerDelta, scaleCrop, scaleCropAround, setCropZoom } from "./geometry";
import { useDeckStore } from "./store";
import { onHostMessage, postMessage } from "./vscode";

type Tab = "properties" | "layers" | "animations";
const transitionTypes: Transition["type"][] = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "morph"];
type MediaResult = { reference: string; storage: MediaStorage };
const pendingAssets = new Map<string, (result?: MediaResult, error?: string) => void>();
const pendingFonts = new Map<string, (family?: string, error?: string) => void>();
const SLIDEPIX_CLIPBOARD_TYPE = "application/x-slidepix-elements+json";
type SlidePixClipboard = { version: 1; token: string; deckId: string; sourceSlideId: string; elements: SlideElement[] };
let slidepixClipboard: SlidePixClipboard | undefined;

export default function App() {
  const store = useDeckStore();
  const [tab, setTab] = useState<Tab>("properties");
  const [editingTextId, setEditingTextId] = useState<string>();
  const [cropElementId, setCropElementId] = useState<string>();
  const [notesCollapsed, setNotesCollapsed] = useState(false);

  useEffect(() => onHostMessage((message) => handleHostMessage(message, store.setFromHost, store.setInvalid)), []);
  useEffect(() => { postMessage({ type: "ready" }); }, []);

  const deck = store.deck;
  const slide = deck?.slides.find((item) => item.id === store.selectedSlideId) ?? deck?.slides[0];
  const selected = slide?.elements.find((item) => item.id === store.selectedElementId);
  const target = selected && !selected.locked ? document.getElementById(`element-${selected.id}`) : null;
  const cropActive = selected?.type === "image" && cropElementId === selected.id;

  useEffect(() => {
    if (!selected || selected.type !== "image" || selected.id !== cropElementId) setCropElementId(undefined);
  }, [selected?.id, selected?.type, cropElementId]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const textEntry = isTextEntryTarget(event.target);
      const accelerator = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLowerCase();
      if (accelerator && !textEntry && (key === "z" || key === "y")) {
        event.preventDefault();
        const redo = key === "y" || (key === "z" && event.shiftKey);
        postMessage({ type: "command", command: redo ? "redo" : "undo" });
        return;
      }
      if (event.key === "Escape" && cropElementId) {
        event.preventDefault();
        setCropElementId(undefined);
        return;
      }
      if (!deck || !slide || !selected || editingTextId || textEntry) return;
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
  }, [deck, slide, selected, editingTextId, cropElementId]);

  if (store.error) return <InvalidDeck message={store.error} />;
  if (!deck || !slide) return <div className="loading">Opening SlidePix…</div>;

  const assetUrl = (reference: string, storage: MediaStorage) => {
    const base = storage === "linked" ? store.linkedSourceUri : store.sourceUri;
    if (!base) return reference;
    try { return new URL(reference.replaceAll("\\", "/"), `${base.replace(/\/$/, "")}/`).toString(); } catch { return reference; }
  };
  const addMedia = (kind: "image" | "video", result: MediaResult, name?: string, elementId?: string) => store.mutate((draft) => {
    const targetSlide = draft.slides.find((item) => item.id === slide.id)!;
    const existing = elementId ? targetSlide.elements.find((item) => item.id === elementId) : undefined;
    if (existing?.type === kind) {
      existing.src = result.reference;
      existing.storage = result.storage;
      return;
    }
    const common = baseElement(targetSlide.elements.length, kind);
    targetSlide.elements.push(kind === "image"
      ? { ...common, type: "image", src: result.reference, storage: result.storage, crop: { x: 0, y: 0, width: 1, height: 1 }, borderRadius: 0, edgeFade: 0, border: { width: 0, color: "transparent" }, alt: name ?? "" }
      : { ...common, type: "video", src: result.reference, storage: result.storage, poster: undefined, borderRadius: 0, playback: { mode: "manual", muted: false, loop: false, controls: true } });
  });
  const requestMedia = (kind: "image" | "video", uri?: string, elementId?: string) => {
    const requestId = crypto.randomUUID();
    pendingAssets.set(requestId, (result, error) => {
      if (error) return void alert(error);
      if (result) addMedia(kind, result, undefined, elementId);
    });
    postMessage(uri ? { type: "linkMedia", requestId, kind, uri } : { type: "selectMedia", requestId, kind });
  };
  const importFile = async (file: File, kind: "image" | "video") => {
    if (file.size > 100 * 1024 * 1024) return void alert("Media files are limited to 100 MB per import.");
    const result = await sendAsset(file);
    if (result) addMedia(kind, result, file.name);
  };

  const addText = () => store.mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.elements.push({
    ...baseElement(slide.elements.length, "text"),
    type: "text",
    markdown: "Double-click to edit",
    style: { fontFamily: deck.theme.fontFamily, fontSize: 48, fontWeight: 400, color: deck.theme.foreground, textAlign: "left", verticalAlign: "top", lineHeight: 1.2, padding: 8 }
  }));
  const addShape = (shape: "rectangle" | "ellipse" | "triangle") => store.mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.elements.push({
    ...baseElement(slide.elements.length, "shape"), type: "shape", shape, fill: deck.theme.accent, stroke: "transparent", strokeWidth: 0, borderRadius: 0,
    shadow: { enabled: false, color: "#00000040", offsetX: 0, offsetY: 12, blur: 24 }
  }));
  const addTable = () => store.mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.elements.push({
    ...baseElement(slide.elements.length, "table"), type: "table", width: 960, height: 420, rows: 3, columns: 3, headerRow: true,
    cells: [["Header 1", "Header 2", "Header 3"], ["", "", ""], ["", "", ""]],
    style: { fontFamily: deck.theme.fontFamily, fontSize: 30, fontWeight: 400, color: deck.theme.foreground, headerFill: "#e0e7ff", cellFill: "#ffffff", borderColor: "#94a3b8", borderWidth: 2, textAlign: "left", verticalAlign: "middle", padding: 10 }
  }));
  const copyElement = (event: ReactClipboardEvent<HTMLDivElement>, cut = false) => {
    if (!selected || isTextEntryTarget(event.target)) return;
    event.preventDefault();
    slidepixClipboard = { version: 1, token: crypto.randomUUID(), deckId: deck.id, sourceSlideId: slide.id, elements: [structuredClone(selected)] };
    event.clipboardData.setData(SLIDEPIX_CLIPBOARD_TYPE, JSON.stringify(slidepixClipboard));
    event.clipboardData.setData("text/plain", `slidepix://clipboard/${slidepixClipboard.token}`);
    if (cut) deleteElement(deck, slide.id, selected.id, store.mutate, store.selectElement);
  };
  const paste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (isTextEntryTarget(event.target)) return;
    const file = [...event.clipboardData.files][0];
    if (file?.type.startsWith("image/")) { event.preventDefault(); void importFile(file, "image"); return; }
    const payload = readSlidePixClipboard(event.clipboardData);
    if (payload) {
      event.preventDefault();
      if (payload.deckId !== deck.id) return void alert("Copying elements between different deck files is not supported yet. Embed and re-add the media instead.");
      const preserveMorphKey = payload.sourceSlideId !== slide.id;
      const pasted = payload.elements.map((element) => cloneElementForPaste(element, preserveMorphKey));
      store.mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.elements.push(...pasted));
      store.selectElement(pasted.at(-1)?.id);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (text) {
      event.preventDefault();
      store.mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.elements.push({
        ...baseElement(slide.elements.length, "text"), type: "text", markdown: text,
        style: { fontFamily: deck.theme.fontFamily, fontSize: 42, fontWeight: 400, color: deck.theme.foreground, textAlign: "left", verticalAlign: "top", lineHeight: 1.2, padding: 8 }
      }));
    }
  };

  return (
    <div className="app" onCopy={(event) => copyElement(event)} onCut={(event) => copyElement(event, true)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      const uri = droppedFileUri(event.dataTransfer);
      if (uri) {
        const kind = mediaKindFromPath(uri);
        if (kind) requestMedia(kind, uri);
        else alert("Drop an image or video file from the Explorer.");
        return;
      }
      const file = event.dataTransfer.files[0];
      if (!file) return;
      if (file.type.startsWith("image/")) void importFile(file, "image");
      else if (file.type.startsWith("video/")) void importFile(file, "video");
    }} onPaste={paste}>
      <Toolbar
        slide={slide}
        addText={addText}
        addShape={addShape}
        addTable={addTable}
        chooseImage={() => requestMedia("image")}
        chooseVideo={() => requestMedia("video")}
        hasLinkedMedia={deck.slides.some((item) => item.elements.some((element) => (element.type === "image" || element.type === "video") && element.storage === "linked"))}
      />
      <SlideRail deck={deck} selectedId={slide.id} select={store.selectSlide} mutate={store.mutate} resolveAsset={assetUrl} />
      <main className={`workspace ${notesCollapsed ? "notes-collapsed" : ""}`}>
        <div className="canvas-scroll" onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          store.setZoom(store.zoom * Math.exp(-event.deltaY * 0.002));
        }}>
          <div className="canvas-frame" style={{ width: deck.size.width * store.zoom, height: deck.size.height * store.zoom }}>
            <div
              className="canvas-scale"
              style={{ width: deck.size.width, height: deck.size.height, zoom: store.zoom }}
            >
              <SlideView
                deck={deck}
                slide={slide}
                interactive
                selectedElementId={store.selectedElementId}
                resolveAsset={assetUrl}
                onSelectElement={store.selectElement}
                onEditText={setEditingTextId}
                onEditImage={setCropElementId}
              />
              {target && selected && !cropActive && (
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
                    store.preview((draft) => { const element = findElement(draft, slide.id, selected.id); if (element) { element.x = left; element.y = top; } });
                  }}
                  onDragEnd={store.commit}
                  onResize={({ width, height, drag, target: elementTarget }) => {
                    elementTarget.style.width = `${width}px`;
                    elementTarget.style.height = `${height}px`;
                    elementTarget.style.left = `${drag.left}px`;
                    elementTarget.style.top = `${drag.top}px`;
                    store.preview((draft) => { const element = findElement(draft, slide.id, selected.id); if (element) { element.width = width; element.height = height; element.x = drag.left; element.y = drag.top; } });
                  }}
                  onResizeEnd={store.commit}
                  onRotate={({ rotation, target: elementTarget }) => {
                    elementTarget.style.transform = `rotate(${rotation}deg)`;
                    store.preview((draft) => { const element = findElement(draft, slide.id, selected.id); if (element) element.rotation = rotation; });
                  }}
                  onRotateEnd={store.commit}
                />
              )}
              {selected && (selected.type === "image" || selected.type === "video") && <MediaControls element={selected} source={selected.type === "image" ? assetUrl(selected.src, selected.storage) : undefined} cropActive={cropActive} zoom={store.zoom} preview={(patch) => store.preview((draft) => Object.assign(findElement(draft, slide.id, selected.id)!, patch))} commit={store.commit} finishCrop={() => setCropElementId(undefined)} />}
            </div>
          </div>
        </div>
        <section className="notes">
          <header className="notes-header">
            <strong>Speaker notes</strong>
            <button className="icon-button" title={notesCollapsed ? "Show speaker notes" : "Collapse speaker notes"} aria-label={notesCollapsed ? "Show speaker notes" : "Collapse speaker notes"} onClick={() => setNotesCollapsed((value) => !value)}>
              <span className={`codicon codicon-chevron-${notesCollapsed ? "up" : "down"}`} />
            </button>
          </header>
          {!notesCollapsed && <textarea aria-label="Speaker notes" value={slide.notes} onChange={(event) => store.mutate((draft) => { draft.slides.find((item) => item.id === slide.id)!.notes = event.target.value; })} />}
        </section>
      </main>
      <Inspector tab={tab} setTab={setTab} deck={deck} slide={slide} element={selected} cropActive={cropActive} mutate={store.mutate} preview={store.preview} commit={store.commit} selectElement={store.selectElement} editText={setEditingTextId} editImage={setCropElementId} relinkMedia={(kind, id) => requestMedia(kind, undefined, id)} />
      <div className="zoom-control" title="Ctrl/Cmd + mouse wheel also zooms the canvas"><button aria-label="Zoom out" onClick={() => store.setZoom(store.zoom - 0.1)}>−</button><input aria-label="Canvas zoom" type="range" min="10" max="150" step="5" value={Math.round(store.zoom * 100)} onChange={(event) => store.setZoom(Number(event.target.value) / 100)} /><span>{Math.round(store.zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => store.setZoom(store.zoom + 0.1)}>+</button></div>
      {editingTextId && <TextEditor deck={deck} slideId={slide.id} elementId={editingTextId} mutate={store.mutate} close={() => setEditingTextId(undefined)} />}
    </div>
  );
}

function Toolbar({ slide, addText, addShape, addTable, chooseImage, chooseVideo, hasLinkedMedia }: {
  slide: Slide; addText(): void; addShape(shape: "rectangle" | "ellipse" | "triangle"): void; addTable(): void; chooseImage(): void; chooseVideo(): void; hasLinkedMedia: boolean;
}) {
  return <header className="toolbar">
    <div className="brand"><span className="codicon codicon-preview" /><span>SlidePix</span></div>
    <div className="ribbon-group history-actions"><div className="ribbon-actions">
      <RibbonButton icon="discard" label="Undo" onClick={() => postMessage({ type: "command", command: "undo" })} />
      <RibbonButton icon="redo" label="Redo" onClick={() => postMessage({ type: "command", command: "redo" })} />
    </div></div>
    <div className="ribbon-group"><span className="ribbon-label">Insert</span><div className="ribbon-actions">
      <RibbonButton icon="symbol-string" label="Text" onClick={addText} />
      <RibbonButton icon="file-media" label="Image" onClick={chooseImage} />
      <RibbonButton icon="device-camera-video" label="Video" onClick={chooseVideo} />
      <RibbonButton icon="table" label="Table" onClick={addTable} />
      <label className="ribbon-select"><span className="codicon codicon-symbol-structure" /><select aria-label="Add shape" defaultValue="" onChange={(event) => { if (event.target.value) addShape(event.target.value as "rectangle" | "ellipse" | "triangle"); event.target.value = ""; }}><option value="" disabled>Shape</option><option value="rectangle">Rectangle</option><option value="ellipse">Circle</option><option value="triangle">Triangle</option></select></label>
    </div></div>
    <span className="toolbar-spacer" />
    <div className="ribbon-group"><span className="ribbon-label">File &amp; export</span><div className="ribbon-actions">
      <RibbonButton icon="save" label="Save" onClick={() => postMessage({ type: "command", command: "save" })} />
      <RibbonButton icon="file-media" label="PNG" onClick={() => postMessage({ type: "command", command: "exportPng", slideIds: [slide.id] })} />
      <RibbonButton icon="file-pdf" label="PDF" onClick={() => postMessage({ type: "command", command: "exportPdf" })} />
      <RibbonButton icon="globe" label="Web" onClick={() => postMessage({ type: "command", command: "exportWeb" })} />
      <RibbonButton icon="package" label="Embed all" disabled={!hasLinkedMedia} onClick={() => postMessage({ type: "embedMedia" })} />
      <RibbonButton icon="hubot" label="MCP" onClick={() => postMessage({ type: "command", command: "configureMcp" })} />
    </div></div>
    <div className="ribbon-group"><span className="ribbon-label">Slide show</span><div className="ribbon-actions">
      <RibbonButton icon="play" label="Present" primary onClick={() => postMessage({ type: "command", command: "present" })} />
      <RibbonButton icon="multiple-windows" label="Presenter" onClick={() => postMessage({ type: "command", command: "presenter" })} />
    </div></div>
  </header>;
}

function RibbonButton({ icon, label, primary, disabled, onClick }: { icon: string; label: string; primary?: boolean; disabled?: boolean; onClick(): void }) {
  return <button className={`ribbon-button ${primary ? "primary" : ""}`} title={label} disabled={disabled} onClick={onClick}><span className={`codicon codicon-${icon}`} /><span>{label}</span></button>;
}

function SlideRail({ deck, selectedId, select, mutate, resolveAsset }: { deck: Deck; selectedId: string; select(id: string): void; mutate(fn: (deck: Deck) => void): void; resolveAsset(source: string, storage: MediaStorage): string }) {
  const [transitionSlideId, setTransitionSlideId] = useState<string>();
  const addSlide = () => mutate((draft) => draft.slides.push({ id: crypto.randomUUID(), title: `Slide ${draft.slides.length + 1}`, notes: "", hidden: false, hidePageNumber: false, transition: { type: "none", durationMs: 500, easing: "ease-in-out" }, timeline: [], elements: [] }));
  return <aside className="slide-rail">
    <div className="rail-header"><strong>Slides</strong><button title="Add slide" onClick={addSlide}>＋</button></div>
    <div className="rail-scroll">
      {deck.slides.map((slide, index) => <div key={slide.id} className="rail-entry">
        {index > 0 && <><button className={`transition-gap ${transitionSlideId === slide.id ? "active" : ""} ${slide.transition.type !== "none" ? "has-transition" : ""}`} title="Edit incoming transition" onClick={() => setTransitionSlideId((current) => current === slide.id ? undefined : slide.id)}><span className="codicon codicon-arrow-swap" /> <span>{slide.transition.type === "none" ? "Add transition" : transitionLabel(slide.transition.type)}</span></button>{transitionSlideId === slide.id && <TransitionEditor transition={slide.transition} update={(patch) => mutate((draft) => Object.assign(draft.slides[index]!.transition, patch))} close={() => setTransitionSlideId(undefined)} />}</>}
        <button className={`thumbnail ${selectedId === slide.id ? "active" : ""}`} onClick={() => select(slide.id)}>
          <span className="slide-index">{index + 1}</span>
          <div className="thumb-clip" style={{ width: 192, height: 108 }}><SlideView deck={deck} slide={slide} scale={0.1} resolveAsset={resolveAsset} /></div>
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

function TransitionEditor({ transition, update, close }: { transition: Transition; update(patch: Partial<Transition>): void; close(): void }) {
  return <div className="transition-editor" onClick={(event) => event.stopPropagation()}>
    <header><strong>Incoming transition</strong><button className="icon-button" aria-label="Close transition editor" onClick={close}>×</button></header>
    <div className="transition-options">{transitionTypes.map((type) => <button key={type} className={transition.type === type ? "active" : ""} title={transitionLabel(type)} onClick={() => update({ type })}><span className={`codicon codicon-${transitionIcon(type)}`} /><span>{transitionLabel(type)}</span></button>)}</div>
    <label>Duration <span>{transition.durationMs} ms</span><input type="range" min="0" max="3000" step="100" value={transition.durationMs} onChange={(event) => update({ durationMs: Number(event.target.value) })} /></label>
  </div>;
}

type MediaElement = Extract<SlideElement, { type: "image" | "video" }>;

function MediaControls({ element, source, cropActive, zoom, preview, commit, finishCrop }: { element: MediaElement; source?: string; cropActive: boolean; zoom: number; preview(patch: Partial<MediaElement>): void; commit(): void; finishCrop(): void }) {
  const wheelCommit = useRef<number | undefined>(undefined);
  const maxRadius = Math.max(1, Math.min(element.width, element.height) / 2);
  const radius = Math.min(maxRadius, element.borderRadius);
  const handleSize = 14 / zoom;
  const overlayStyle = { left: element.x, top: element.y, width: element.width, height: element.height, transform: `rotate(${element.rotation}deg)` };
  const radiusDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const initial = radius;
    startPointerDrag(event, (deltaX, deltaY) => {
      const local = localPointerDelta(deltaX, deltaY, element.rotation, zoom);
      preview({ borderRadius: clamp(initial + local.x, 0, maxRadius) });
    }, commit);
  };
  const fadeDrag = element.type === "image" ? (event: ReactPointerEvent<HTMLButtonElement>) => {
    const initial = element.edgeFade;
    startPointerDrag(event, (deltaX, deltaY) => {
      const local = localPointerDelta(deltaX, deltaY, element.rotation, zoom);
      preview({ edgeFade: clamp(initial - local.y, 0, Math.min(element.width, element.height) / 2) });
    }, commit);
  } : undefined;
  const panCrop = element.type === "image" ? (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const crop = { ...element.crop };
    startPointerDrag(event, (deltaX, deltaY) => {
      const local = localPointerDelta(deltaX, deltaY, element.rotation, zoom);
      preview({ crop: {
        ...crop,
        x: clamp(crop.x - (local.x / Math.max(1, element.width)) * crop.width, 0, 1 - crop.width),
        y: clamp(crop.y - (local.y / Math.max(1, element.height)) * crop.height, 0, 1 - crop.height)
      } });
    }, commit);
  } : undefined;
  const zoomCrop = element.type === "image" ? (event: ReactPointerEvent<HTMLButtonElement>) => {
    const crop = { ...element.crop };
    startPointerDrag(event, (deltaX, deltaY) => {
      const local = localPointerDelta(deltaX, deltaY, element.rotation, zoom);
      const factor = Math.exp((local.x / Math.max(1, element.width) + local.y / Math.max(1, element.height)) * 0.55);
      preview({ crop: scaleCrop(crop, factor) });
    }, commit);
  } : undefined;
  const wheelCrop = element.type === "image" ? (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const local = localPointerDelta(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2), element.rotation, zoom);
    const anchorX = clamp(0.5 + local.x / Math.max(1, element.width), 0, 1);
    const anchorY = clamp(0.5 + local.y / Math.max(1, element.height), 0, 1);
    preview({ crop: scaleCropAround(element.crop, Math.exp(event.deltaY * 0.0015), anchorX, anchorY) });
    if (wheelCommit.current) window.clearTimeout(wheelCommit.current);
    wheelCommit.current = window.setTimeout(commit, 180);
  } : undefined;

  const updateCrop = (crop: Extract<SlideElement, { type: "image" }>["crop"]) => { preview({ crop } as Partial<MediaElement>); commit(); };
  return <div className={`media-controls ${cropActive ? "crop-active" : ""}`} style={overlayStyle}>
    {cropActive && element.type === "image" && <>
      {source && <img className="crop-ghost" src={source} alt="" style={{ width: `${100 / element.crop.width}%`, height: `${100 / element.crop.height}%`, left: `${-(element.crop.x / element.crop.width) * 100}%`, top: `${-(element.crop.y / element.crop.height) * 100}%` }} />}
      <div className="crop-surface" onPointerDown={panCrop} onWheel={wheelCrop}>
        <div className="crop-toolbar" style={{ fontSize: 12 / zoom, top: 12 / zoom, gap: 5 / zoom, padding: `${5 / zoom}px ${7 / zoom}px` }} onPointerDown={(event) => event.stopPropagation()}>
          <span>Drag to move · ratio locked</span>
          <button title="Zoom out" onClick={() => updateCrop(scaleCrop(element.crop, 1.2))}>−</button>
          <input className="crop-zoom-slider" aria-label="Crop zoom" type="range" min="100" max="1000" step="5" value={cropZoomPercent(element.crop)} style={{ width: 130 / zoom }} onChange={(event) => preview({ crop: setCropZoom(element.crop, Number(event.target.value)) })} onPointerUp={commit} onPointerCancel={commit} onKeyUp={commit} onBlur={commit} />
          <output>{cropZoomPercent(element.crop)}%</output>
          <button title="Zoom in" onClick={() => updateCrop(scaleCrop(element.crop, 1 / 1.2))}>＋</button>
          <button title="Reset crop" onClick={() => updateCrop({ x: 0, y: 0, width: 1, height: 1 })}>Reset</button>
          <button className="crop-done" onClick={finishCrop}>Done</button>
        </div>
        <i className="crop-corner top-left" /><i className="crop-corner top-right" /><i className="crop-corner bottom-left" /><button className="crop-zoom-handle crop-corner bottom-right" aria-label="Adjust image crop zoom" title="Drag diagonally to zoom while keeping the crop ratio" onPointerDown={zoomCrop} />
        <span className="crop-hint" style={{ fontSize: 12 / zoom, bottom: 12 / zoom }}>Drag anywhere to reposition · wheel to zoom</span>
      </div>
    </>}
    {!cropActive && <>
      <button className="media-handle radius-handle" title="Drag to change corner radius" aria-label="Adjust corner radius" style={{ left: `${(radius / Math.max(1, element.width)) * 100}%`, width: handleSize, height: handleSize }} onPointerDown={radiusDrag} />
      {element.type === "image" && <button className="media-handle fade-handle" title="Drag inward to fade all edges" aria-label="Adjust edge fade" style={{ bottom: `${(element.edgeFade / Math.max(1, element.height)) * 100}%`, width: handleSize, height: handleSize }} onPointerDown={fadeDrag} />}
    </>}
  </div>;
}

function Inspector({ tab, setTab, deck, slide, element, cropActive, mutate, preview, commit, selectElement, editText, editImage, relinkMedia }: {
  tab: Tab; setTab(tab: Tab): void; deck: Deck; slide: Slide; element?: SlideElement; cropActive: boolean; mutate(fn: (deck: Deck) => void): void; preview(fn: (deck: Deck) => void): void; commit(): void; selectElement(id?: string): void; editText(id: string): void; editImage(id: string): void; relinkMedia(kind: "image" | "video", id: string): void;
}) {
  const update = (patch: Partial<SlideElement>) => element && mutate((draft) => Object.assign(findElement(draft, slide.id, element.id)!, patch));
  return <aside className="inspector">
    <nav>{(["properties", "layers", "animations"] as const).map((value) => <button className={tab === value ? "active" : ""} onClick={() => setTab(value)} key={value}>{value}</button>)}</nav>
    <div className="inspector-body">
      {tab === "properties" && <>
        <h3>{element ? element.type : "Slide"}</h3>
        {element ? <>
          <label>Element name<input autoComplete="off" value={element.name ?? ""} placeholder={elementLabel(element)} onChange={(event) => update({ name: event.target.value.trimStart() || undefined })} /></label>
          <h4 className="property-heading">Geometry</h4>
          <div className="field-grid geometry-grid">
            <NumberField label="X" value={element.x} onChange={(x) => update({ x })} />
            <NumberField label="Y" value={element.y} onChange={(y) => update({ y })} />
            <NumberField label="W" value={element.width} min={0} onChange={(width) => update({ width })} />
            <NumberField label="H" value={element.height} min={0} onChange={(height) => update({ height })} />
            <NumberField label="Rotate" value={element.rotation} onChange={(rotation) => update({ rotation })} />
            <NumberField label="Opacity" value={element.opacity} step={0.05} min={0} max={1} onChange={(opacity) => update({ opacity })} />
          </div>
          <h4 className="property-heading">Appearance</h4>
          {element.type === "text" && <>
            <button className="edit-text-button" onClick={() => editText(element.id)}>Edit Markdown · LaTeX · Code…</button>
            <ColorField label="Text color" value={element.style.color} onChange={(color) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.color = color; })} />
            <NumberField label="Font size" value={element.style.fontSize} onChange={(fontSize) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.fontSize = fontSize; })} />
            <FontFamilyPicker value={element.style.fontFamily} onChange={(fontFamily) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.fontFamily = fontFamily; })} />
            <label>Alignment<select value={element.style.textAlign} onChange={(event) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.textAlign = event.target.value as "left" | "center" | "right"; })}><option>left</option><option>center</option><option>right</option></select></label>
          </>}
          {element.type === "shape" && <>
            <ColorField label="Fill" value={element.fill} allowTransparent onChange={(fill) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.fill = fill; })} />
            <NumberField label="Border width" value={element.strokeWidth} onChange={(strokeWidth) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.strokeWidth = Math.max(0, strokeWidth); })} />
            <ColorField label="Border color" value={element.stroke} allowTransparent onChange={(stroke) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.stroke = stroke; })} />
            <CheckboxField label="Shadow" checked={element.shadow.enabled} onChange={(enabled) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.shadow.enabled = enabled; })} />
            {element.shadow.enabled && <>
              <ColorField label="Shadow color" value={element.shadow.color} allowTransparent onChange={(color) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.shadow.color = color; })} />
              <div className="field-grid"><NumberField label="Shadow X" value={element.shadow.offsetX} onChange={(offsetX) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.shadow.offsetX = offsetX; })} /><NumberField label="Shadow Y" value={element.shadow.offsetY} onChange={(offsetY) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.shadow.offsetY = offsetY; })} /></div>
              <RangeField label="Shadow blur" value={element.shadow.blur} min={0} max={160} onChange={(blur) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.shadow.blur = blur; })} onCommit={commit} />
            </>}
          </>}
          {element.type === "table" && <>
            <div className="table-size-actions">
              <button onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows + 1, target.columns); })}>＋ Row</button>
              <button disabled={element.rows <= 1} onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows - 1, target.columns); })}>− Row</button>
              <button onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows, target.columns + 1); })}>＋ Column</button>
              <button disabled={element.columns <= 1} onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows, target.columns - 1); })}>− Column</button>
            </div>
            <CheckboxField label="Header row" checked={element.headerRow} onChange={(headerRow) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.headerRow = headerRow; })} />
            <div className="table-cell-editor" style={{ gridTemplateColumns: `repeat(${element.columns}, minmax(86px, 1fr))` }}>
              {Array.from({ length: element.rows }, (_, row) => Array.from({ length: element.columns }, (_, column) => <textarea className={row === 0 && element.headerRow ? "header-cell" : ""} key={`${row}-${column}`} aria-label={`Row ${row + 1}, column ${column + 1}`} value={element.cells[row]?.[column] ?? ""} onChange={(event) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type !== "table") return; target.cells = normalizedTableCells(target); target.cells[row]![column] = event.target.value; })} />))}
            </div>
            <NumberField label="Font size" value={element.style.fontSize} onChange={(fontSize) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.fontSize = Math.max(0, fontSize); })} />
            <FontFamilyPicker value={element.style.fontFamily} onChange={(fontFamily) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.fontFamily = fontFamily; })} />
            <ColorField label="Text color" value={element.style.color} onChange={(color) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.color = color; })} />
            <ColorField label="Header fill" value={element.style.headerFill} allowTransparent onChange={(headerFill) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.headerFill = headerFill; })} />
            <ColorField label="Cell fill" value={element.style.cellFill} allowTransparent onChange={(cellFill) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.cellFill = cellFill; })} />
            <NumberField label="Border width" value={element.style.borderWidth} onChange={(borderWidth) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.borderWidth = Math.max(0, borderWidth); })} />
            <ColorField label="Border color" value={element.style.borderColor} allowTransparent onChange={(borderColor) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.borderColor = borderColor; })} />
          </>}
          {(element.type === "image" || element.type === "video") && <>
            <div className="media-source-card"><span className={`storage-badge ${element.storage}`}>{element.storage}</span><code title={element.src}>{element.src}</code><div><button onClick={() => relinkMedia(element.type, element.id)}>Choose linked file…</button>{element.storage === "linked" && <button onClick={() => postMessage({ type: "embedMedia", elementIds: [element.id] })}>Embed in .assets</button>}</div></div>
            <RangeField label="Corner radius" value={element.borderRadius} min={0} max={Math.max(1, Math.round(Math.min(element.width, element.height) / 2))} onChange={(borderRadius) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image" || target?.type === "video") target.borderRadius = borderRadius; })} onCommit={commit} />
            <p className="panel-help">Drag the yellow point on the top edge to round corners.</p>
          </>}
          {element.type === "image" && <>
            <RangeField label="Border width" value={element.border.width} min={0} max={40} onChange={(width) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.border.width = width; })} onCommit={commit} />
            <ColorField label="Border color" value={element.border.color} allowTransparent onChange={(color) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.border.color = color; })} />
            <RangeField label="Edge fade" value={element.edgeFade} min={0} max={Math.max(1, Math.round(Math.min(element.width, element.height) / 2))} onChange={(edgeFade) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.edgeFade = edgeFade; })} onCommit={commit} />
            <p className="panel-help">Drag the blue point upward from the bottom edge to fade all four sides.</p>
            <RangeField label="Crop zoom" value={cropZoomPercent(element.crop)} min={100} max={1000} onChange={(percent) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.crop = setCropZoom(target.crop, percent); })} onCommit={commit} suffix="%" />
            <button className={`edit-text-button ${cropActive ? "active" : ""}`} onClick={() => editImage(element.id)}>{cropActive ? "Cropping on canvas…" : "Crop image (or double-click)"}</button>
            <label>Alt text<textarea value={element.alt ?? ""} onChange={(event) => update({ alt: event.target.value })} /></label>
          </>}
          {element.type === "video" && <>
            <label>Playback<select value={element.playback.mode} onChange={(event) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.mode = event.target.value as "manual" | "autoplay"; })}><option value="manual">Manual</option><option value="autoplay">Autoplay</option></select></label>
            <CheckboxField label="Muted" checked={element.playback.muted} onChange={(muted) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.muted = muted; })} />
            <CheckboxField label="Loop" checked={element.playback.loop} onChange={(loop) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.loop = loop; })} />
            <CheckboxField label="Controls" checked={element.playback.controls} onChange={(controls) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.controls = controls; })} />
          </>}
        </> : <>
          <label>Slide title<input value={slide.title} onChange={(event) => mutate((draft) => { draft.slides.find((item) => item.id === slide.id)!.title = event.target.value; })} /></label>
          <ColorField label="Background" value={slide.background ?? deck.theme.background} onChange={(background) => mutate((draft) => { draft.slides.find((item) => item.id === slide.id)!.background = background; })} />
          <CheckboxField label="Hide page number" checked={slide.hidePageNumber} onChange={(hidePageNumber) => mutate((draft) => { draft.slides.find((item) => item.id === slide.id)!.hidePageNumber = hidePageNumber; })} />
        </>}
      </>}
      {tab === "layers" && <><h3>Layers</h3>{[...slide.elements].sort((a, b) => b.z - a.z).map((item) => <div className={`layer-row ${item.id === element?.id ? "active" : ""}`} key={item.id} onClick={() => selectElement(item.id)}><span>{item.name ?? `${item.type} ${item.id.slice(0, 4)}`}</span><button onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.locked = !target.locked; }); }}>{item.locked ? "🔒" : "🔓"}</button><button onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.hidden = !target.hidden; }); }}>{item.hidden ? "○" : "●"}</button><button onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.z += 1; }); }}>↑</button><button onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.z -= 1; }); }}>↓</button></div>)}</>}
      {tab === "animations" && <><h3>Animation timeline</h3><p className="panel-help">Select an element, then add its entrance. The cards run from top to bottom.</p><button className="add-animation" disabled={!element} onClick={() => element && mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.timeline.push(defaultAnimation(element.id)))}>＋ Add entrance{element ? ` for ${elementLabel(element)}` : ""}</button><div className="animation-list">{slide.timeline.map((step, index) => <AnimationRow key={step.id} step={step} index={index} flowLabel={animationFlowLabel(slide.timeline, index)} element={slide.elements.find((item) => item.id === step.targetElementId)} selectElement={selectElement} mutate={(patch) => mutate((draft) => Object.assign(draft.slides.find((item) => item.id === slide.id)!.timeline[index]!, patch))} remove={() => mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.timeline.splice(index, 1))} />)}</div></>}
    </div>
  </aside>;
}

function AnimationRow({ step, index, flowLabel, element, selectElement, mutate, remove }: { step: AnimationStep; index: number; flowLabel: string; element?: SlideElement; selectElement(id?: string): void; mutate(patch: Partial<AnimationStep>): void; remove(): void }) {
  return <div className="animation-row">
    <header><span className="animation-index">{index + 1}</span><button className="animation-target" disabled={!element} onClick={() => selectElement(element?.id)}>{element ? elementLabel(element) : "Missing element"}</button><span className="animation-flow">{flowLabel}</span></header>
    <div className="animation-summary">{step.phase} · {step.effect}</div>
    <label>Effect<select value={step.effect} onChange={(e) => mutate({ effect: e.target.value as AnimationStep["effect"] })}><option>appear</option><option>fade</option><option>fly</option></select></label>
    <label>Start<select value={step.trigger} onChange={(e) => mutate({ trigger: e.target.value as AnimationStep["trigger"] })}><option value="onClick">On click</option><option value="withPrevious">With previous</option><option value="afterPrevious">After previous</option></select></label>
    {step.effect === "fly" && <label>Direction<select value={step.direction ?? "left"} onChange={(e) => mutate({ direction: e.target.value as NonNullable<AnimationStep["direction"]> })}><option>left</option><option>right</option><option>up</option><option>down</option></select></label>}
    <div className="field-grid"><NumberField label="Delay ms" value={step.delayMs} onChange={(delayMs) => mutate({ delayMs })} /><NumberField label="Duration ms" value={step.durationMs} onChange={(durationMs) => mutate({ durationMs })} /></div><button className="danger-quiet" onClick={remove}>Remove animation</button>
  </div>;
}

function TextEditor({ deck, slideId, elementId, mutate, close }: { deck: Deck; slideId: string; elementId: string; mutate(fn: (deck: Deck) => void): void; close(): void }) {
  const element = findElement(deck, slideId, elementId);
  const slide = deck.slides.find((item) => item.id === slideId);
  if (element?.type !== "text") return null;
  const background = slide?.background ?? deck.layouts[slide?.layout ?? ""]?.background ?? deck.theme.background;
  return <div className="modal-backdrop" onMouseDown={close}><div className="text-editor" onMouseDown={(event) => event.stopPropagation()}><header><strong>Markdown · LaTeX · Code</strong><button onClick={close}>Done</button></header><textarea autoFocus value={element.markdown} onChange={(event) => mutate((draft) => { const target = findElement(draft, slideId, elementId); if (target?.type === "text") target.markdown = event.target.value; })} /><section className="text-preview-panel"><strong>Live preview</strong><div className="text-preview" style={{ background, fontFamily: element.style.fontFamily, fontSize: Math.min(element.style.fontSize, 34), fontWeight: element.style.fontWeight, color: element.style.color, textAlign: element.style.textAlign, lineHeight: element.style.lineHeight }} dangerouslySetInnerHTML={{ __html: renderMarkdown(element.markdown) }} /></section><p>Use <code>$x^2$</code>, <code>$$…$$</code>, and fenced code blocks.</p></div></div>;
}

const SYSTEM_FONT_STACK = "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif";
const FONT_CANDIDATES = [
  { label: "System UI", value: SYSTEM_FONT_STACK },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Aptos", value: "Aptos, sans-serif" },
  { label: "Calibri", value: "Calibri, sans-serif" },
  { label: "Helvetica Neue", value: "\"Helvetica Neue\", Helvetica, sans-serif" },
  { label: "Verdana", value: "Verdana, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "\"Times New Roman\", serif" },
  { label: "Courier New", value: "\"Courier New\", monospace" },
  { label: "Menlo", value: "Menlo, monospace" },
  { label: "Monaco", value: "Monaco, monospace" }
] as const;

function FontFamilyPicker({ value, onChange }: { value: string; onChange(value: string): void }) {
  const available = [...FONT_CANDIDATES];
  const custom = available.some((font) => font.value === value) ? [] : [{ label: `Current: ${value}`, value }];
  const discover = () => {
    const requestId = crypto.randomUUID();
    pendingFonts.set(requestId, (family, error) => {
      pendingFonts.delete(requestId);
      if (error) alert(`Could not list system fonts: ${error}`);
      else if (family) onChange(family);
    });
    postMessage({ type: "selectFont", requestId, current: value });
  };
  return <label>Font family<div className="font-picker"><select value={value} onChange={(event) => onChange(event.target.value)}>{[...custom, ...available].map((font) => <option key={font.value} value={font.value} style={{ fontFamily: font.value }}>{font.label}</option>)}</select><button type="button" title="Choose a font installed on this computer" onClick={discover}>System fonts…</button></div></label>;
}

function NumberField({ label, value, step = 1, min, max, onChange }: { label: string; value: number; step?: number; min?: number; max?: number; onChange(value: number): void }) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const update = (next: number) => onChange(roundStep(clampOptional(next, min, max), step));
  const nudge = (direction: -1 | 1, event: { shiftKey: boolean; altKey: boolean }) => update(safeValue + direction * step * (event.shiftKey ? 10 : event.altKey ? 0.1 : 1));
  return <label className="number-field"><span>{label}</span><span className="number-control"><button type="button" tabIndex={-1} title={`Decrease ${label} · Shift for ×10`} aria-label={`Decrease ${label}`} onClick={(event) => nudge(-1, event)}>−</button><input type="number" value={safeValue} step={step} min={min} max={max} onFocus={(event) => event.currentTarget.select()} onWheel={(event) => { if (document.activeElement !== event.currentTarget) return; event.preventDefault(); nudge(event.deltaY > 0 ? -1 : 1, event); }} onChange={(event) => update(Number(event.target.value))} /><button type="button" tabIndex={-1} title={`Increase ${label} · Shift for ×10`} aria-label={`Increase ${label}`} onClick={(event) => nudge(1, event)}>＋</button></span></label>;
}
function RangeField({ label, value, min, max, onChange, onCommit, suffix = " px" }: { label: string; value: number; min: number; max: number; onChange(value: number): void; onCommit?(): void; suffix?: string }) { return <label className="range-field"><span>{label}<output>{Math.round(value)}{suffix}</output></span><input type="range" min={min} max={max} step="1" value={clamp(value, min, max)} onChange={(event) => onChange(Number(event.target.value))} onPointerUp={onCommit} onPointerCancel={onCommit} onKeyUp={onCommit} onBlur={onCommit} /></label>; }
function ColorField({ label, value, allowTransparent = false, onChange }: { label: string; value: string; allowTransparent?: boolean; onChange(value: string): void }) {
  const transparent = value.trim().toLowerCase() === "transparent";
  return <label>{label}<span className="color-field"><input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} disabled={transparent} onChange={(event) => onChange(event.target.value)} /><input value={value} onChange={(event) => onChange(event.target.value)} />{allowTransparent && <button type="button" className={`transparent-toggle ${transparent ? "active" : ""}`} title={transparent ? "Use an opaque color" : "Make transparent"} aria-label={transparent ? `Disable transparent ${label}` : `Make ${label} transparent`} onClick={() => onChange(transparent ? "#000000" : "transparent")}>∅</button>}</span></label>;
}
function CheckboxField({ label, checked, onChange }: { label: string; checked: boolean; onChange(checked: boolean): void }) { return <label className="checkbox-field"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>; }
function InvalidDeck({ message }: { message: string }) { return <div className="invalid"><h1>SlidePix could not open this deck</h1><pre>{message}</pre><p>Fix the JSON in the text editor. SlidePix will reopen the last valid preview automatically.</p></div>; }

function baseElement(z: number, type: SlideElement["type"]) { const id = crypto.randomUUID(); return { id, name: `${type}-${id.slice(0, 4)}`, morphKey: crypto.randomUUID(), x: 240, y: 240, width: 640, height: 360, rotation: 0, opacity: 1, z, locked: false, hidden: false } as const; }
function defaultAnimation(targetElementId: string): AnimationStep { return { id: crypto.randomUUID(), targetElementId, phase: "entrance", effect: "fade", trigger: "onClick", delayMs: 0, durationMs: 500, easing: "ease-out" }; }
function elementLabel(element: SlideElement): string { return element.name?.trim() || `${element.type}-${element.id.slice(0, 4)}`; }
function animationFlowLabel(timeline: AnimationStep[], index: number): string { const step = timeline[index]!; if (step.trigger === "withPrevious") return "With previous"; if (step.trigger === "afterPrevious") return "After previous"; return `Click ${timeline.slice(0, index + 1).filter((item) => item.trigger === "onClick").length}`; }
function transitionLabel(type: Transition["type"]): string { return ({ none: "None", fade: "Fade", "slide-left": "From left", "slide-right": "From right", "slide-up": "From top", "slide-down": "From bottom", morph: "Morph" } as Record<Transition["type"], string>)[type]; }
function transitionIcon(type: Transition["type"]): string { return ({ none: "circle-slash", fade: "eye", "slide-left": "arrow-right", "slide-right": "arrow-left", "slide-up": "arrow-down", "slide-down": "arrow-up", morph: "wand" } as Record<Transition["type"], string>)[type]; }
function findElement(deck: Deck, slideId: string, elementId: string) { return deck.slides.find((item) => item.id === slideId)?.elements.find((item) => item.id === elementId); }
function clampOptional(value: number, min?: number, max?: number): number { return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, value)); }
function roundStep(value: number, step: number): number { const precision = Math.max(0, (String(step).split(".")[1] ?? "").length); return Number(value.toFixed(Math.min(8, precision))); }
function normalizedTableCells(table: Extract<SlideElement, { type: "table" }>): string[][] { return Array.from({ length: table.rows }, (_, row) => Array.from({ length: table.columns }, (_, column) => table.cells[row]?.[column] ?? "")); }
function resizeTable(table: Extract<SlideElement, { type: "table" }>, rows: number, columns: number): void { table.rows = clamp(Math.round(rows), 1, 50); table.columns = clamp(Math.round(columns), 1, 20); table.cells = normalizedTableCells(table); }
function isTextEntryTarget(target: EventTarget | null): boolean { return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)); }
function deleteElement(deck: Deck, slideId: string, elementId: string, mutate: (fn: (deck: Deck) => void) => void, select: (id?: string) => void) { mutate((draft) => { const target = draft.slides.find((item) => item.id === slideId)!; target.elements = target.elements.filter((item) => item.id !== elementId); target.timeline = target.timeline.filter((step) => step.targetElementId !== elementId); }); select(); }
function handleHostMessage(message: HostToWebviewMessage, setDeck: (deck: Deck, uri: string, linkedUri: string) => void, setInvalid: (message: string, uri: string, linkedUri: string) => void) { if (message.type === "deck") setDeck(message.deck, message.uri, message.linkedUri); else if (message.type === "invalidDeck") setInvalid(message.message, message.uri, message.linkedUri); else if (message.type === "assetImported") { pendingAssets.get(message.requestId)?.(message.reference && message.storage ? { reference: message.reference, storage: message.storage } : undefined, message.error); pendingAssets.delete(message.requestId); } else if (message.type === "fontSelected") pendingFonts.get(message.requestId)?.(message.family, message.error); }
async function sendAsset(file: File): Promise<MediaResult | undefined> { const requestId = crypto.randomUUID(); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return new Promise((resolve) => { pendingAssets.set(requestId, (result, error) => { if (error) alert(error); resolve(result); }); postMessage({ type: "importAsset", requestId, name: file.name, mime: file.type, base64: btoa(binary) }); }); }
function droppedFileUri(data: DataTransfer): string | undefined {
  const uriList = data.getData("text/uri-list") || data.getData("application/vnd.code.uri-list") || data.getData("ResourceURLs");
  const direct = parseDroppedValues(uriList).find((value) => value.startsWith("file:"));
  if (direct) return direct;
  const paths = parseDroppedValues(data.getData("CodeFiles") || data.getData("codefiles"));
  const filePath = paths[0];
  if (!filePath) return undefined;
  const normalized = filePath.replaceAll("\\", "/");
  return encodeURI(normalized.match(/^[a-z]:\//i) ? `file:///${normalized}` : `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`);
}
function parseDroppedValues(raw: string): string[] { if (!raw) return []; try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return parsed.filter((value): value is string => typeof value === "string"); } catch { /* URI lists are newline-delimited, not JSON. */ } return raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")); }
function mediaKindFromPath(value: string): "image" | "video" | undefined { const pathname = value.split(/[?#]/)[0]!.toLowerCase(); if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(pathname)) return "image"; if (/\.(mp4|webm|mov|m4v|ogv)$/.test(pathname)) return "video"; return undefined; }
function readSlidePixClipboard(data: DataTransfer): SlidePixClipboard | undefined {
  const raw = data.getData(SLIDEPIX_CLIPBOARD_TYPE);
  if (raw) try {
    const candidate = JSON.parse(raw) as Partial<SlidePixClipboard>;
    const elements = elementSchema.array().safeParse(candidate.elements);
    if (candidate.version === 1 && typeof candidate.token === "string" && typeof candidate.deckId === "string" && typeof candidate.sourceSlideId === "string" && elements.success) {
      slidepixClipboard = { version: 1, token: candidate.token, deckId: candidate.deckId, sourceSlideId: candidate.sourceSlideId, elements: elements.data };
      return slidepixClipboard;
    }
  } catch { /* Ignore malformed external clipboard data. */ }
  const marker = data.getData("text/plain").match(/^slidepix:\/\/clipboard\/(.+)$/)?.[1];
  return marker && slidepixClipboard?.token === marker ? slidepixClipboard : undefined;
}
function cloneElementForPaste(element: SlideElement, preserveMorphKey: boolean): SlideElement {
  const copy = structuredClone(element);
  return { ...copy, id: crypto.randomUUID(), morphKey: preserveMorphKey ? copy.morphKey : crypto.randomUUID(), name: `${elementLabel(copy)} copy`, x: copy.x + (preserveMorphKey ? 0 : 20), y: copy.y + (preserveMorphKey ? 0 : 20) } as SlideElement;
}
function startPointerDrag(event: ReactPointerEvent<HTMLElement>, move: (deltaX: number, deltaY: number) => void, finish: () => void): void {
  event.preventDefault();
  event.stopPropagation();
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startY = event.clientY;
  const target = event.currentTarget;
  try { target.setPointerCapture(pointerId); } catch { /* Window listeners still preserve the drag. */ }
  const onMove = (next: PointerEvent) => { if (next.pointerId === pointerId) move(next.clientX - startX, next.clientY - startY); };
  const stop = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return;
    if (next.type === "pointerup") move(next.clientX - startX, next.clientY - startY);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); } catch { /* The optimistic rerender may replace the handle. */ }
    finish();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}

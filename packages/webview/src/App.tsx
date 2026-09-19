import Moveable from "react-moveable";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
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
import { toggleInlineMarkdown, toggleMarkdownList, type TextSelection } from "./text-format";
import { notifyToast, onToast, updateToasts, type ToastMessage } from "./toasts";
import { onHostMessage, postMessage } from "./vscode";

type Tab = "properties" | "layers" | "animations";
const transitionTypes: Transition["type"][] = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "morph"];
type MediaResult = { reference: string; storage: MediaStorage };
const pendingAssets = new Map<string, (result?: MediaResult, error?: string) => void>();
const pendingFonts = new Map<string, (family?: string, error?: string) => void>();
const SLIDEPIX_CLIPBOARD_TYPE = "application/x-slidepix-elements+json";
type SlidePixClipboard = { version: 1; token: string; deckId: string; sourceSlideId: string; elements: SlideElement[] };
type TextFormatCommand = "bold" | "italic" | "unordered-list" | "ordered-list";
type InlineTextEditorHandle = { format(command: TextFormatCommand): void; focus(): void };
let slidepixClipboard: SlidePixClipboard | undefined;

export default function App() {
  const store = useDeckStore();
  const [tab, setTab] = useState<Tab>("properties");
  const [editingTextId, setEditingTextId] = useState<string>();
  const [selectAllOnEdit, setSelectAllOnEdit] = useState(false);
  const [advancedTextId, setAdvancedTextId] = useState<string>();
  const [cropElementId, setCropElementId] = useState<string>();
  const [notesCollapsed, setNotesCollapsed] = useState(false);
  const inlineTextEditor = useRef<InlineTextEditorHandle>(null);
  const pendingTextFormat = useRef<TextFormatCommand | undefined>(undefined);

  useEffect(() => onHostMessage((message) => handleHostMessage(message, store.setFromHost, store.setInvalid, store.handleEditResult, store.handleHistoryResult)), []);
  useEffect(() => { postMessage({ type: "ready" }); }, []);
  useEffect(() => {
    if (!store.historyError) return;
    showError(store.historyError);
    store.clearHistoryError();
  }, [store.historyError]);

  const deck = store.deck;
  const slide = deck?.slides.find((item) => item.id === store.selectedSlideId) ?? deck?.slides[0];
  const selected = slide?.elements.find((item) => item.id === store.selectedElementId);
  const editingText = slide?.elements.find((item): item is Extract<SlideElement, { type: "text" }> => item.id === editingTextId && item.type === "text");
  const target = selected && !selected.locked ? document.getElementById(`element-${selected.id}`) : null;
  const cropActive = selected?.type === "image" && cropElementId === selected.id;

  useEffect(() => {
    if (!selected || selected.type !== "image" || selected.id !== cropElementId) setCropElementId(undefined);
  }, [selected?.id, selected?.type, cropElementId]);
  useEffect(() => {
    if (editingTextId && (selected?.type !== "text" || selected.id !== editingTextId)) setEditingTextId(undefined);
  }, [editingTextId, selected?.id, selected?.type]);
  useEffect(() => {
    if (!editingText || !pendingTextFormat.current) return;
    const command = pendingTextFormat.current;
    pendingTextFormat.current = undefined;
    requestAnimationFrame(() => inlineTextEditor.current?.format(command));
  }, [editingText?.id]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const textEntry = isTextEntryTarget(event.target);
      const accelerator = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLowerCase();
      if (accelerator && (key === "z" || key === "y")) {
        event.preventDefault();
        const redo = key === "y" || (key === "z" && event.shiftKey);
        store.runCommand(redo ? "redo" : "undo");
        return;
      }
      if (event.key === "Escape" && cropElementId) {
        event.preventDefault();
        setCropElementId(undefined);
        return;
      }
      if (!deck || !slide || !selected || editingTextId || textEntry) return;
      if ((event.key === "Enter" || event.key === "F2") && selected.type === "text") {
        event.preventDefault();
        setSelectAllOnEdit(false);
        setEditingTextId(selected.id);
        return;
      }
      const delta = event.shiftKey ? 10 : 1;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        store.preview((draft) => {
          const element = findElement(draft, slide.id, selected.id);
          if (!element) return;
          if (event.key === "ArrowLeft") element.x -= delta;
          if (event.key === "ArrowRight") element.x += delta;
          if (event.key === "ArrowUp") element.y -= delta;
          if (event.key === "ArrowDown") element.y += delta;
        });
        store.scheduleCommit();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteElement(deck, slide.id, selected.id, store.mutate, store.selectElement);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [deck, slide, selected, editingTextId, cropElementId]);

  if (store.error) return <InvalidDeck message={store.error} gitConflict={store.gitConflict} />;
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
      if (error) return void showError(error);
      if (result) addMedia(kind, result, undefined, elementId);
    });
    postMessage(uri ? { type: "linkMedia", requestId, kind, uri } : { type: "selectMedia", requestId, kind });
  };
  const requestBackgroundImage = () => {
    const requestId = crypto.randomUUID();
    pendingAssets.set(requestId, (result, error) => {
      if (error) return void showError(error);
      if (result) store.mutate((draft) => { draft.slides.find((item) => item.id === slide.id)!.backgroundImage = { src: result.reference, storage: result.storage }; });
    });
    postMessage({ type: "selectMedia", requestId, kind: "image" });
  };
  const importFile = async (file: File, kind: "image" | "video") => {
    if (file.size > 100 * 1024 * 1024) return void showError("Media files are limited to 100 MB per import.");
    const result = await sendAsset(file);
    if (result) addMedia(kind, result, file.name);
  };

  const addText = () => {
    const common = baseElement(slide.elements.length, "text");
    store.mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.elements.push({
      ...common,
      type: "text",
      markdown: "Type here",
      style: { fontFamily: deck.theme.fontFamily, fontSize: 48, fontWeight: 400, color: deck.theme.foreground, textAlign: "left", verticalAlign: "top", lineHeight: 1.2, padding: 8 }
    }));
    store.selectElement(common.id);
    setSelectAllOnEdit(true);
    setEditingTextId(common.id);
  };
  const beginTextEditing = (id: string, selectAll = false) => {
    setSelectAllOnEdit(selectAll);
    setEditingTextId(id);
  };
  const applyTextFormat = (command: TextFormatCommand) => {
    if (editingText) {
      inlineTextEditor.current?.format(command);
      return;
    }
    if (selected?.type !== "text") return;
    pendingTextFormat.current = command;
    beginTextEditing(selected.id, true);
  };
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
      if (payload.deckId !== deck.id) return void showError("Copying elements between different deck files is not supported yet. Embed and re-add the media instead.");
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
        else showError("Drop an image or video file from the Explorer.");
        return;
      }
      const file = event.dataTransfer.files[0];
      if (!file) return;
      if (file.type.startsWith("image/")) void importFile(file, "image");
      else if (file.type.startsWith("video/")) void importFile(file, "video");
    }} onPaste={paste}>
      <Toolbar
        slide={slide}
        element={selected}
        addText={addText}
        addShape={addShape}
        addTable={addTable}
        chooseImage={() => requestMedia("image")}
        chooseVideo={() => requestMedia("video")}
        hasLinkedMedia={deck.slides.some((item) => item.backgroundImage?.storage === "linked" || item.elements.some((element) => (element.type === "image" || element.type === "video") && element.storage === "linked"))}
        historyBusy={Boolean(store.historyPending)}
        mutate={store.mutate}
        preview={store.preview}
        scheduleCommit={store.scheduleCommit}
        commit={store.commit}
        editAdvanced={(id) => { store.commit(); setEditingTextId(undefined); setAdvancedTextId(id); }}
        formatText={applyTextFormat}
        duplicateElement={() => {
          if (!selected) return;
          const copy = cloneElementForPaste(selected, false);
          store.mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.elements.push(copy));
          store.selectElement(copy.id);
        }}
        deleteSelected={() => selected && deleteElement(deck, slide.id, selected.id, store.mutate, store.selectElement)}
      />
      <SlideRail deck={deck} selectedId={slide.id} select={(id) => { store.commit(); setEditingTextId(undefined); store.selectSlide(id); }} mutate={store.mutate} resolveAsset={assetUrl} />
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
                editingElementId={editingTextId}
                resolveAsset={assetUrl}
                onSelectElement={store.selectElement}
                onEditText={(id) => beginTextEditing(id)}
                onEditImage={setCropElementId}
              />
              {target && selected && !cropActive && editingTextId !== selected.id && (
                <Moveable
                  target={target}
                  draggable
                  resizable
                  rotatable
                  snappable
                  elementGuidelines={slide.elements.filter((item) => item.id !== selected.id && !item.hidden).map((item) => document.getElementById(`element-${item.id}`)).filter((item): item is HTMLElement => Boolean(item))}
                  verticalGuidelines={[deck.size.width / 2]}
                  horizontalGuidelines={[deck.size.height / 2]}
                  snapThreshold={4}
                  clickable
                  origin={false}
                  zoom={1 / store.zoom}
                  onClick={({ isDouble }) => {
                    if (!isDouble) return;
                    if (selected.type === "text") beginTextEditing(selected.id);
                    if (selected.type === "image") setCropElementId(selected.id);
                  }}
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
              {editingText && <InlineTextEditor ref={inlineTextEditor} element={editingText} selectAll={selectAllOnEdit} preview={(markdown) => { store.preview((draft) => { const element = findElement(draft, slide.id, editingText.id); if (element?.type === "text") element.markdown = markdown; }); store.scheduleCommit(); }} finish={() => { store.commit(); setEditingTextId(undefined); }} />}
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
          {!notesCollapsed && <textarea aria-label="Speaker notes" value={slide.notes} onChange={(event) => { store.preview((draft) => { draft.slides.find((item) => item.id === slide.id)!.notes = event.target.value; }); store.scheduleCommit(); }} onBlur={store.commit} />}
        </section>
        <div className="zoom-control" aria-label="Canvas zoom" title={`Canvas zoom ${Math.round(store.zoom * 100)}% · Ctrl/Cmd + mouse wheel also zooms`}><IconButton icon="remove" label={`Zoom out from ${Math.round(store.zoom * 100)}%`} onClick={() => store.setZoom(store.zoom - 0.1)} /><IconButton icon="add" label={`Zoom in from ${Math.round(store.zoom * 100)}%`} onClick={() => store.setZoom(store.zoom + 0.1)} /></div>
      </main>
      <Inspector tab={tab} setTab={setTab} deck={deck} slide={slide} element={selected} cropActive={cropActive} mutate={store.mutate} preview={store.preview} scheduleCommit={store.scheduleCommit} commit={store.commit} selectElement={store.selectElement} editText={(id) => { store.commit(); setEditingTextId(undefined); setAdvancedTextId(id); }} editImage={setCropElementId} relinkMedia={(kind, id) => requestMedia(kind, undefined, id)} chooseBackgroundImage={requestBackgroundImage} />
      {advancedTextId && <TextEditor deck={deck} slideId={slide.id} elementId={advancedTextId} preview={store.preview} scheduleCommit={store.scheduleCommit} commit={store.commit} close={() => setAdvancedTextId(undefined)} />}
      {store.mergeState && <MergeConflictDialog conflict={store.mergeState.conflicts[0]} resolve={store.resolveMergeConflict} useLatest={store.useLatestDeck} />}
      <ToastStack />
    </div>
  );
}

function Toolbar({ slide, element, addText, addShape, addTable, chooseImage, chooseVideo, hasLinkedMedia, historyBusy, mutate, preview, scheduleCommit, commit, editAdvanced, formatText, duplicateElement, deleteSelected }: {
  slide: Slide;
  element?: SlideElement;
  addText(): void;
  addShape(shape: "rectangle" | "ellipse" | "triangle"): void;
  addTable(): void;
  chooseImage(): void;
  chooseVideo(): void;
  hasLinkedMedia: boolean;
  historyBusy: boolean;
  mutate(fn: (deck: Deck) => void): void;
  preview(fn: (deck: Deck) => void): void;
  scheduleCommit(): void;
  commit(): void;
  editAdvanced(id: string): void;
  formatText(command: TextFormatCommand): void;
  duplicateElement(): void;
  deleteSelected(): void;
}) {
  const runCommand = useDeckStore((state) => state.runCommand);
  const updateStyle = (patch: Record<string, unknown>, continuous = false) => {
    if (!element || (element.type !== "text" && element.type !== "table")) return;
    const apply = (draft: Deck) => {
      const target = findElement(draft, slide.id, element.id);
      if (target?.type === "text" || target?.type === "table") Object.assign(target.style, patch);
    };
    if (continuous) { preview(apply); scheduleCommit(); } else { commit(); mutate(apply); }
  };
  const updateElement = (fn: (target: SlideElement) => void) => element && mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target) fn(target); });
  const textLike = element?.type === "text" || element?.type === "table" ? element : undefined;
  const exportDeck = (command: "exportPdf" | "exportPng" | "exportPptx" | "exportWeb", label: string, slideIds?: string[]) => {
    const requestId = crypto.randomUUID();
    notifyToast({ id: requestId, kind: "progress", message: `Exporting ${label}…` });
    postMessage({ type: "command", command, requestId, slideIds });
  };
  return <header className="toolbar-shell">
    <div className="toolbar toolbar-primary">
      <div className="ribbon-group"><div className="ribbon-actions">
        <RibbonButton icon="package" label="Embed all media" disabled={!hasLinkedMedia} onClick={() => postMessage({ type: "embedMedia" })} />
        <RibbonButton icon="save" label="Save" onClick={() => runCommand("save")} />
        <RibbonMenu icon="export" label="Export" items={[
          { icon: "file-media", label: "PNG", onClick: () => exportDeck("exportPng", "PNG", [slide.id]) },
          { icon: "file-pdf", label: "PDF", onClick: () => exportDeck("exportPdf", "PDF") },
          { icon: "file", label: "PowerPoint", onClick: () => exportDeck("exportPptx", "PowerPoint") },
          { icon: "globe", label: "Web", onClick: () => exportDeck("exportWeb", "web presentation") }
        ]} />
      </div></div>
      <div className="ribbon-group history-actions"><div className="ribbon-actions">
        <RibbonButton icon="discard" label="Undo" disabled={historyBusy} onClick={() => runCommand("undo")} />
        <RibbonButton icon="redo" label="Redo" disabled={historyBusy} onClick={() => runCommand("redo")} />
      </div></div>
      <div className="ribbon-group"><div className="ribbon-actions">
        <RibbonButton icon="sparkle" label="AI" onClick={() => postMessage({ type: "command", command: "configureMcp" })} />
      </div></div>
      <div className="ribbon-group"><span className="ribbon-label">Insert</span><div className="ribbon-actions">
        <RibbonButton icon="symbol-string" label="Text" onClick={addText} />
        <RibbonButton icon="file-media" label="Image" onClick={chooseImage} />
        <RibbonButton icon="device-camera-video" label="Video" onClick={chooseVideo} />
        <RibbonButton icon="table" label="Table" onClick={addTable} />
        <RibbonMenu icon="symbol-structure" label="Shape" items={[
          { icon: "symbol-structure", label: "Rectangle", onClick: () => addShape("rectangle") },
          { icon: "circle-large-outline", label: "Circle", onClick: () => addShape("ellipse") },
          { icon: "triangle-up", label: "Triangle", onClick: () => addShape("triangle") }
        ]} />
      </div></div>
      <div className="ribbon-group"><span className="ribbon-label">Slide show</span><div className="ribbon-actions">
        <RibbonButton icon="play" label="Present" primary onClick={() => postMessage({ type: "command", command: "present" })} />
        <RibbonButton icon="multiple-windows" label="Presenter" onClick={() => postMessage({ type: "command", command: "presenter" })} />
      </div></div>
    </div>
    <div className="context-toolbar" aria-label="Selection formatting">
      {textLike ? <>
        <CompactFontPicker value={textLike.style.fontFamily} onChange={(fontFamily) => updateStyle({ fontFamily })} />
        <label className="context-number" title="Font size"><span>Size</span><input aria-label="Font size" type="number" min="1" value={textLike.style.fontSize} onChange={(event) => updateStyle({ fontSize: Math.max(1, Number(event.target.value)) }, true)} onBlur={commit} /></label>
        <label className="context-color" title="Text color"><span>Color</span><input aria-label="Text color" type="color" value={/^#[0-9a-f]{6}$/i.test(textLike.style.color) ? textLike.style.color : "#000000"} onChange={(event) => updateStyle({ color: event.target.value }, true)} onBlur={commit} /></label>
        {element?.type === "text" && <div className="segmented-control" aria-label="Markdown formatting">
          <ContextIcon icon="bold" label="Bold (Ctrl/Cmd+B)" onClick={() => formatText("bold")} />
          <ContextIcon icon="italic" label="Italic (Ctrl/Cmd+I)" onClick={() => formatText("italic")} />
          <ContextIcon icon="list-unordered" label="Bulleted list" onClick={() => formatText("unordered-list")} />
          <ContextIcon icon="list-ordered" label="Numbered list" onClick={() => formatText("ordered-list")} />
        </div>}
        <AlignmentButtons label="Horizontal alignment" value={textLike.style.textAlign} values={["left", "center", "right"]} onChange={(textAlign) => updateStyle({ textAlign })} />
        <AlignmentButtons label="Vertical alignment" value={textLike.style.verticalAlign} values={["top", "middle", "bottom"]} onChange={(verticalAlign) => updateStyle({ verticalAlign })} />
        {element?.type === "text" && <button className="context-action" onClick={() => editAdvanced(element.id)}><span className="codicon codicon-open-preview" /> Advanced editor</button>}
      </> : <span className="context-hint">{element ? `${elementLabel(element)} selected` : "Select an element to format it"}</span>}
      {element && <div className="context-arrange">
        <ContextIcon icon="copy" label="Duplicate" onClick={duplicateElement} />
        <ContextIcon icon="arrow-up" label="Bring forward" onClick={() => updateElement((target) => { target.z += 1; })} />
        <ContextIcon icon="arrow-down" label="Send backward" onClick={() => updateElement((target) => { target.z -= 1; })} />
        <ContextIcon icon={element.locked ? "lock" : "unlock"} label={element.locked ? "Unlock" : "Lock"} pressed={element.locked} onClick={() => updateElement((target) => { target.locked = !target.locked; })} />
        <ContextIcon icon="trash" label="Delete" danger onClick={deleteSelected} />
      </div>}
    </div>
  </header>;
}

function RibbonButton({ icon, label, primary, disabled, onClick }: { icon: string; label: string; primary?: boolean; disabled?: boolean; onClick(): void }) {
  return <button className={`ribbon-button ${primary ? "primary" : ""}`} title={label} disabled={disabled} onClick={onClick}><span className={`codicon codicon-${icon}`} /><span>{label}</span></button>;
}

function RibbonMenu({ icon, label, items }: { icon: string; label: string; items: { icon: string; label: string; onClick(): void }[] }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return <div className="ribbon-menu-control" ref={menu}>
    <button type="button" className="ribbon-button" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((value) => !value)}><span className={`codicon codicon-${icon}`} /><span>{label}</span><span className="codicon codicon-chevron-down" /></button>
    {open && <div className="ribbon-menu" role="menu">
      {items.map((item) => <button key={item.label} type="button" role="menuitem" onClick={() => { setOpen(false); item.onClick(); }}><span className={`codicon codicon-${item.icon}`} /> {item.label}</button>)}
    </div>}
  </div>;
}

function ContextIcon({ icon, label, disabled, pressed, danger, onClick }: { icon: string; label: string; disabled?: boolean; pressed?: boolean; danger?: boolean; onClick(): void }) {
  return <button type="button" className={`context-icon ${danger ? "danger" : ""}`} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onPointerDown={(event) => event.preventDefault()} onClick={onClick}><span className={`codicon codicon-${icon}`} /></button>;
}

function IconButton({ icon, label, disabled, pressed, onClick }: { icon: string; label: string; disabled?: boolean; pressed?: boolean; onClick(): void }) {
  return <button type="button" title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><span className={`codicon codicon-${icon}`} /></button>;
}

function AlignmentButtons({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange(value: string): void }) {
  const icons: Record<string, string> = { left: "layout-panel-left", center: "layout-panel-center", right: "layout-panel-right", top: "arrow-up", middle: "layout-panel-center", bottom: "arrow-down" };
  return <div className="segmented-control" role="group" aria-label={label}>{values.map((item) => <button key={item} type="button" title={`${label}: ${item}`} aria-label={`${label}: ${item}`} aria-pressed={value === item} onPointerDown={(event) => event.preventDefault()} onClick={() => onChange(item)}><span className={`codicon codicon-${icons[item]}`} /></button>)}</div>;
}

function SlideRail({ deck, selectedId, select, mutate, resolveAsset }: { deck: Deck; selectedId: string; select(id: string): void; mutate(fn: (deck: Deck) => void): void; resolveAsset(source: string, storage: MediaStorage): string }) {
  const [transitionSlideId, setTransitionSlideId] = useState<string>();
  const addSlide = () => mutate((draft) => draft.slides.push({ id: crypto.randomUUID(), title: `Slide ${draft.slides.length + 1}`, notes: "", hidden: false, hidePageNumber: false, transition: { type: "none", durationMs: 500, easing: "ease-in-out" }, timeline: [], elements: [] }));
  return <aside className="slide-rail">
    <div className="rail-header"><strong>Slides</strong></div>
    <div className="rail-scroll">
      {deck.slides.map((slide, index) => <div key={slide.id} className="rail-entry">
        {index > 0 && <><button className={`transition-gap ${transitionSlideId === slide.id ? "active" : ""} ${slide.transition.type !== "none" ? "has-transition" : ""}`} title="Edit incoming transition" onClick={() => setTransitionSlideId((current) => current === slide.id ? undefined : slide.id)}><span className="codicon codicon-arrow-swap" /> <span>{slide.transition.type === "none" ? "Add transition" : transitionLabel(slide.transition.type)}</span></button>{transitionSlideId === slide.id && <TransitionEditor transition={slide.transition} update={(patch) => mutate((draft) => Object.assign(draft.slides[index]!.transition, patch))} close={() => setTransitionSlideId(undefined)} />}</>}
        <button className={`thumbnail ${selectedId === slide.id ? "active" : ""}`} onClick={() => select(slide.id)}>
          <span className="slide-index">{index + 1}</span>
          <div className="thumb-clip" style={{ width: 192, height: 108 }}><SlideView deck={deck} slide={slide} scale={0.1} resolveAsset={resolveAsset} /></div>
          <span className="slide-title">{slide.title}{slide.hidden ? " (hidden)" : ""}</span>
        </button>
        <div className="rail-actions">
          <IconButton icon="copy" label="Duplicate" onClick={() => mutate((draft) => draft.slides.splice(index + 1, 0, duplicateSlide(draft.slides[index]!)))} />
          <IconButton icon="arrow-up" label="Move up" disabled={index === 0} onClick={() => mutate((draft) => { const [item] = draft.slides.splice(index, 1); if (item) draft.slides.splice(index - 1, 0, item); })} />
          <IconButton icon="arrow-down" label="Move down" disabled={index === deck.slides.length - 1} onClick={() => mutate((draft) => { const [item] = draft.slides.splice(index, 1); if (item) draft.slides.splice(index + 1, 0, item); })} />
          <IconButton icon={slide.hidden ? "eye-closed" : "eye"} label={slide.hidden ? "Show slide" : "Hide slide"} pressed={slide.hidden} onClick={() => mutate((draft) => { draft.slides[index]!.hidden = !draft.slides[index]!.hidden; })} />
          <IconButton icon="trash" label="Delete" disabled={deck.slides.length === 1} onClick={() => mutate((draft) => draft.slides.splice(index, 1))} />
        </div>
      </div>)}
      <button className="add-slide-tile" onClick={addSlide}><span className="codicon codicon-add" /><span>Add slide</span></button>
    </div>
  </aside>;
}

function TransitionEditor({ transition, update, close }: { transition: Transition; update(patch: Partial<Transition>): void; close(): void }) {
  return <div className="transition-editor" onClick={(event) => event.stopPropagation()}>
    <header><strong>Incoming transition</strong><button className="icon-button" aria-label="Close transition editor" onClick={close}><span className="codicon codicon-close" /></button></header>
    <TransitionControls transition={transition} update={update} />
  </div>;
}

function TransitionControls({ transition, update }: { transition: Transition; update(patch: Partial<Transition>): void }) {
  return <div className="transition-controls">
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
          <IconButton icon="remove" label="Zoom out" onClick={() => updateCrop(scaleCrop(element.crop, 1.2))} />
          <input className="crop-zoom-slider" aria-label="Crop zoom" type="range" min="100" max="1000" step="5" value={cropZoomPercent(element.crop)} style={{ width: 130 / zoom }} onChange={(event) => preview({ crop: setCropZoom(element.crop, Number(event.target.value)) })} onPointerUp={commit} onPointerCancel={commit} onKeyUp={commit} onBlur={commit} />
          <output>{cropZoomPercent(element.crop)}%</output>
          <IconButton icon="add" label="Zoom in" onClick={() => updateCrop(scaleCrop(element.crop, 1 / 1.2))} />
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

function Inspector({ tab, setTab, deck, slide, element, cropActive, mutate, preview, scheduleCommit, commit, selectElement, editText, editImage, relinkMedia, chooseBackgroundImage }: {
  tab: Tab; setTab(tab: Tab): void; deck: Deck; slide: Slide; element?: SlideElement; cropActive: boolean; mutate(fn: (deck: Deck) => void): void; preview(fn: (deck: Deck) => void): void; scheduleCommit(): void; commit(): void; selectElement(id?: string): void; editText(id: string): void; editImage(id: string): void; relinkMedia(kind: "image" | "video", id: string): void; chooseBackgroundImage(): void;
}) {
  const update = (patch: Partial<SlideElement>) => element && mutate((draft) => Object.assign(findElement(draft, slide.id, element.id)!, patch));
  const updateContinuous = (patch: Partial<SlideElement>) => {
    if (!element) return;
    preview((draft) => Object.assign(findElement(draft, slide.id, element.id)!, patch));
    scheduleCommit();
  };
  const continuous = (fn: (draft: Deck) => void) => { preview(fn); scheduleCommit(); };
  return <aside className="inspector">
    <nav>{(["properties", "layers", "animations"] as const).map((value) => <button className={tab === value ? "active" : ""} onClick={() => setTab(value)} key={value}>{value}</button>)}</nav>
    <div className="inspector-body">
      {tab === "properties" && <>
        <h3>{element ? element.type : "Slide"}</h3>
        {element ? <>
          <label>Element name<input autoComplete="off" value={element.name ?? ""} placeholder={elementLabel(element)} onChange={(event) => updateContinuous({ name: event.target.value.trimStart() || undefined })} onBlur={commit} /></label>
          <h4 className="property-heading">Geometry</h4>
          <div className="field-grid geometry-grid">
            <NumberField label="X" value={element.x} onChange={(x) => updateContinuous({ x })} onCommit={commit} />
            <NumberField label="Y" value={element.y} onChange={(y) => updateContinuous({ y })} onCommit={commit} />
            <NumberField label="W" value={element.width} min={0} onChange={(width) => updateContinuous({ width })} onCommit={commit} />
            <NumberField label="H" value={element.height} min={0} onChange={(height) => updateContinuous({ height })} onCommit={commit} />
            <NumberField label="Rotate" value={element.rotation} onChange={(rotation) => updateContinuous({ rotation })} onCommit={commit} />
            <NumberField label="Opacity" value={element.opacity} step={0.05} min={0} max={1} onChange={(opacity) => updateContinuous({ opacity })} onCommit={commit} />
          </div>
          <h4 className="property-heading">Appearance</h4>
          {element.type === "text" && <>
            <button className="edit-text-button" onClick={() => editText(element.id)}>Open advanced Markdown · LaTeX · Code editor…</button>
            <ColorField label="Text color" value={element.style.color} onChange={(color) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.color = color; })} onCommit={commit} />
            <NumberField label="Font size" value={element.style.fontSize} onChange={(fontSize) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.fontSize = fontSize; })} onCommit={commit} />
            <FontFamilyPicker value={element.style.fontFamily} onChange={(fontFamily) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.fontFamily = fontFamily; })} />
            <span className="inspector-control-label">Horizontal alignment</span><AlignmentButtons label="Horizontal alignment" value={element.style.textAlign} values={["left", "center", "right"]} onChange={(value) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.textAlign = value as "left" | "center" | "right"; })} />
            <span className="inspector-control-label">Vertical alignment</span><AlignmentButtons label="Vertical alignment" value={element.style.verticalAlign} values={["top", "middle", "bottom"]} onChange={(value) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.verticalAlign = value as "top" | "middle" | "bottom"; })} />
          </>}
          {element.type === "shape" && <>
            <ColorField label="Fill" value={element.fill} allowTransparent onChange={(fill) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.fill = fill; })} onCommit={commit} />
            <NumberField label="Border width" value={element.strokeWidth} onChange={(strokeWidth) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.strokeWidth = Math.max(0, strokeWidth); })} onCommit={commit} />
            <ColorField label="Border color" value={element.stroke} allowTransparent onChange={(stroke) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.stroke = stroke; })} onCommit={commit} />
            <CheckboxField label="Shadow" checked={element.shadow.enabled} onChange={(enabled) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.shadow.enabled = enabled; })} />
            {element.shadow.enabled && <>
              <ColorField label="Shadow color" value={element.shadow.color} allowTransparent onChange={(color) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.shadow.color = color; })} onCommit={commit} />
              <div className="field-grid"><NumberField label="Shadow X" value={element.shadow.offsetX} onChange={(offsetX) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.shadow.offsetX = offsetX; })} onCommit={commit} /><NumberField label="Shadow Y" value={element.shadow.offsetY} onChange={(offsetY) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.shadow.offsetY = offsetY; })} onCommit={commit} /></div>
              <RangeField label="Shadow blur" value={element.shadow.blur} min={0} max={160} onChange={(blur) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "shape") target.shadow.blur = blur; })} onCommit={commit} />
            </>}
          </>}
          {element.type === "table" && <>
            <div className="table-size-actions">
              <button onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows + 1, target.columns); })}><span className="codicon codicon-add" /> Row</button>
              <button disabled={element.rows <= 1} onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows - 1, target.columns); })}><span className="codicon codicon-remove" /> Row</button>
              <button onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows, target.columns + 1); })}><span className="codicon codicon-add" /> Column</button>
              <button disabled={element.columns <= 1} onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows, target.columns - 1); })}><span className="codicon codicon-remove" /> Column</button>
            </div>
            <CheckboxField label="Header row" checked={element.headerRow} onChange={(headerRow) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.headerRow = headerRow; })} />
            <div className="table-cell-editor" style={{ gridTemplateColumns: `repeat(${element.columns}, minmax(86px, 1fr))` }}>
              {Array.from({ length: element.rows }, (_, row) => Array.from({ length: element.columns }, (_, column) => <textarea className={row === 0 && element.headerRow ? "header-cell" : ""} key={`${row}-${column}`} aria-label={`Row ${row + 1}, column ${column + 1}`} value={element.cells[row]?.[column] ?? ""} onChange={(event) => { preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type !== "table") return; target.cells = normalizedTableCells(target); target.cells[row]![column] = event.target.value; }); scheduleCommit(); }} onBlur={commit} />))}
            </div>
            <NumberField label="Font size" value={element.style.fontSize} onChange={(fontSize) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.fontSize = Math.max(0, fontSize); })} onCommit={commit} />
            <FontFamilyPicker value={element.style.fontFamily} onChange={(fontFamily) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.fontFamily = fontFamily; })} />
            <ColorField label="Text color" value={element.style.color} onChange={(color) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.color = color; })} onCommit={commit} />
            <ColorField label="Header fill" value={element.style.headerFill} allowTransparent onChange={(headerFill) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.headerFill = headerFill; })} onCommit={commit} />
            <ColorField label="Cell fill" value={element.style.cellFill} allowTransparent onChange={(cellFill) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.cellFill = cellFill; })} onCommit={commit} />
            <NumberField label="Border width" value={element.style.borderWidth} onChange={(borderWidth) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.borderWidth = Math.max(0, borderWidth); })} onCommit={commit} />
            <ColorField label="Border color" value={element.style.borderColor} allowTransparent onChange={(borderColor) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.borderColor = borderColor; })} onCommit={commit} />
            <span className="inspector-control-label">Horizontal alignment</span><AlignmentButtons label="Horizontal alignment" value={element.style.textAlign} values={["left", "center", "right"]} onChange={(value) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.textAlign = value as "left" | "center" | "right"; })} />
            <span className="inspector-control-label">Vertical alignment</span><AlignmentButtons label="Vertical alignment" value={element.style.verticalAlign} values={["top", "middle", "bottom"]} onChange={(value) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.style.verticalAlign = value as "top" | "middle" | "bottom"; })} />
          </>}
          {(element.type === "image" || element.type === "video") && <>
            <div className="media-source-card"><span className={`storage-badge ${element.storage}`}>{element.storage}</span><code title={element.src}>{element.src}</code><div><button onClick={() => relinkMedia(element.type, element.id)}>Choose linked file…</button>{element.storage === "linked" && <button onClick={() => postMessage({ type: "embedMedia", elementIds: [element.id] })}>Embed in .assets</button>}</div></div>
            <RangeField label="Corner radius" value={element.borderRadius} min={0} max={Math.max(1, Math.round(Math.min(element.width, element.height) / 2))} onChange={(borderRadius) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image" || target?.type === "video") target.borderRadius = borderRadius; })} onCommit={commit} />
            <p className="panel-help">Drag the yellow point on the top edge to round corners.</p>
          </>}
          {element.type === "image" && <>
            <RangeField label="Border width" value={element.border.width} min={0} max={40} onChange={(width) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.border.width = width; })} onCommit={commit} />
            <ColorField label="Border color" value={element.border.color} allowTransparent onChange={(color) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.border.color = color; })} onCommit={commit} />
            <RangeField label="Edge fade" value={element.edgeFade} min={0} max={Math.max(1, Math.round(Math.min(element.width, element.height) / 2))} onChange={(edgeFade) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.edgeFade = edgeFade; })} onCommit={commit} />
            <p className="panel-help">Drag the blue point upward from the bottom edge to fade all four sides.</p>
            <RangeField label="Crop zoom" value={cropZoomPercent(element.crop)} min={100} max={1000} onChange={(percent) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.crop = setCropZoom(target.crop, percent); })} onCommit={commit} suffix="%" />
            <button className={`edit-text-button ${cropActive ? "active" : ""}`} onClick={() => editImage(element.id)}>{cropActive ? "Cropping on canvas…" : "Crop image (or double-click)"}</button>
            <label>Alt text<textarea value={element.alt ?? ""} onChange={(event) => updateContinuous({ alt: event.target.value })} onBlur={commit} /></label>
          </>}
          {element.type === "video" && <>
            <label>Playback<select value={element.playback.mode} onChange={(event) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.mode = event.target.value as "manual" | "autoplay"; })}><option value="manual">Manual</option><option value="autoplay">Autoplay</option></select></label>
            <CheckboxField label="Muted" checked={element.playback.muted} onChange={(muted) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.muted = muted; })} />
            <CheckboxField label="Loop" checked={element.playback.loop} onChange={(loop) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.loop = loop; })} />
            <CheckboxField label="Controls" checked={element.playback.controls} onChange={(controls) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "video") target.playback.controls = controls; })} />
          </>}
        </> : <>
          <label>Slide title<input value={slide.title} onChange={(event) => { preview((draft) => { draft.slides.find((item) => item.id === slide.id)!.title = event.target.value; }); scheduleCommit(); }} onBlur={commit} /></label>
          <ColorField label="Background" value={slide.background ?? deck.theme.background} onChange={(background) => continuous((draft) => { draft.slides.find((item) => item.id === slide.id)!.background = background; })} onCommit={commit} />
          <h4 className="property-heading">Background image</h4>
          {slide.backgroundImage ? <div className="media-source-card"><span className={`storage-badge ${slide.backgroundImage.storage}`}>{slide.backgroundImage.storage}</span><code title={slide.backgroundImage.src}>{slide.backgroundImage.src}</code><div><button onClick={chooseBackgroundImage}>Replace image…</button><button className="danger-quiet" onClick={() => mutate((draft) => { delete draft.slides.find((item) => item.id === slide.id)!.backgroundImage; })}>Remove</button></div></div> : <button className="edit-text-button" onClick={chooseBackgroundImage}><span className="codicon codicon-file-media" /> Choose background image…</button>}
          <h4 className="property-heading">Transition</h4>
          <TransitionControls transition={slide.transition} update={(patch) => mutate((draft) => Object.assign(draft.slides.find((item) => item.id === slide.id)!.transition, patch))} />
          <CheckboxField label="Hide page number" checked={slide.hidePageNumber} onChange={(hidePageNumber) => mutate((draft) => { draft.slides.find((item) => item.id === slide.id)!.hidePageNumber = hidePageNumber; })} />
        </>}
      </>}
      {tab === "layers" && <><h3>Layers</h3>{[...slide.elements].sort((a, b) => b.z - a.z).map((item) => <div className={`layer-row ${item.id === element?.id ? "active" : ""}`} key={item.id} onClick={() => selectElement(item.id)}><span>{item.name ?? `${item.type} ${item.id.slice(0, 4)}`}</span><button title={item.locked ? "Unlock" : "Lock"} aria-label={item.locked ? "Unlock" : "Lock"} onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.locked = !target.locked; }); }}><span className={`codicon codicon-${item.locked ? "lock" : "unlock"}`} /></button><button title={item.hidden ? "Show" : "Hide"} aria-label={item.hidden ? "Show" : "Hide"} onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.hidden = !target.hidden; }); }}><span className={`codicon codicon-${item.hidden ? "eye-closed" : "eye"}`} /></button><button title="Bring forward" aria-label="Bring forward" onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.z += 1; }); }}><span className="codicon codicon-arrow-up" /></button><button title="Send backward" aria-label="Send backward" onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.z -= 1; }); }}><span className="codicon codicon-arrow-down" /></button></div>)}</>}
      {tab === "animations" && <><h3>Animation timeline</h3><p className="panel-help">Select an element, then add its entrance. The cards run from top to bottom.</p><button className="add-animation" disabled={!element} onClick={() => element && mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.timeline.push(defaultAnimation(element.id)))}><span className="codicon codicon-add" /> Add entrance{element ? ` for ${elementLabel(element)}` : ""}</button><div className="animation-list">{slide.timeline.map((step, index) => <AnimationRow key={step.id} step={step} index={index} flowLabel={animationFlowLabel(slide.timeline, index)} element={slide.elements.find((item) => item.id === step.targetElementId)} selectElement={selectElement} mutate={(patch) => mutate((draft) => Object.assign(draft.slides.find((item) => item.id === slide.id)!.timeline[index]!, patch))} remove={() => mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.timeline.splice(index, 1))} />)}</div></>}
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

function TextEditor({ deck, slideId, elementId, preview, scheduleCommit, commit, close }: { deck: Deck; slideId: string; elementId: string; preview(fn: (deck: Deck) => void): void; scheduleCommit(): void; commit(): void; close(): void }) {
  const element = findElement(deck, slideId, elementId);
  const slide = deck.slides.find((item) => item.id === slideId);
  if (element?.type !== "text") return null;
  const background = slide?.background ?? deck.layouts[slide?.layout ?? ""]?.background ?? deck.theme.background;
  const finish = () => { commit(); close(); };
  return <div className="modal-backdrop" onMouseDown={finish}><div className="text-editor" onMouseDown={(event) => event.stopPropagation()}><header><strong>Markdown · LaTeX · Code</strong><button onClick={finish}>Done</button></header><textarea autoFocus value={element.markdown} onKeyDown={(event) => { if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) { event.preventDefault(); finish(); } }} onChange={(event) => { preview((draft) => { const target = findElement(draft, slideId, elementId); if (target?.type === "text") target.markdown = event.target.value; }); scheduleCommit(); }} onBlur={commit} /><section className="text-preview-panel"><strong>Live preview</strong><div className="text-preview" style={{ background, fontFamily: element.style.fontFamily, fontSize: Math.min(element.style.fontSize, 34), fontWeight: element.style.fontWeight, color: element.style.color, textAlign: element.style.textAlign, lineHeight: element.style.lineHeight }} dangerouslySetInnerHTML={{ __html: renderMarkdown(element.markdown) }} /></section><p>Use <code>$x^2$</code>, <code>$$…$$</code>, and fenced code blocks. Press <code>Ctrl/Cmd+Enter</code> or <code>Escape</code> to finish.</p></div></div>;
}

const InlineTextEditor = forwardRef<InlineTextEditorHandle, {
  element: Extract<SlideElement, { type: "text" }>;
  selectAll: boolean;
  preview(markdown: string): void;
  finish(): void;
}>(function InlineTextEditor({ element, selectAll, preview, finish }, ref) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const applyFormat = (command: TextFormatCommand) => {
    const input = textarea.current;
    if (!input) return;
    const selection: TextSelection = { start: input.selectionStart, end: input.selectionEnd };
    const edit = command === "bold"
      ? toggleInlineMarkdown(element.markdown, selection, "**")
      : command === "italic"
        ? toggleInlineMarkdown(element.markdown, selection, "_")
        : toggleMarkdownList(element.markdown, selection, command === "ordered-list");
    preview(edit.text);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(edit.selection.start, edit.selection.end);
    });
  };
  useImperativeHandle(ref, () => ({ format: applyFormat, focus: () => textarea.current?.focus() }), [element.markdown]);
  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.focus();
    if (selectAll) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
  }, [element.id]);
  const keyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const accelerator = (event.ctrlKey || event.metaKey) && !event.altKey;
    if (accelerator && (event.key.toLowerCase() === "b" || event.key.toLowerCase() === "i")) {
      event.preventDefault();
      event.stopPropagation();
      applyFormat(event.key.toLowerCase() === "b" ? "bold" : "italic");
      return;
    }
    if (event.key === "Escape" || (accelerator && event.key === "Enter")) {
      event.preventDefault();
      event.stopPropagation();
      finish();
    }
  };
  const shellStyle: CSSProperties = {
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: `rotate(${element.rotation}deg)`,
    opacity: element.opacity,
    zIndex: 2147482000
  };
  const style: CSSProperties = {
    fontFamily: element.style.fontFamily,
    fontSize: element.style.fontSize,
    fontWeight: element.style.fontWeight,
    color: element.style.color,
    textAlign: element.style.textAlign,
    lineHeight: element.style.lineHeight,
    padding: element.style.padding
  };
  return <div className="inline-text-editor-shell" style={shellStyle}>
    <span className="inline-text-editor-badge" aria-live="polite">editing...</span>
    <textarea ref={textarea} className="inline-text-editor" aria-label="Edit text box Markdown" title="Markdown text · Ctrl/Cmd+Enter or Escape to finish" value={element.markdown} style={style} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={keyDown} onChange={(event) => preview(event.target.value)} onBlur={finish} />
  </div>;
});

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
      if (error) showError(`Could not list system fonts: ${error}`);
      else if (family) onChange(family);
    });
    postMessage({ type: "selectFont", requestId, current: value });
  };
  return <label>Font family<div className="font-picker"><select value={value} onChange={(event) => onChange(event.target.value)}>{[...custom, ...available].map((font) => <option key={font.value} value={font.value} style={{ fontFamily: font.value }}>{font.label}</option>)}</select><button type="button" title="Choose a font installed on this computer" onClick={discover}>System fonts…</button></div></label>;
}

function CompactFontPicker({ value, onChange }: { value: string; onChange(value: string): void }) {
  const available = [...FONT_CANDIDATES];
  const custom = available.some((font) => font.value === value) ? [] : [{ label: `Current: ${value}`, value }];
  const discover = () => {
    const requestId = crypto.randomUUID();
    pendingFonts.set(requestId, (family, error) => {
      pendingFonts.delete(requestId);
      if (error) showError(`Could not list system fonts: ${error}`);
      else if (family) onChange(family);
    });
    postMessage({ type: "selectFont", requestId, current: value });
  };
  return <div className="context-font"><select aria-label="Font family" value={value} onChange={(event) => onChange(event.target.value)}>{[...custom, ...available].map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select><button type="button" title="Choose a system font" aria-label="Choose a system font" onClick={discover}>…</button></div>;
}

function NumberField({ label, value, step = 1, min, max, onChange, onCommit }: { label: string; value: number; step?: number; min?: number; max?: number; onChange(value: number): void; onCommit?(): void }) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const update = (next: number) => onChange(roundStep(clampOptional(next, min, max), step));
  const nudge = (direction: -1 | 1, event: { shiftKey: boolean; altKey: boolean }) => update(safeValue + direction * step * (event.shiftKey ? 10 : event.altKey ? 0.1 : 1));
  return <label className="number-field"><span>{label}</span><span className="number-control"><button type="button" tabIndex={-1} title={`Decrease ${label} · Shift for ×10`} aria-label={`Decrease ${label}`} onClick={(event) => { nudge(-1, event); onCommit?.(); }}><span className="codicon codicon-remove" /></button><input type="number" value={safeValue} step={step} min={min} max={max} onFocus={(event) => event.currentTarget.select()} onWheel={(event) => { if (document.activeElement !== event.currentTarget) return; event.preventDefault(); nudge(event.deltaY > 0 ? -1 : 1, event); }} onChange={(event) => update(Number(event.target.value))} onBlur={onCommit} /><button type="button" tabIndex={-1} title={`Increase ${label} · Shift for ×10`} aria-label={`Increase ${label}`} onClick={(event) => { nudge(1, event); onCommit?.(); }}><span className="codicon codicon-add" /></button></span></label>;
}
function RangeField({ label, value, min, max, onChange, onCommit, suffix = " px" }: { label: string; value: number; min: number; max: number; onChange(value: number): void; onCommit?(): void; suffix?: string }) { return <label className="range-field"><span>{label}<output>{Math.round(value)}{suffix}</output></span><input type="range" min={min} max={max} step="1" value={clamp(value, min, max)} onChange={(event) => onChange(Number(event.target.value))} onPointerUp={onCommit} onPointerCancel={onCommit} onKeyUp={onCommit} onBlur={onCommit} /></label>; }
function ColorField({ label, value, allowTransparent = false, onChange, onCommit }: { label: string; value: string; allowTransparent?: boolean; onChange(value: string): void; onCommit?(): void }) {
  const transparent = value.trim().toLowerCase() === "transparent";
  return <label>{label}<span className="color-field"><input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} disabled={transparent} onChange={(event) => onChange(event.target.value)} onBlur={onCommit} /><input value={value} onChange={(event) => onChange(event.target.value)} onBlur={onCommit} />{allowTransparent && <button type="button" className={`transparent-toggle ${transparent ? "active" : ""}`} title={transparent ? "Use an opaque color" : "Make transparent"} aria-label={transparent ? `Disable transparent ${label}` : `Make ${label} transparent`} onClick={() => { onChange(transparent ? "#000000" : "transparent"); onCommit?.(); }}><span className="codicon codicon-circle-slash" /></button>}</span></label>;
}
function CheckboxField({ label, checked, onChange }: { label: string; checked: boolean; onChange(checked: boolean): void }) { return <label className="checkbox-field"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>; }

function ToastStack() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  useEffect(() => onToast((toast) => {
    setToasts((current) => updateToasts(current, toast));
  }), []);
  useEffect(() => {
    const timers = toasts.filter((toast) => toast.kind === "success").map((toast) => window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== toast.id));
    }, 2500));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [toasts]);
  if (!toasts.length) return null;
  return <div className="toast-stack" role="region" aria-label="Notifications">{toasts.map((toast) => <div className={`toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"} key={toast.id}>
    <span className={`codicon codicon-${toast.kind === "progress" ? "loading codicon-modifier-spin" : toast.kind === "success" ? "check" : "error"}`} />
    <span>{toast.message}</span>
    {toast.kind === "error" && <button title="Dismiss" aria-label="Dismiss notification" onClick={() => notifyToast({ id: toast.id, kind: "dismiss" })}><span className="codicon codicon-close" /></button>}
  </div>)}</div>;
}

function showError(message: string): void { notifyToast({ id: crypto.randomUUID(), kind: "error", message }); }

function InvalidDeck({ message, gitConflict }: { message: string; gitConflict: boolean }) { return <div className="invalid"><h1>{gitConflict ? "This deck has an unresolved Git conflict" : "SlidePix could not open this deck"}</h1><pre>{message}</pre>{gitConflict ? <p><button onClick={() => postMessage({ type: "command", command: "resolveGitConflict" })}>Resolve with SlidePix</button> <button onClick={() => postMessage({ type: "command", command: "openTextEditor" })}>Open as text</button></p> : <p>Fix the JSON in the text editor. SlidePix will reopen the last valid preview automatically.</p>}</div>; }

function MergeConflictDialog({ conflict, resolve, useLatest }: { conflict?: import("@slidepix/core").DeckMergeConflict; resolve(id: string, resolution: import("@slidepix/core").DeckMergeResolution): void; useLatest(): void }) {
  if (!conflict) return null;
  const context = [conflict.slideId && `slide ${conflict.slideId}`, conflict.elementId && `element ${conflict.elementId}`, conflict.animationId && `animation ${conflict.animationId}`].filter(Boolean).join(" · ");
  const show = (value: unknown) => value === undefined ? "(deleted)" : typeof value === "string" ? value : JSON.stringify(value);
  return <div className="modal-backdrop"><div className="merge-conflict"><header><strong>Concurrent edit conflict</strong></header><p>{conflict.message}</p><p><code>{context || conflict.path}</code></p><div className="merge-values"><button onClick={() => resolve(conflict.id, "ours")}><strong>Keep mine</strong><span>{show(conflict.ours)}</span></button><button onClick={() => resolve(conflict.id, "theirs")}><strong>Use latest</strong><span>{show(conflict.theirs)}</span></button><button onClick={() => resolve(conflict.id, "base")}><strong>Use original</strong><span>{show(conflict.base)}</span></button></div><button className="danger-quiet" onClick={useLatest}>Discard all my pending changes</button></div></div>;
}

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
function handleHostMessage(message: HostToWebviewMessage, setDeck: (deck: Deck, revision: string, uri: string, linkedUri: string) => void, setInvalid: (message: string, gitConflict: boolean, uri: string, linkedUri: string) => void, handleEditResult: (message: Extract<HostToWebviewMessage, { type: "documentEditResult" }>) => void, handleHistoryResult: (message: Extract<HostToWebviewMessage, { type: "historyResult" }>) => void) { if (message.type === "deck") setDeck(message.deck, message.revision, message.uri, message.linkedUri); else if (message.type === "invalidDeck") setInvalid(message.message, message.gitConflict, message.uri, message.linkedUri); else if (message.type === "documentEditResult") handleEditResult(message); else if (message.type === "historyResult") handleHistoryResult(message); else if (message.type === "assetImported") { pendingAssets.get(message.requestId)?.(message.reference && message.storage ? { reference: message.reference, storage: message.storage } : undefined, message.error); pendingAssets.delete(message.requestId); } else if (message.type === "fontSelected") pendingFonts.get(message.requestId)?.(message.family, message.error); else if (message.type === "notify") notifyToast({ id: message.notificationId, kind: message.status, message: message.message }); }
async function sendAsset(file: File): Promise<MediaResult | undefined> { const requestId = crypto.randomUUID(); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return new Promise((resolve) => { pendingAssets.set(requestId, (result, error) => { if (error) showError(error); resolve(result); }); postMessage({ type: "importAsset", requestId, name: file.name, mime: file.type, base64: btoa(binary) }); }); }
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

import Moveable from "react-moveable";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import {
  duplicateSlide,
  elementSchema,
  fitAspectBoxInSlide,
  fitLockedAspectBox,
  heightForLockedAspect,
  renderMarkdown,
  widthForLockedAspect,
  type AnimationStep,
  type Deck,
  type HostToWebviewMessage,
  type MediaStorage,
  type Slide,
  type SlideElement,
  type Transition,
  manimElementAspectRatio,
  manimRenderFingerprint,
  manimSettingsFingerprint,
  type ManimOrientation,
  type ManimQuality
} from "@slidepix/core";
import { SlideView } from "./SlideView";
import { clamp, cropBoxByEdges, localPointerDelta, panCrop, type CropBox } from "./geometry";
import { applyAlign, applyDistribute, type AlignAction, type AlignRelativeTo, type DistributeAction } from "./align";
import { peerBoxes, resizeEdges, snapMove, snapResize, snapThreshold, type SnapGuide } from "./snap";
import { railDropIndex } from "./rail";
import { syncNamedShapes } from "./shape-batch";
import { useDeckStore } from "./store";
import { insertTextTab, toggleInlineMarkdown, toggleMarkdownList, type TextSelection } from "./text-format";
import { clearManimProgress, notifyToast, onManimProgress, onManimProgressClear, onToast, publishManimProgress, updateToasts, type ToastMessage } from "./toasts";
import { onHostMessage, postMessage } from "./vscode";
import { assetCacheKey, collaborationView, ghostPoses, localPreview, noteAssets, peerMarks, setCollaboration, subscribeCollaboration, textLockHolder } from "./presence";
import { jsPDF } from "jspdf";
import { captureSlidePng, describeExportError, inlineImages, inlineVideos } from "./export-capture";

type Tab = "properties" | "layers" | "animations";
const transitionTypes: Transition["type"][] = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "morph"];
type MediaResult = { reference: string; storage: MediaStorage };
const pendingAssets = new Map<string, (result?: MediaResult, error?: string) => void>();
const pendingFonts = new Map<string, (family?: string, error?: string) => void>();
const pendingManimScripts = new Map<string, (message: Extract<HostToWebviewMessage, { type: "manimScriptSelected" }>) => void>();
const pendingManimCreates = new Map<string, (message: Extract<HostToWebviewMessage, { type: "manimScriptCreated" }>) => void>();
const pendingManimScenes = new Map<string, (message: Extract<HostToWebviewMessage, { type: "manimScenesListed" }>) => void>();
const pendingManimRenders = new Map<string, (message: Extract<HostToWebviewMessage, { type: "manimRenderResult" }>) => void>();
const pendingManimRenderAll = new Map<string, (message: Extract<HostToWebviewMessage, { type: "manimRenderAllResult" }>) => void>();
const manimHostAcked = new Set<string>();
let manimUiBusy = false;
let manimSetupTimer = 0;
const manimRenderedFingerprints = new Map<string, string>();
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
  const [croppingId, setCroppingId] = useState<string>();
  const [notesCollapsed, setNotesCollapsed] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [batchShapeEdit, setBatchShapeEdit] = useState(false);
  const inlineTextEditor = useRef<InlineTextEditorHandle>(null);
  const pendingTextFormat = useRef<TextFormatCommand | undefined>(undefined);
  const moveableRef = useRef<Moveable | null>(null);
  const dragOrigins = useRef<{ id: string; x: number; y: number }[]>([]);
  const snapPeers = useRef<ReturnType<typeof peerBoxes>>([]);
  const snapHold = useRef<SnapGuide[]>([]);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const collaboration = useSyncExternalStore(subscribeCollaboration, collaborationView, collaborationView);
  const presenceSentAt = useRef(0);

  useEffect(() => onHostMessage((message) => handleHostMessage(message, store.setFromHost, store.setInvalid, store.handleEditResult, store.handleHistoryResult)), []);
  useEffect(() => { postMessage({ type: "ready" }); }, []);
  useEffect(() => {
    if (!store.historyError) return;
    showError(store.historyError);
    store.clearHistoryError();
  }, [store.historyError]);

  const deck = store.deck;
  const slide = deck?.slides.find((item) => item.id === store.selectedSlideId) ?? deck?.slides[0];
  const selectedElements = slide?.elements.filter((item) => store.selectedElementIds.includes(item.id)) ?? [];
  const selected = selectedElements.find((item) => item.id === store.selectedElementId) ?? selectedElements[0];
  const editingText = slide?.elements.find((item): item is Extract<SlideElement, { type: "text" }> => item.id === editingTextId && item.type === "text");
  const dragTarget = selectedElements.find((item) => !item.locked) ?? selected;
  const target = dragTarget && !dragTarget.locked ? document.getElementById(`element-${dragTarget.id}`) : null;
  const cropping = selected?.type === "image" && croppingId === selected.id;
  const guest = collaboration.role === "guest";
  const liveOn = collaboration.status !== "off";

  useEffect(() => {
    if (!liveOn || collaboration.status === "ended") return;
    const send = () => {
      const now = Date.now();
      if (now - presenceSentAt.current < 66) return;
      presenceSentAt.current = now;
      const preview = localPreview(store.deck, store.confirmedDeck, slide?.id, store.selectedElementIds);
      postMessage({ type: "presence", slideId: slide?.id, elementIds: store.selectedElementIds, editingElementId: editingTextId, preview });
    };
    send();
    const beat = window.setInterval(send, 2000);
    return () => window.clearInterval(beat);
  }, [liveOn, collaboration.status, slide?.id, editingTextId, store.selectedElementIds.join(","), store.deck, store.confirmedDeck]);

  useEffect(() => {
    if (!selected || selected.type !== "image" || selected.id !== croppingId) setCroppingId(undefined);
  }, [selected?.id, selected?.type, croppingId]);
  useEffect(() => setBatchShapeEdit(false), [selected?.id]);
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
    if (!slide || selected?.type !== "manim" || !selected.outputMedia || !selected.lockAspectRatio) return;
    lockMediaAspect(
      slide.id,
      selected.id,
      manimElementAspectRatio(selected.orientation),
      store.mutate
    );
  }, [
    slide?.id,
    selected?.id,
    selected?.type === "manim" ? selected.outputMedia?.src : undefined,
    selected?.type === "manim" ? selected.orientation : undefined,
    selected?.type === "manim" ? selected.lockAspectRatio : undefined
  ]);

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
      if (event.key === "Escape" && croppingId) {
        event.preventDefault();
        setCroppingId(undefined);
        return;
      }
      if (!deck || !slide || !selectedElements.length || editingTextId || textEntry) return;
      if ((event.key === "Enter" || event.key === "F2") && selected?.type === "text" && selectedElements.length === 1) {
        event.preventDefault();
        setSelectAllOnEdit(false);
        setEditingTextId(selected.id);
        return;
      }
      const delta = event.shiftKey ? 10 : 1;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        store.preview((draft) => {
          for (const current of selectedElements) {
            if (current.locked) continue;
            const element = findElement(draft, slide.id, current.id);
            if (!element) continue;
            if (event.key === "ArrowLeft") element.x -= delta;
            if (event.key === "ArrowRight") element.x += delta;
            if (event.key === "ArrowUp") element.y -= delta;
            if (event.key === "ArrowDown") element.y += delta;
          }
        });
        store.scheduleCommit();
        requestAnimationFrame(() => moveableRef.current?.updateRect());
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteElements(slide.id, selectedElements.map((item) => item.id), store.mutate, store.selectElement);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [deck, slide, selected, selectedElements, editingTextId, croppingId]);

  if (store.error) return <InvalidDeck message={store.error} gitConflict={store.gitConflict} />;
  if (!deck || !slide) return <div className="loading">Opening SlidePix…</div>;

  const assetUrl = (reference: string, storage: MediaStorage) => {
    const base = storage === "linked" ? store.linkedSourceUri : store.sourceUri;
    if (!base) return reference;
    try {
      const url = new URL(reference.replaceAll("\\", "/"), `${base.replace(/\/$/, "")}/`);
      const version = assetCacheKey(reference);
      if (version) url.searchParams.set("v", version);
      return url.toString();
    } catch { return reference; }
  };
  const addMedia = (kind: "image" | "video", result: MediaResult, name?: string, elementId?: string) => {
    let fitId: string | undefined;
    store.mutate((draft) => {
      const targetSlide = draft.slides.find((item) => item.id === slide.id)!;
      const existing = elementId ? targetSlide.elements.find((item) => item.id === elementId) : undefined;
      if (existing?.type === kind) {
        existing.src = result.reference;
        existing.storage = result.storage;
        if (existing.lockAspectRatio) fitId = existing.id;
        return;
      }
      const common = baseElement(targetSlide.elements.length, kind);
      targetSlide.elements.push(kind === "image"
        ? { ...common, type: "image", src: result.reference, storage: result.storage, crop: { x: 0, y: 0, width: 1, height: 1 }, borderRadius: 0, edgeFade: 0, border: { width: 0, color: "transparent" }, alt: name ?? "", lockAspectRatio: true }
        : { ...common, type: "video", src: result.reference, storage: result.storage, poster: undefined, borderRadius: 0, playback: { mode: "manual", muted: false, loop: false, controls: true }, lockAspectRatio: true });
      fitId = common.id;
    });
    if (!fitId) return;
    const elementToFit = fitId;
    const url = assetUrl(result.reference, result.storage);
    void measureMediaAspect(url, kind).then((aspectRatio) => lockMediaAspect(slide.id, elementToFit, aspectRatio, store.mutate));
  };
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
    const holder = textLockHolder(collaboration.peers, collaboration.self?.id, id);
    if (holder) return void showError(`${holder.name} is editing this text`);
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
  const addManim = (output: "image" | "video") => {
    const width = deck.size.width / 2;
    const height = width * 9 / 16;
    const common = baseElement(slide.elements.length, "manim");
    store.mutate((draft) => {
      draft.slides.find((item) => item.id === slide.id)!.elements.push({
        ...common,
        type: "manim",
        x: (deck.size.width - width) / 2,
        y: (deck.size.height - height) / 2,
        width,
        height,
        output,
        orientation: "horizontal",
        quality: "medium",
        transparent: false,
        lockAspectRatio: true,
        aspectRatio: 16 / 9,
        playback: { mode: "manual", muted: false, loop: false, controls: true }
      });
    });
    store.selectElement(common.id);
    setInspectorCollapsed(false);
    setTab("properties");
  };
  const setManimQuality = (quality: ManimQuality) => {
    const hasManim = deck.slides.some((item) => item.elements.some((element) => element.type === "manim"));
    if (!hasManim) return void showError("This deck has no Manim elements.");
    store.mutate((draft) => {
      for (const item of draft.slides) {
        for (const element of item.elements) {
          if (element.type === "manim") element.quality = quality;
        }
      }
    });
  };
  const renderAllManim = () => {
    if (manimUiBusy) return;
    manimUiBusy = true;
    const requestId = crypto.randomUUID();
    notifyToast({ id: requestId, kind: "progress", message: "Rendering all Manim scenes…", progress: 0 });
    const timer = window.setTimeout(() => {
      if (manimHostAcked.has(requestId) || !pendingManimRenderAll.has(requestId)) return;
      pendingManimRenderAll.delete(requestId);
      manimUiBusy = false;
      notifyToast({ id: requestId, kind: "error", message: "SlidePix did not start the render. Stop the debug session and launch SlidePix Extension again." });
    }, 4000);
    pendingManimRenderAll.set(requestId, (message) => {
      window.clearTimeout(timer);
      manimUiBusy = false;
      for (const result of message.results ?? []) {
        if (result.settingsFingerprint) manimRenderedFingerprints.set(result.elementId, result.settingsFingerprint);
      }
      clearManimProgress();
      if (message.ok) notifyToast({ id: requestId, kind: "success", message: `Rendered ${message.rendered} Manim scene${message.rendered === 1 ? "" : "s"}.` });
      else if (message.error && message.error !== "Manim render cancelled.") notifyToast({ id: requestId, kind: "error", message: message.error });
      else notifyToast({ id: requestId, kind: "dismiss" });
    });
    postMessage({ type: "renderAllManim", requestId });
  };
  const copyElement = (event: ReactClipboardEvent<HTMLDivElement>, cut = false) => {
    if (!selectedElements.length || isTextEntryTarget(event.target)) return;
    event.preventDefault();
    slidepixClipboard = { version: 1, token: crypto.randomUUID(), deckId: deck.id, sourceSlideId: slide.id, elements: selectedElements.map((item) => structuredClone(item)) };
    event.clipboardData.setData(SLIDEPIX_CLIPBOARD_TYPE, JSON.stringify(slidepixClipboard));
    event.clipboardData.setData("text/plain", `slidepix://clipboard/${slidepixClipboard.token}`);
    if (cut) deleteElements(slide.id, selectedElements.map((item) => item.id), store.mutate, store.selectElement);
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
      const ids = pasted.map((item) => item.id);
      store.selectElement(ids[0]);
      ids.slice(1).forEach((id) => store.selectElement(id, true));
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
    <div className={`app${railCollapsed ? " rail-collapsed" : ""}${inspectorCollapsed ? " inspector-collapsed" : ""}${liveOn ? " live-on" : ""}`} onCopy={(event) => copyElement(event)} onCut={(event) => copyElement(event, true)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
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
        addManim={addManim}
        setManimQuality={setManimQuality}
        renderAllManim={renderAllManim}
        setupManim={() => {
          if (manimUiBusy) return;
          manimUiBusy = true;
          notifyToast({ id: "manim-setup", kind: "progress", message: "Opening Manim setup…" });
          window.clearTimeout(manimSetupTimer);
          manimHostAcked.delete("manim-setup");
          manimSetupTimer = window.setTimeout(() => {
            if (manimHostAcked.has("manim-setup")) return;
            manimUiBusy = false;
            notifyToast({ id: "manim-setup", kind: "error", message: "SlidePix did not open Manim setup. Stop the debug session and launch SlidePix Extension again." });
          }, 4000);
          postMessage({ type: "setupManim" });
        }}
        hasLinkedMedia={deck.slides.some((item) => item.backgroundImage?.storage === "linked" || item.elements.some((element) => (element.type === "image" || element.type === "video") && element.storage === "linked"))}
        historyBusy={Boolean(store.historyPending)}
        canUndo={store.canUndo || store.dirty}
        canRedo={store.canRedo}
        mutate={store.mutate}
        preview={store.preview}
        scheduleCommit={store.scheduleCommit}
        commit={store.commit}
        editAdvanced={(id) => { store.commit(); setEditingTextId(undefined); setAdvancedTextId(id); }}
        formatText={applyTextFormat}
        selectedElements={selectedElements}
        align={(action, relativeTo) => {
          const next = applyAlign(selectedElements, action, relativeTo, deck.size);
          flushSync(() => {
            store.mutate((draft) => {
              for (const box of next) {
                const element = findElement(draft, slide.id, box.id);
                if (element) { element.x = box.x; element.y = box.y; }
              }
            });
          });
          moveableRef.current?.updateRect();
        }}
        distribute={(action) => {
          const next = applyDistribute(selectedElements, action);
          flushSync(() => {
            store.mutate((draft) => {
              for (const box of next) {
                const element = findElement(draft, slide.id, box.id);
                if (element) { element.x = box.x; element.y = box.y; }
              }
            });
          });
          moveableRef.current?.updateRect();
        }}
        duplicateElement={() => {
          if (!selectedElements.length) return;
          const copies = selectedElements.map((item) => cloneElementForPaste(item, false));
          store.mutate((draft) => draft.slides.find((item) => item.id === slide.id)!.elements.push(...copies));
          store.selectElement(copies[0]?.id);
          copies.slice(1).forEach((item) => store.selectElement(item.id, true));
        }}
        deleteSelected={() => deleteElements(slide.id, selectedElements.map((item) => item.id), store.mutate, store.selectElement)}
        manimLocked={guest}
        sharing={collaboration.status === "hosting"}
      />
      <SlideRail collapsed={railCollapsed} onToggleCollapse={() => setRailCollapsed((value) => !value)} deck={deck} selectedId={slide.id} peerColors={peerMarks(collaboration.peers)} select={(id) => { store.commit(); setEditingTextId(undefined); store.selectSlide(id); }} mutate={store.mutate} resolveAsset={assetUrl} />
      <main className={`workspace ${notesCollapsed ? "notes-collapsed" : ""}`}>
        {liveOn && <div className="live-banner" role="status">
          <span>{collaboration.status === "hosting" ? "Sharing this deck" : collaboration.status === "reconnecting" ? "Reconnecting…" : collaboration.status === "ended" ? `Session ended — ${collaboration.hostName ?? "the host"} closed it` : `Connected to ${collaboration.hostName ?? "the host"}`}</span>
          <span className="live-avatars">{[collaboration.self, ...collaboration.peers].filter((peer): peer is NonNullable<typeof peer> => Boolean(peer)).map((peer) => <span key={peer.id} className="live-avatar" title={peer.name} style={{ background: peer.color }}>{peer.name.slice(0, 1).toUpperCase()}</span>)}</span>
          {collaboration.temporaryMirror && <button type="button" onClick={() => postMessage({ type: "command", command: "saveLiveCopy" })}>Save locally</button>}
          {collaboration.status === "ended" && !collaboration.temporaryMirror && <button type="button" onClick={() => postMessage({ type: "command", command: "saveLiveCopy" })}>Save a copy</button>}
          {collaboration.status === "hosting" && <button type="button" onClick={() => postMessage({ type: "command", command: "stopLive" })}>Stop</button>}
        </div>}
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
                selectedElementIds={store.selectedElementIds}
                editingElementId={editingTextId}
                resolveAsset={assetUrl}
                onSelectElement={store.selectElement}
                onEditText={(id) => beginTextEditing(id)}
                onEditImage={setCroppingId}
              />
              {target && dragTarget && !cropping && editingTextId !== dragTarget.id && (
                <Moveable
                  ref={moveableRef}
                  target={target}
                  dragTarget={target}
                  draggable
                  resizable={selectedElements.length === 1}
                  rotatable={selectedElements.length === 1}
                  clickable
                  origin={false}
                  zoom={1 / store.zoom}
                  onClick={({ isDouble }) => {
                    if (!isDouble || selectedElements.length !== 1) return;
                    if (dragTarget.type === "text") beginTextEditing(dragTarget.id);
                    if (dragTarget.type === "image") setCroppingId(dragTarget.id);
                  }}
                  onDragStart={() => {
                    dragOrigins.current = selectedElements.filter((item) => !item.locked).map((item) => ({ id: item.id, x: item.x, y: item.y }));
                    snapPeers.current = peerBoxes(slide.elements, store.selectedElementIds);
                  }}
                  onDrag={({ left, top, inputEvent, target: elementTarget }) => {
                    const origin = dragOrigins.current.find((item) => item.id === dragTarget.id);
                    if (!origin) return;
                    const snapped = shiftHeld(inputEvent)
                      ? snapMove(
                        { x: left, y: top, width: dragTarget.width, height: dragTarget.height },
                        snapPeers.current,
                        deck.size,
                        snapThreshold(store.zoom),
                      )
                      : { x: left, y: top, guides: [] as SnapGuide[] };
                    const dx = snapped.x - origin.x;
                    const dy = snapped.y - origin.y;
                    elementTarget.style.left = `${snapped.x}px`;
                    elementTarget.style.top = `${snapped.y}px`;
                    setSnapGuides(snapped.guides);
                    store.preview((draft) => {
                      for (const start of dragOrigins.current) {
                        const element = findElement(draft, slide.id, start.id);
                        if (!element) continue;
                        element.x = start.x + dx;
                        element.y = start.y + dy;
                        const node = document.getElementById(`element-${start.id}`);
                        if (node && start.id !== dragTarget.id) {
                          node.style.left = `${element.x}px`;
                          node.style.top = `${element.y}px`;
                        }
                      }
                      if (batchShapeEdit) for (const start of dragOrigins.current) syncNamedShapes(draft, slide.id, start.id);
                    });
                  }}
                  onDragEnd={() => {
                    setSnapGuides([]);
                    store.commit();
                  }}
                  onResizeStart={() => {
                    snapPeers.current = peerBoxes(slide.elements, store.selectedElementIds);
                    snapHold.current = [];
                  }}
                  onResize={({ width, height, drag, direction, inputEvent, target: elementTarget }) => {
                    const edges = resizeEdges(direction);
                    const snapped = shiftHeld(inputEvent)
                      ? snapResize(
                        { x: drag.left, y: drag.top, width, height },
                        snapPeers.current,
                        deck.size,
                        snapThreshold(store.zoom),
                        edges,
                        snapHold.current,
                      )
                      : { x: drag.left, y: drag.top, width, height, guides: [] as SnapGuide[] };
                    snapHold.current = snapped.guides;
                    const lockedRatio = lockedElementAspectRatio(dragTarget);
                    const fitted = lockedRatio
                      ? fitLockedAspectBox(snapped, lockedRatio, edges)
                      : snapped;
                    elementTarget.style.width = `${fitted.width}px`;
                    elementTarget.style.height = `${fitted.height}px`;
                    elementTarget.style.left = `${fitted.x}px`;
                    elementTarget.style.top = `${fitted.y}px`;
                    setSnapGuides(snapped.guides);
                    store.preview((draft) => {
                      const element = findElement(draft, slide.id, dragTarget.id);
                      if (!element) return;
                      element.width = fitted.width;
                      element.height = fitted.height;
                      element.x = fitted.x;
                      element.y = fitted.y;
                      if (batchShapeEdit) syncNamedShapes(draft, slide.id, dragTarget.id);
                    });
                  }}
                  onResizeEnd={() => {
                    snapHold.current = [];
                    setSnapGuides([]);
                    store.commit();
                  }}
                  onRotate={({ rotation, target: elementTarget }) => {
                    elementTarget.style.transform = `rotate(${rotation}deg)`;
                    store.preview((draft) => { const element = findElement(draft, slide.id, dragTarget.id); if (element) { element.rotation = rotation; if (batchShapeEdit) syncNamedShapes(draft, slide.id, dragTarget.id); } });
                  }}
                  onRotateEnd={store.commit}
                />
              )}
              {selected && (selected.type === "image" || selected.type === "video") && <MediaControls element={selected} cropping={cropping} zoom={store.zoom} preview={(patch) => store.preview((draft) => Object.assign(findElement(draft, slide.id, selected.id)!, patch))} commit={store.commit} finishCrop={() => setCroppingId(undefined)} />}
              {editingText && <InlineTextEditor ref={inlineTextEditor} element={editingText} selectAll={selectAllOnEdit} preview={(markdown) => { store.preview((draft) => { const element = findElement(draft, slide.id, editingText.id); if (element?.type === "text") element.markdown = markdown; }); store.scheduleCommit(); }} finish={() => { store.commit(); setEditingTextId(undefined); }} />}
              {collaboration.peers.filter((peer) => peer.slideId === slide.id).flatMap((peer) => peer.elementIds.flatMap((id) => {
                const element = slide.elements.find((item) => item.id === id);
                if (!element) return [];
                return [<div key={`${peer.id}-${id}`} className="live-selection" style={{ left: element.x, top: element.y, width: element.width, height: element.height, transform: `rotate(${element.rotation}deg)`, outlineColor: peer.color }}><span style={{ background: peer.color }}>{peer.name}</span></div>];
              }))}
              {ghostPoses(collaboration.peers, slide.id).map(({ peer, pose }) => <div key={`${peer.id}-ghost-${pose.id}`} className="live-ghost" style={{ left: pose.x, top: pose.y, width: pose.width, height: pose.height, transform: `rotate(${pose.rotation}deg)`, outlineColor: peer.color }} />)}
              {editingText && textLockHolder(collaboration.peers, collaboration.self?.id, editingText.id) && <div className="live-lock">{textLockHolder(collaboration.peers, collaboration.self?.id, editingText.id)?.name} is editing this text</div>}
            </div>
            {snapGuides.length > 0 && (
              <div className="snap-overlay" aria-hidden="true">
                {snapGuides.map((guide, index) => (
                  <div
                    key={`${guide.axis}-${guide.position}-${index}`}
                    className={`snap-guide snap-guide-${guide.axis}`}
                    style={guide.axis === "x" ? { left: guide.position * store.zoom } : { top: guide.position * store.zoom }}
                  />
                ))}
              </div>
            )}
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
      </main>
      <Inspector collapsed={inspectorCollapsed} onToggleCollapse={() => setInspectorCollapsed((value) => !value)} tab={tab} setTab={setTab} deck={deck} slide={slide} element={selected} cropping={cropping} batchShapeEdit={batchShapeEdit} setBatchShapeEdit={setBatchShapeEdit} assetUrl={assetUrl} mutate={store.mutate} preview={store.preview} scheduleCommit={store.scheduleCommit} commit={store.commit} selectElement={store.selectElement} editText={(id) => { store.commit(); setEditingTextId(undefined); setAdvancedTextId(id); }} editImage={(id) => setCroppingId((current) => current === id ? undefined : id)} relinkMedia={(kind, id) => requestMedia(kind, undefined, id)} chooseBackgroundImage={requestBackgroundImage} />
      {advancedTextId && <TextEditor deck={deck} slideId={slide.id} elementId={advancedTextId} preview={store.preview} scheduleCommit={store.scheduleCommit} commit={store.commit} close={() => setAdvancedTextId(undefined)} />}
      {store.mergeState && <MergeConflictDialog conflict={store.mergeState.conflicts[0]} resolve={store.resolveMergeConflict} useLatest={store.useLatestDeck} />}
      <ToastStack />
      <div id="hidden-export-container" aria-hidden="true" style={{ position: "fixed", left: -10000, top: 0, zIndex: -1, pointerEvents: "none" }}>
        {deck.slides.map((s) => (
          <div key={s.id} id={`export-slide-${s.id}`} style={{ width: deck.size.width, height: deck.size.height, overflow: "hidden", position: "relative", flexShrink: 0 }}>
            <SlideView deck={deck} slide={s} resolveAsset={assetUrl} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Toolbar({ slide, element, selectedElements, addText, addShape, addTable, chooseImage, chooseVideo, addManim, setManimQuality, renderAllManim, setupManim, hasLinkedMedia, historyBusy, canUndo, canRedo, mutate, preview, scheduleCommit, commit, editAdvanced, formatText, align, distribute, duplicateElement, deleteSelected, manimLocked, sharing }: {
  slide: Slide;
  element?: SlideElement;
  selectedElements: SlideElement[];
  addText(): void;
  addShape(shape: "rectangle" | "ellipse" | "triangle"): void;
  addTable(): void;
  chooseImage(): void;
  chooseVideo(): void;
  addManim(output: "image" | "video"): void;
  setManimQuality(quality: ManimQuality): void;
  renderAllManim(): void;
  setupManim(): void;
  hasLinkedMedia: boolean;
  historyBusy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  mutate(fn: (deck: Deck) => void): void;
  preview(fn: (deck: Deck) => void): void;
  scheduleCommit(): void;
  commit(): void;
  editAdvanced(id: string): void;
  formatText(command: TextFormatCommand): void;
  align(action: AlignAction, relativeTo: AlignRelativeTo): void;
  distribute(action: DistributeAction): void;
  duplicateElement(): void;
  deleteSelected(): void;
  manimLocked: boolean;
  sharing: boolean;
}) {
  const runCommand = useDeckStore((state) => state.runCommand);
  const zoom = useDeckStore((state) => state.zoom);
  const setZoom = useDeckStore((state) => state.setZoom);
  const zoomPercent = Math.round(zoom * 100);
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
  const exportDeck = async (command: "exportPdf" | "exportPng" | "exportPptx" | "exportWeb", label: string, slideIds?: string[]) => {
    if (command === "exportPptx" || command === "exportWeb") {
      const requestId = crypto.randomUUID();
      notifyToast({ id: requestId, kind: "progress", message: `Exporting ${label}…` });
      postMessage({ type: "command", command, requestId, slideIds });
      return;
    }
    const requestId = crypto.randomUUID();
    notifyToast({ id: requestId, kind: "progress", message: `Exporting ${label}…` });
    try {
      if (command === "exportPng") {
        const deck = useDeckStore.getState().deck;
        if (!deck) throw new Error("No deck");
        const node = document.getElementById(`export-slide-${slide.id}`);
        if (!node) throw new Error("Slide not found in DOM. Try re-opening the editor.");
        const restoreVideos = await inlineVideos(node);
        const restoreImages = await inlineImages(node);
        try {
          const dataUrl = await captureSlidePng(node, deck.size.width, deck.size.height);
          postMessage({ type: "saveExport", format: "png", data: dataUrl });
        } finally { restoreImages(); restoreVideos(); }
      } else if (command === "exportPdf") {
        const deck = useDeckStore.getState().deck;
        if (!deck) throw new Error("No deck");
        const visibleSlides = deck.slides.filter(s => !s.hidden);
        if (visibleSlides.length === 0) throw new Error("No visible slides to export");
        const wPt = deck.size.width * 0.75;
        const hPt = deck.size.height * 0.75;
        const orientation = deck.size.width >= deck.size.height ? "landscape" : "portrait";
        const pdf = new jsPDF({ orientation, unit: "pt", format: [wPt, hPt], compress: true });
        for (const [i, s] of visibleSlides.entries()) {
          const node = document.getElementById(`export-slide-${s.id}`);
          if (!node) throw new Error(`DOM node not found for slide ${i + 1}. Try re-opening the editor.`);
          const restoreVideos = await inlineVideos(node);
          const restoreImages = await inlineImages(node);
          try {
            const dataUrl = await captureSlidePng(node, deck.size.width, deck.size.height);
            if (i > 0) pdf.addPage([wPt, hPt], orientation);
            pdf.addImage(dataUrl, "PNG", 0, 0, wPt, hPt, undefined, "FAST");
          } finally { restoreImages(); restoreVideos(); }
        }
        const bytes = pdf.output("arraybuffer");
        const u8 = new Uint8Array(bytes);
        let b64 = "";
        for (let i = 0; i < u8.length; i += 0x8000) b64 += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        postMessage({ type: "saveExport", format: "pdf", data: `data:application/pdf;base64,${btoa(b64)}` });
      }
      notifyToast({ id: requestId, kind: "success", message: `Exported ${label}` });
    } catch (error) {
      let detail = "Unknown export error";
      try { detail = describeExportError(error); } catch { detail = String(error); }
      try { postMessage({ type: "log", level: "error", message: `Export ${label} failed:\n${detail}` }); } catch { /* Host logging is best-effort. */ }
      notifyToast({ id: requestId, kind: "error", message: `Failed to export ${label}: ${detail.split("\n")[0]}` });
    }
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
        <RibbonButton icon="discard" label="Undo" disabled={historyBusy || !canUndo} onClick={() => runCommand("undo")} />
        <RibbonButton icon="redo" label="Redo" disabled={historyBusy || !canRedo} onClick={() => runCommand("redo")} />
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
        <RibbonMenu icon="run-all" label="Manim" items={[
          { icon: "file-media", label: "Still image", onClick: () => addManim("image") },
          { icon: "device-camera-video", label: "Video", onClick: () => addManim("video") },
          { icon: "run-all", label: "Render all", onClick: renderAllManim },
          { icon: "settings-gear", label: "Set up Manim…", onClick: setupManim },
          { icon: "symbol-number", label: "Quality: Low", onClick: () => setManimQuality("low") },
          { icon: "symbol-number", label: "Quality: Medium", onClick: () => setManimQuality("medium") },
          { icon: "symbol-number", label: "Quality: High", onClick: () => setManimQuality("high") },
          { icon: "symbol-number", label: "Quality: Production", onClick: () => setManimQuality("production") }
        ].map((item) => manimLocked ? { ...item, onClick: () => showError("Manim runs on the host during live collaboration.") } : item)} />
      </div></div>
      <div className="ribbon-group"><span className="ribbon-label">Slide show</span><div className="ribbon-actions">
        <RibbonButton icon="play" label="Present" primary onClick={() => postMessage({ type: "command", command: "present" })} />
        <RibbonButton icon="multiple-windows" label="Presenter" onClick={() => postMessage({ type: "command", command: "presenter" })} />
        <RibbonButton icon="broadcast" label={sharing ? "Copy invite" : "Share"} onClick={() => postMessage({ type: "command", command: sharing ? "copyLiveInvite" : "startLive" })} />
      </div></div>
    </div>
    <div className="context-toolbar" aria-label="Selection formatting">
      <div className="context-toolbar-main">
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
      </> : <span className="context-hint">{selectedElements.length > 1 ? `${selectedElements.length} items selected` : element ? `${elementLabel(element)} selected` : "Select an element to format it"}</span>}
      {selectedElements.length > 0 && <AlignControls count={selectedElements.length} unlocked={selectedElements.filter((item) => !item.locked).length} align={align} distribute={distribute} />}
      {element && <div className="context-arrange">
        <ContextIcon icon="copy" label="Duplicate" onClick={duplicateElement} />
        <ContextIcon icon="arrow-up" label="Bring forward" onClick={() => updateElement((target) => { target.z += 1; })} />
        <ContextIcon icon="arrow-down" label="Send backward" onClick={() => updateElement((target) => { target.z -= 1; })} />
        <ContextIcon icon={element.locked ? "lock" : "unlock"} label={element.locked ? "Unlock" : "Lock"} pressed={element.locked} onClick={() => updateElement((target) => { target.locked = !target.locked; })} />
        <ContextIcon icon="trash" label="Delete" danger onClick={deleteSelected} />
      </div>}
      </div>
      <div className="zoom-control" aria-label="Canvas zoom" title={`Canvas zoom ${zoomPercent}% · Ctrl/Cmd + mouse wheel also zooms`}>
        <IconButton icon="zoom-out" label={`Zoom out from ${zoomPercent}%`} onClick={() => setZoom(zoom - 0.1)} />
        <span className="zoom-value">{zoomPercent}%</span>
        <IconButton icon="zoom-in" label={`Zoom in from ${zoomPercent}%`} onClick={() => setZoom(zoom + 0.1)} />
      </div>
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

function AlignControls({ count, unlocked, align, distribute }: { count: number; unlocked: number; align(action: AlignAction, relativeTo: AlignRelativeTo): void; distribute(action: DistributeAction): void }) {
  const [relativeTo, setRelativeTo] = useState<AlignRelativeTo>("page");
  const relative = count > 1 ? relativeTo : "page";
  const canAlign = unlocked > 0;
  const canDistribute = unlocked >= 3;
  return <div className="align-controls">
    <label className="align-relative" title="Align relative to the slide or the selected items">
      <span>Align</span>
      <select aria-label="Align relative to" value={relative} disabled={count < 2} onChange={(event) => setRelativeTo(event.target.value as AlignRelativeTo)}>
        <option value="page">Page</option>
        <option value="selection">Selection</option>
      </select>
    </label>
    <div className="segmented-control" role="group" aria-label="Horizontal object alignment">
      <ContextIcon icon="layout-sidebar-left" label={`Align left edges to ${relative}`} disabled={!canAlign} onClick={() => align("left", relative)} />
      <ContextIcon icon="layout-centered" label={`Center horizontally on ${relative}`} disabled={!canAlign} onClick={() => align("center", relative)} />
      <ContextIcon icon="layout-sidebar-right" label={`Align right edges to ${relative}`} disabled={!canAlign} onClick={() => align("right", relative)} />
    </div>
    <div className="segmented-control" role="group" aria-label="Vertical object alignment">
      <ContextIcon icon="fold-up" label={`Align top edges to ${relative}`} disabled={!canAlign} onClick={() => align("top", relative)} />
      <ContextIcon icon="layout-panel" label={`Center vertically on ${relative}`} disabled={!canAlign} onClick={() => align("middle", relative)} />
      <ContextIcon icon="fold-down" label={`Align bottom edges to ${relative}`} disabled={!canAlign} onClick={() => align("bottom", relative)} />
    </div>
    <ContextIcon icon="target" label="Center on page" disabled={!canAlign} onClick={() => align("center-page", "page")} />
    <div className="segmented-control" role="group" aria-label="Distribute">
      <ContextIcon icon="split-horizontal" label="Distribute horizontal centers" disabled={!canDistribute} onClick={() => distribute("horizontal-centers")} />
      <ContextIcon icon="layout-panel-justify" label="Equal horizontal gaps" disabled={!canDistribute} onClick={() => distribute("horizontal-gaps")} />
      <ContextIcon icon="split-vertical" label="Distribute vertical centers" disabled={!canDistribute} onClick={() => distribute("vertical-centers")} />
      <ContextIcon icon="three-bars" label="Equal vertical gaps" disabled={!canDistribute} onClick={() => distribute("vertical-gaps")} />
    </div>
  </div>;
}

function SlideRail({ collapsed, onToggleCollapse, deck, selectedId, peerColors, select, mutate, resolveAsset }: { collapsed: boolean; onToggleCollapse(): void; deck: Deck; selectedId: string; peerColors: Map<string, string[]>; select(id: string): void; mutate(fn: (deck: Deck) => void): void; resolveAsset(source: string, storage: MediaStorage): string }) {
  const [transitionSlideId, setTransitionSlideId] = useState<string>();
  const [drag, setDrag] = useState<{ id: string; from: number; dy: number; to: number }>();
  const listRef = useRef<HTMLDivElement>(null);
  const dragGesture = useRef<{ id: string; from: number; startY: number; pointerId: number; active: boolean } | undefined>(undefined);
  const suppressClick = useRef(false);
  const addSlide = (index?: number) => {
    const id = crypto.randomUUID();
    mutate((draft) => {
      const slide = { id, title: `Slide ${draft.slides.length + 1}`, notes: "", hidden: false, hidePageNumber: false, transition: { type: "none" as const, durationMs: 500, easing: "ease-in-out" }, timeline: [], elements: [] };
      if (index === undefined) draft.slides.push(slide);
      else draft.slides.splice(index, 0, slide);
    });
    select(id);
  };
  const marker = drag ? (drag.to > drag.from ? drag.to + 1 : drag.to) : undefined;
  const entryMidpoints = (dy: number) => [...(listRef.current?.querySelectorAll<HTMLElement>(".rail-entry") ?? [])].map((entry) => {
    const rect = entry.getBoundingClientRect();
    const shift = entry.classList.contains("dragging") ? dy : 0;
    return rect.top - shift + rect.height / 2;
  });
  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, index: number, id: string) => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    dragGesture.current = { id, from: index, startY: event.clientY, pointerId: event.pointerId, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = dragGesture.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dy = event.clientY - gesture.startY;
    if (!gesture.active && Math.abs(dy) < 6) return;
    if (!gesture.active) select(gesture.id);
    gesture.active = true;
    const list = listRef.current;
    if (list) {
      const bounds = list.getBoundingClientRect();
      if (event.clientY < bounds.top + 28) list.scrollTop -= 14;
      else if (event.clientY > bounds.bottom - 28) list.scrollTop += 14;
    }
    setDrag({ id: gesture.id, from: gesture.from, dy, to: railDropIndex(entryMidpoints(dy), event.clientY, gesture.from) });
  };
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = dragGesture.current;
    dragGesture.current = undefined;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!gesture.active) {
      setDrag(undefined);
      return;
    }
    suppressClick.current = true;
    const to = railDropIndex(entryMidpoints(event.clientY - gesture.startY), event.clientY, gesture.from);
    setDrag(undefined);
    if (to === gesture.from) return;
    mutate((draft) => {
      const from = draft.slides.findIndex((item) => item.id === gesture.id);
      if (from < 0 || from === to) return;
      const [item] = draft.slides.splice(from, 1);
      if (item) draft.slides.splice(to, 0, item);
    });
  };
  return <aside className={`slide-rail${collapsed ? " collapsed" : ""}`}>
    <div className="rail-header">
      <strong>Slides</strong>
      <button type="button" className="icon-button panel-toggle" title={collapsed ? "Show slides" : "Collapse slides"} aria-label={collapsed ? "Show slides" : "Collapse slides"} aria-expanded={!collapsed} onClick={onToggleCollapse}>
        <span className={`codicon codicon-chevron-${collapsed ? "right" : "left"}`} />
      </button>
    </div>
    <div className="rail-scroll" ref={listRef}>
      {deck.slides.map((slide, index) => <div key={slide.id} className={`rail-entry${drag?.id === slide.id ? " dragging" : ""}${marker === index ? " drop-before" : ""}${marker === deck.slides.length && index === deck.slides.length - 1 ? " drop-after" : ""}`} style={drag?.id === slide.id ? { transform: `translateY(${drag.dy}px)` } : undefined}>
        {index > 0 && <div className="transition-row"><button type="button" className="insert-slide" title="Insert blank slide here" aria-label="Insert blank slide here" onClick={() => addSlide(index)}><span className="codicon codicon-add" /></button><button className={`transition-gap ${transitionSlideId === slide.id ? "active" : ""} ${slide.transition.type !== "none" ? "has-transition" : ""}`} title="Edit incoming transition" onClick={() => setTransitionSlideId((current) => current === slide.id ? undefined : slide.id)}><span className="codicon codicon-arrow-swap" /> <span>{slide.transition.type === "none" ? "Add transition" : transitionLabel(slide.transition.type)}</span></button></div>}
        {index > 0 && transitionSlideId === slide.id && <TransitionEditor transition={slide.transition} update={(patch) => mutate((draft) => Object.assign(draft.slides[index]!.transition, patch))} applyAll={() => mutate((draft) => { const transition = { ...draft.slides[index]!.transition }; for (const item of draft.slides) item.transition = { ...transition }; })} close={() => setTransitionSlideId(undefined)} />}
        <button className={`thumbnail ${selectedId === slide.id ? "active" : ""}`} title="Drag up or down to reorder" onPointerDown={(event) => beginDrag(event, index, slide.id)} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => { dragGesture.current = undefined; setDrag(undefined); }} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } select(slide.id); }}>
          <span className="slide-index">{index + 1}</span>
          <div className="thumb-clip" style={{ width: 192, height: 108 }}><SlideView deck={deck} slide={slide} scale={0.1} resolveAsset={resolveAsset} /></div>
          <span className="slide-title">{slide.title}{slide.hidden ? " (hidden)" : ""}</span>
          {(peerColors.get(slide.id) ?? []).length > 0 && <span className="live-dots">{(peerColors.get(slide.id) ?? []).map((color, dot) => <i key={`${color}-${dot}`} style={{ background: color }} />)}</span>}
        </button>
        <div className="rail-actions">
          <IconButton icon="copy" label="Duplicate" onClick={() => mutate((draft) => draft.slides.splice(index + 1, 0, duplicateSlide(draft.slides[index]!)))} />
          <IconButton icon={slide.hidden ? "eye-closed" : "eye"} label={slide.hidden ? "Show slide" : "Hide slide"} pressed={slide.hidden} onClick={() => mutate((draft) => { draft.slides[index]!.hidden = !draft.slides[index]!.hidden; })} />
          <IconButton icon="trash" label="Delete" disabled={deck.slides.length === 1} onClick={() => mutate((draft) => draft.slides.splice(index, 1))} />
        </div>
      </div>)}
      <button className="add-slide-tile" onClick={() => addSlide()}><span className="codicon codicon-add" /><span>Add slide</span></button>
    </div>
  </aside>;
}

function TransitionEditor({ transition, update, applyAll, close }: { transition: Transition; update(patch: Partial<Transition>): void; applyAll(): void; close(): void }) {
  return <div className="transition-editor" onClick={(event) => event.stopPropagation()}>
    <header><strong>Incoming transition</strong><button className="icon-button" aria-label="Close transition editor" onClick={close}><span className="codicon codicon-close" /></button></header>
    <TransitionControls transition={transition} update={update} applyAll={applyAll} />
  </div>;
}

function TransitionControls({ transition, update, applyAll }: { transition: Transition; update(patch: Partial<Transition>): void; applyAll?: () => void }) {
  return <div className="transition-controls">
    <div className="transition-options">{transitionTypes.map((type) => <button key={type} className={transition.type === type ? "active" : ""} title={transitionLabel(type)} onClick={() => update({ type })}><span className={`codicon codicon-${transitionIcon(type)}`} /><span>{transitionLabel(type)}</span></button>)}</div>
    <label>Duration <span>{transition.durationMs} ms</span><input type="range" min="0" max="3000" step="100" value={transition.durationMs} onChange={(event) => update({ durationMs: Number(event.target.value) })} /></label>
    {applyAll && <button type="button" className="apply-transition" onClick={applyAll}>Apply to all slides</button>}
  </div>;
}

type MediaElement = Extract<SlideElement, { type: "image" | "video" }>;

function MediaControls({ element, cropping, zoom, preview, commit, finishCrop }: { element: MediaElement; cropping: boolean; zoom: number; preview(patch: Partial<MediaElement>): void; commit(): void; finishCrop(): void }) {
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
  const shapeDrag = (edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (element.type !== "image") return;
    const initial: CropBox = { x: element.x, y: element.y, width: element.width, height: element.height, crop: { ...element.crop } };
    startPointerDrag(event, (deltaX, deltaY) => {
      const local = localPointerDelta(deltaX, deltaY, element.rotation, zoom);
      const next = cropBoxByEdges(initial, {
        left: edges.left ? local.x : 0,
        right: edges.right ? -local.x : 0,
        top: edges.top ? local.y : 0,
        bottom: edges.bottom ? -local.y : 0
      });
      preview({ ...next, aspectRatio: next.width / Math.max(1, next.height) });
    }, commit);
  };
  const panImage = element.type === "image" ? (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const initial = { ...element.crop };
    startPointerDrag(event, (deltaX, deltaY) => {
      const local = localPointerDelta(deltaX, deltaY, element.rotation, zoom);
      preview({ crop: panCrop(initial, local.x, local.y, element.width, element.height) });
    }, commit);
  } : undefined;

  return <div className={`media-controls ${cropping ? "crop-active" : ""}`} style={overlayStyle}>
    {cropping && element.type === "image" && <div className="crop-surface" title="Drag the picture to reposition it, or drag an edge to crop." onPointerDown={panImage}>
      <button className="crop-done" style={{ fontSize: 12 / zoom, top: 8 / zoom, right: 8 / zoom, padding: `${4 / zoom}px ${8 / zoom}px` }} onPointerDown={(event) => event.stopPropagation()} onClick={finishCrop}>Done</button>
      <button className="crop-edge left" aria-label="Crop left edge" style={{ width: 10 / zoom, height: 28 / zoom }} onPointerDown={shapeDrag({ left: true })} />
      <button className="crop-edge right" aria-label="Crop right edge" style={{ width: 10 / zoom, height: 28 / zoom }} onPointerDown={shapeDrag({ right: true })} />
      <button className="crop-edge top" aria-label="Crop top edge" style={{ width: 28 / zoom, height: 10 / zoom }} onPointerDown={shapeDrag({ top: true })} />
      <button className="crop-edge bottom" aria-label="Crop bottom edge" style={{ width: 28 / zoom, height: 10 / zoom }} onPointerDown={shapeDrag({ bottom: true })} />
      <button className="crop-edge corner nw" aria-label="Crop top-left corner" style={{ width: 12 / zoom, height: 12 / zoom }} onPointerDown={shapeDrag({ left: true, top: true })} />
      <button className="crop-edge corner ne" aria-label="Crop top-right corner" style={{ width: 12 / zoom, height: 12 / zoom }} onPointerDown={shapeDrag({ right: true, top: true })} />
      <button className="crop-edge corner sw" aria-label="Crop bottom-left corner" style={{ width: 12 / zoom, height: 12 / zoom }} onPointerDown={shapeDrag({ left: true, bottom: true })} />
      <button className="crop-edge corner se" aria-label="Crop bottom-right corner" style={{ width: 12 / zoom, height: 12 / zoom }} onPointerDown={shapeDrag({ right: true, bottom: true })} />
    </div>}
    {!cropping && <>
      <button className="media-handle radius-handle" title="Drag to change corner radius" aria-label="Adjust corner radius" style={{ left: `${(radius / Math.max(1, element.width)) * 100}%`, width: handleSize, height: handleSize }} onPointerDown={radiusDrag} />
      {element.type === "image" && <button className="media-handle fade-handle" title="Drag inward to fade all edges" aria-label="Adjust edge fade" style={{ bottom: `${(element.edgeFade / Math.max(1, element.height)) * 100}%`, width: handleSize, height: handleSize }} onPointerDown={fadeDrag} />}
    </>}
  </div>;
}

function ManimInspector({ slideId, slideSize, element, mutate, preview, scheduleCommit, commit }: {
  slideId: string;
  slideSize: Deck["size"];
  element: Extract<SlideElement, { type: "manim" }>;
  mutate(fn: (deck: Deck) => void): void;
  preview(fn: (deck: Deck) => void): void;
  scheduleCommit(): void;
  commit(): void;
}) {
  const [scenes, setScenes] = useState<string[]>([]);
  const [contentFingerprint, setContentFingerprint] = useState<string>();
  const [rendering, setRendering] = useState(false);
  const [renderPercent, setRenderPercent] = useState<number | null>(null);
  useEffect(() => {
    const stopProgress = onManimProgress((detail) => {
      if (detail.elementId !== element.id) return;
      if (detail.status !== "progress") {
        setRendering(false);
        setRenderPercent(null);
        return;
      }
      setRendering(true);
      setRenderPercent(detail.percent);
    });
    const stopClear = onManimProgressClear(() => {
      setRendering(false);
      setRenderPercent(null);
    });
    return () => { stopProgress(); stopClear(); };
  }, [element.id]);
  const renderedFingerprint = manimRenderedFingerprints.get(element.id);
  const stale = Boolean(
    element.outputMedia
    && renderedFingerprint
    && contentFingerprint
    && renderedFingerprint !== manimRenderFingerprint(manimSettingsFingerprint(element), contentFingerprint)
  );
  const status = rendering
    ? "Rendering…"
    : !element.outputMedia
      ? "Not rendered yet"
      : stale
        ? "Render is out of date"
        : "Rendered";

  useEffect(() => {
    if (!element.script) {
      setScenes([]);
      setContentFingerprint(undefined);
      return;
    }
    const requestId = crypto.randomUUID();
    pendingManimScenes.set(requestId, (message) => {
      if (message.error) return void showError(message.error);
      setScenes(message.scenes ?? []);
      if (message.contentFingerprint) setContentFingerprint(message.contentFingerprint);
    });
    postMessage({ type: "listManimScenes", requestId, script: element.script });
    return () => { pendingManimScenes.delete(requestId); };
  }, [element.id, element.script]);

  const chooseScript = () => {
    const requestId = crypto.randomUUID();
    pendingManimScripts.set(requestId, (message) => {
      if (message.error) return void showError(message.error);
      if (!message.script) return;
      mutate((draft) => {
        const target = findElement(draft, slideId, element.id);
        if (target?.type !== "manim") return;
        target.script = message.script;
        if (!target.scene && message.scenes?.length === 1) target.scene = message.scenes[0];
      });
    });
    postMessage({ type: "selectManimScript", requestId, elementId: element.id });
  };

  const createScript = () => {
    const requestId = crypto.randomUUID();
    pendingManimCreates.set(requestId, (message) => {
      if (message.error) showError(message.error);
    });
    postMessage({ type: "createManimScript", requestId, elementId: element.id });
  };

  const renderScene = () => {
    const requestId = crypto.randomUUID();
    setRendering(true);
    pendingManimRenders.set(requestId, (message) => {
      setRendering(false);
      setRenderPercent(null);
      if (message.error && message.error !== "Manim render cancelled.") return void showError(message.error);
      if (message.ok && message.settingsFingerprint) manimRenderedFingerprints.set(element.id, message.settingsFingerprint);
    });
    postMessage({ type: "renderManim", requestId, elementId: element.id });
  };

  const updateManim = (fn: (target: Extract<SlideElement, { type: "manim" }>) => void, live = true) => {
    const apply = (draft: Deck) => {
      const target = findElement(draft, slideId, element.id);
      if (target?.type !== "manim") return;
      fn(target);
    };
    if (live) { preview(apply); scheduleCommit(); }
    else mutate(apply);
  };

  const canRender = Boolean(element.script?.trim() && element.scene?.trim());

  return <>
    <h4 className="property-heading">Manim</h4>
    <div className="media-source-card">
      <code title={element.script ?? ""}>{element.script ?? "No script selected"}</code>
      <div>
        <button type="button" onClick={chooseScript}>Choose…</button>
        <button type="button" onClick={createScript}>Create script…</button>
        {element.script && <button type="button" onClick={() => postMessage({ type: "openManimScript", script: element.script! })}>Open</button>}
      </div>
    </div>
    <label>Scene
      {scenes.length > 1
        ? <select value={element.scene ?? ""} onChange={(event) => updateManim((target) => { target.scene = event.target.value; }, false)}>
          <option value="">Select a scene…</option>
          {scenes.map((scene) => <option key={scene} value={scene}>{scene}</option>)}
        </select>
        : <input autoComplete="off" value={element.scene ?? ""} placeholder="SceneClass" onChange={(event) => updateManim((target) => { target.scene = event.target.value; })} onBlur={commit} />}
    </label>
    <label>Output<select value={element.output} onChange={(event) => updateManim((target) => { target.output = event.target.value as "image" | "video"; }, false)}>
      <option value="image">Still image</option>
      <option value="video">Video</option>
    </select></label>
    <label>Orientation<select value={element.orientation} onChange={(event) => {
      const orientation = event.target.value as ManimOrientation;
      updateManim((target) => {
        target.orientation = orientation;
        if (!target.lockAspectRatio) return;
        const aspectRatio = manimElementAspectRatio(orientation);
        target.aspectRatio = aspectRatio;
        const fitted = fitAspectBoxInSlide(target, aspectRatio, slideSize);
        target.x = fitted.x;
        target.y = fitted.y;
        target.width = fitted.width;
        target.height = fitted.height;
      }, false);
    }}>
      <option value="horizontal">Horizontal (16:9)</option>
      <option value="vertical">Vertical (9:16)</option>
    </select></label>
    <label>Quality<select value={element.quality} onChange={(event) => updateManim((target) => { target.quality = event.target.value as typeof element.quality; }, false)}>
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high">High</option>
      <option value="production">Production</option>
    </select></label>
    <CheckboxField label="Transparent background" checked={element.transparent} onChange={(transparent) => updateManim((target) => { target.transparent = transparent; }, false)} />
    {element.output === "video" && <>
      <label>Playback<select value={element.playback.mode} onChange={(event) => updateManim((target) => { target.playback.mode = event.target.value as "manual" | "autoplay"; }, false)}><option value="manual">Manual</option><option value="autoplay">Autoplay</option></select></label>
      <CheckboxField label="Muted" checked={element.playback.muted} onChange={(muted) => updateManim((target) => { target.playback.muted = muted; }, false)} />
      <CheckboxField label="Loop" checked={element.playback.loop} onChange={(loop) => updateManim((target) => { target.playback.loop = loop; }, false)} />
      <CheckboxField label="Controls" checked={element.playback.controls} onChange={(controls) => updateManim((target) => { target.playback.controls = controls; }, false)} />
    </>}
    {element.outputMedia && <div className="media-source-card"><span className="storage-badge embedded">embedded</span><code title={element.outputMedia.src}>{element.outputMedia.src}</code></div>}
    <p className="panel-help manim-status">{status}</p>
    <button className="edit-text-button" type="button" disabled={!canRender || rendering} onClick={renderScene}>{rendering ? "Rendering…" : "Render"}</button>
    {renderPercent !== null && <progress className="manim-progress" max={100} value={renderPercent} aria-label={`Manim render ${renderPercent}%`} />}
    <CheckboxField label="Keep original aspect ratio" checked={element.lockAspectRatio} onChange={(locked) => {
      if (!locked) return updateManim((target) => { target.lockAspectRatio = false; }, false);
      updateManim((target) => {
        target.lockAspectRatio = true;
        target.aspectRatio = manimElementAspectRatio(target.orientation);
      }, false);
    }} />
  </>;
}

function Inspector({ collapsed, onToggleCollapse, tab, setTab, deck, slide, element, cropping, batchShapeEdit, setBatchShapeEdit, assetUrl, mutate, preview, scheduleCommit, commit, selectElement, editText, editImage, relinkMedia, chooseBackgroundImage }: {
  collapsed: boolean; onToggleCollapse(): void; tab: Tab; setTab(tab: Tab): void; deck: Deck; slide: Slide; element?: SlideElement; cropping: boolean; batchShapeEdit: boolean; setBatchShapeEdit(enabled: boolean): void; assetUrl(reference: string, storage: MediaStorage): string; mutate(fn: (deck: Deck) => void): void; preview(fn: (deck: Deck) => void): void; scheduleCommit(): void; commit(): void; selectElement(id?: string, additive?: boolean): void; editText(id: string): void; editImage(id: string): void; relinkMedia(kind: "image" | "video", id: string): void; chooseBackgroundImage(): void;
}) {
  const selectedIds = useDeckStore((state) => state.selectedElementIds);
  const update = (patch: Partial<SlideElement>) => element && mutate((draft) => Object.assign(findElement(draft, slide.id, element.id)!, patch));
  const updateContinuous = (patch: Partial<SlideElement>) => {
    if (!element) return;
    preview((draft) => {
      Object.assign(findElement(draft, slide.id, element.id)!, patch);
      if (batchShapeEdit && element.type === "shape" && !("name" in patch)) syncNamedShapes(draft, slide.id, element.id);
    });
    scheduleCommit();
  };
  const editShape = (fn: (target: Extract<SlideElement, { type: "shape" }>) => void, live = true) => {
    if (!element) return;
    const apply = (draft: Deck) => {
      const target = findElement(draft, slide.id, element.id);
      if (target?.type !== "shape") return;
      fn(target);
      if (batchShapeEdit) syncNamedShapes(draft, slide.id, element.id);
    };
    if (live) { preview(apply); scheduleCommit(); }
    else mutate(apply);
  };
  const continuous = (fn: (draft: Deck) => void) => { preview(fn); scheduleCommit(); };
  return <aside className={`inspector${collapsed ? " collapsed" : ""}`}>
    <div className="inspector-header">
      <button type="button" className="icon-button panel-toggle" title={collapsed ? "Show properties" : "Collapse properties"} aria-label={collapsed ? "Show properties" : "Collapse properties"} aria-expanded={!collapsed} onClick={onToggleCollapse}>
        <span className={`codicon codicon-chevron-${collapsed ? "left" : "right"}`} />
      </button>
      <nav>{(["properties", "layers", "animations"] as const).map((value) => <button className={tab === value ? "active" : ""} onClick={() => setTab(value)} key={value}>{value}</button>)}</nav>
    </div>
    <div className="inspector-body">
      {tab === "properties" && <>
        <h3>{selectedIds.length > 1 ? `${selectedIds.length} items` : element ? element.type : "Slide"}</h3>
        {element ? <>
          <label>Element name<input autoComplete="off" value={element.name ?? ""} placeholder={elementLabel(element)} onChange={(event) => updateContinuous({ name: event.target.value.trimStart() || undefined })} onBlur={commit} /></label>
          <p className="panel-help">The same name on both slides morphs this object. A blank name, or the same name twice on one slide, does not morph.</p>
          <h4 className="property-heading">Geometry</h4>
          <div className="field-grid geometry-grid">
            <NumberField label="X" value={element.x} onChange={(x) => updateContinuous({ x })} onCommit={commit} />
            <NumberField label="Y" value={element.y} onChange={(y) => updateContinuous({ y })} onCommit={commit} />
            <NumberField label="W" value={element.width} min={0} onChange={(width) => updateContinuous(elementSizePatch(element, "width", width))} onCommit={commit} />
            <NumberField label="H" value={element.height} min={0} onChange={(height) => updateContinuous(elementSizePatch(element, "height", height))} onCommit={commit} />
            <NumberField label="Rotate" value={element.rotation} onChange={(rotation) => updateContinuous({ rotation })} onCommit={commit} />
            <NumberField label="Opacity" value={element.opacity} step={0.05} min={0} max={1} onChange={(opacity) => updateContinuous({ opacity })} onCommit={commit} />
          </div>
          <h4 className="property-heading">Appearance</h4>
          {element.type === "text" && <>
            <button className="edit-text-button" onClick={() => editText(element.id)}>Open advanced Markdown · LaTeX · Code editor…</button>
            <ColorField label="Text color" value={element.style.color} onChange={(color) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.color = color; })} onCommit={commit} />
            <NumberField label="Font size" value={element.style.fontSize} onChange={(fontSize) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.fontSize = fontSize; })} onCommit={commit} />
            <NumberField label="Vertical spacing" value={element.style.lineHeight} step={0.1} min={0.5} max={4} onChange={(lineHeight) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.lineHeight = lineHeight; })} onCommit={commit} />
            <FontFamilyPicker value={element.style.fontFamily} onChange={(fontFamily) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.fontFamily = fontFamily; })} />
            <span className="inspector-control-label">Horizontal alignment</span><AlignmentButtons label="Horizontal alignment" value={element.style.textAlign} values={["left", "center", "right"]} onChange={(value) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.textAlign = value as "left" | "center" | "right"; })} />
            <span className="inspector-control-label">Vertical alignment</span><AlignmentButtons label="Vertical alignment" value={element.style.verticalAlign} values={["top", "middle", "bottom"]} onChange={(value) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "text") target.style.verticalAlign = value as "top" | "middle" | "bottom"; })} />
          </>}
          {element.type === "shape" && <>
            <h4 className="property-heading">Batch edit</h4>
            <CheckboxField label="Same name on other slides" checked={batchShapeEdit} onChange={setBatchShapeEdit} />
            <p className="panel-help">{element.name?.trim() ? "Color, size, and position copy to every other slide’s shape with this name." : "Give this shape an element name first. Only shapes with that same name are updated."}</p>
            <ColorField label="Fill" value={element.fill} allowTransparent onChange={(fill) => editShape((target) => { target.fill = fill; })} onCommit={commit} />
            <NumberField label="Border width" value={element.strokeWidth} onChange={(strokeWidth) => editShape((target) => { target.strokeWidth = Math.max(0, strokeWidth); })} onCommit={commit} />
            <ColorField label="Border color" value={element.stroke} allowTransparent onChange={(stroke) => editShape((target) => { target.stroke = stroke; })} onCommit={commit} />
            <CheckboxField label="Shadow" checked={element.shadow.enabled} onChange={(enabled) => editShape((target) => { target.shadow.enabled = enabled; }, false)} />
            {element.shadow.enabled && <>
              <ColorField label="Shadow color" value={element.shadow.color} allowTransparent onChange={(color) => editShape((target) => { target.shadow.color = color; })} onCommit={commit} />
              <div className="field-grid"><NumberField label="Shadow X" value={element.shadow.offsetX} onChange={(offsetX) => editShape((target) => { target.shadow.offsetX = offsetX; })} onCommit={commit} /><NumberField label="Shadow Y" value={element.shadow.offsetY} onChange={(offsetY) => editShape((target) => { target.shadow.offsetY = offsetY; })} onCommit={commit} /></div>
              <RangeField label="Shadow blur" value={element.shadow.blur} min={0} max={160} onChange={(blur) => editShape((target) => { target.shadow.blur = blur; })} onCommit={commit} />
            </>}
          </>}
          {element.type === "manim" && <ManimInspector slideId={slide.id} slideSize={deck.size} element={element} mutate={mutate} preview={preview} scheduleCommit={scheduleCommit} commit={commit} />}
          {element.type === "table" && <>
            <div className="table-size-actions">
              <button onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows + 1, target.columns); })}><span className="codicon codicon-add" /> Row</button>
              <button disabled={element.rows <= 1} onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows - 1, target.columns); })}><span className="codicon codicon-remove" /> Row</button>
              <button onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows, target.columns + 1); })}><span className="codicon codicon-add" /> Column</button>
              <button disabled={element.columns <= 1} onClick={() => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") resizeTable(target, target.rows, target.columns - 1); })}><span className="codicon codicon-remove" /> Column</button>
            </div>
            <CheckboxField label="Header row" checked={element.headerRow} onChange={(headerRow) => mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "table") target.headerRow = headerRow; })} />
            <div className="table-cell-editor" style={{ gridTemplateColumns: `repeat(${element.columns}, minmax(86px, 1fr))` }}>
              {Array.from({ length: element.rows }, (_, row) => Array.from({ length: element.columns }, (_, column) => <textarea className={row === 0 && element.headerRow ? "header-cell" : ""} key={`${row}-${column}`} aria-label={`Row ${row + 1}, column ${column + 1}`} value={element.cells[row]?.[column] ?? ""} onKeyDown={(event) => applyTextTab(event, element.cells[row]?.[column] ?? "", (text) => { preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type !== "table") return; target.cells = normalizedTableCells(target); target.cells[row]![column] = text; }); scheduleCommit(); })} onChange={(event) => { preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type !== "table") return; target.cells = normalizedTableCells(target); target.cells[row]![column] = event.target.value; }); scheduleCommit(); }} onBlur={commit} />))}
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
            <CheckboxField label="Keep original aspect ratio" checked={element.lockAspectRatio} onChange={(locked) => {
              if (!locked) {
                mutate((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image" || target?.type === "video") target.lockAspectRatio = false; });
                return;
              }
              mutate((draft) => {
                const target = findElement(draft, slide.id, element.id);
                if (target?.type !== "image" && target?.type !== "video") return;
                target.lockAspectRatio = true;
                target.aspectRatio = target.width / Math.max(1, target.height);
              });
            }} />
            <p className="panel-help">Locks the current frame ratio. Cropping updates that ratio; normal resize keeps it.</p>
            <RangeField label="Corner radius" value={element.borderRadius} min={0} max={Math.max(1, Math.round(Math.min(element.width, element.height) / 2))} onChange={(borderRadius) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image" || target?.type === "video") target.borderRadius = borderRadius; })} onCommit={commit} />
            <p className="panel-help">Drag the yellow point on the top edge to round corners.</p>
          </>}
          {element.type === "image" && <>
            <RangeField label="Border width" value={element.border.width} min={0} max={40} onChange={(width) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.border.width = width; })} onCommit={commit} />
            <ColorField label="Border color" value={element.border.color} allowTransparent onChange={(color) => continuous((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.border.color = color; })} onCommit={commit} />
            <RangeField label="Edge fade" value={element.edgeFade} min={0} max={Math.max(1, Math.round(Math.min(element.width, element.height) / 2))} onChange={(edgeFade) => preview((draft) => { const target = findElement(draft, slide.id, element.id); if (target?.type === "image") target.edgeFade = edgeFade; })} onCommit={commit} />
            <p className="panel-help">Drag the blue point upward from the bottom edge to fade all four sides.</p>
            <button className={`edit-text-button ${cropping ? "active" : ""}`} onClick={() => editImage(element.id)}>{cropping ? "Done cropping" : "Crop edges"}</button>
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
          <TransitionControls transition={slide.transition} update={(patch) => mutate((draft) => Object.assign(draft.slides.find((item) => item.id === slide.id)!.transition, patch))} applyAll={() => mutate((draft) => { const source = draft.slides.find((item) => item.id === slide.id); if (!source) return; const transition = { ...source.transition }; for (const item of draft.slides) item.transition = { ...transition }; })} />
        </>}
      </>}
      {tab === "layers" && <><h3>Layers</h3><p className="panel-help">Shift-click to add items to the selection for align and distribute.</p>{[...slide.elements].sort((a, b) => b.z - a.z).map((item) => <div className={`layer-row ${selectedIds.includes(item.id) ? "active" : ""}`} key={item.id} onClick={(event) => selectElement(item.id, event.shiftKey)}><span>{item.name ?? `${item.type} ${item.id.slice(0, 4)}`}</span><button title={item.locked ? "Unlock" : "Lock"} aria-label={item.locked ? "Unlock" : "Lock"} onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.locked = !target.locked; }); }}><span className={`codicon codicon-${item.locked ? "lock" : "unlock"}`} /></button><button title={item.hidden ? "Show" : "Hide"} aria-label={item.hidden ? "Show" : "Hide"} onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.hidden = !target.hidden; }); }}><span className={`codicon codicon-${item.hidden ? "eye-closed" : "eye"}`} /></button><button title="Bring forward" aria-label="Bring forward" onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.z += 1; }); }}><span className="codicon codicon-arrow-up" /></button><button title="Send backward" aria-label="Send backward" onClick={(event) => { event.stopPropagation(); mutate((draft) => { const target = findElement(draft, slide.id, item.id); if (target) target.z -= 1; }); }}><span className="codicon codicon-arrow-down" /></button></div>)}</>}
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
  return <div className="modal-backdrop" onMouseDown={finish}><div className="text-editor" onMouseDown={(event) => event.stopPropagation()}><header><strong>Markdown · LaTeX · Code</strong><button onClick={finish}>Done</button></header><textarea autoFocus value={element.markdown} onKeyDown={(event) => { if (applyTextTab(event, element.markdown, (markdown) => { preview((draft) => { const target = findElement(draft, slideId, elementId); if (target?.type === "text") target.markdown = markdown; }); scheduleCommit(); })) return; if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) { event.preventDefault(); finish(); } }} onChange={(event) => { preview((draft) => { const target = findElement(draft, slideId, elementId); if (target?.type === "text") target.markdown = event.target.value; }); scheduleCommit(); }} onBlur={commit} /><section className="text-preview-panel"><strong>Live preview</strong><div className="text-preview" style={{ background, fontFamily: element.style.fontFamily, fontSize: Math.min(element.style.fontSize, 34), fontWeight: element.style.fontWeight, color: element.style.color, textAlign: element.style.textAlign, lineHeight: element.style.lineHeight }} dangerouslySetInnerHTML={{ __html: renderMarkdown(element.markdown) }} /></section><p>Use <code>$x^2$</code>, <code>$$…$$</code>, and fenced code blocks. Press <code>Tab</code> for a tab stop. Press <code>Ctrl/Cmd+Enter</code> or <code>Escape</code> to finish.</p></div></div>;
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
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      const input = event.currentTarget;
      const edit = insertTextTab(element.markdown, { start: input.selectionStart, end: input.selectionEnd }, event.shiftKey);
      preview(edit.text);
      requestAnimationFrame(() => input.setSelectionRange(edit.selection.start, edit.selection.end));
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
    <span className="toast-body">{toast.message}{typeof toast.progress === "number" && <progress className="toast-progress" max={100} value={toast.progress} aria-label={`${toast.progress}%`} />}</span>
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
function lockedElementAspectRatio(element: SlideElement): number | undefined {
  if (element.type !== "image" && element.type !== "video" && element.type !== "manim") return undefined;
  if (!element.lockAspectRatio) return undefined;
  if (element.aspectRatio && element.aspectRatio > 0) return element.aspectRatio;
  if (element.type === "manim") return manimElementAspectRatio(element.orientation);
  return element.width / Math.max(1, element.height);
}
function elementSizePatch(element: SlideElement, driver: "width" | "height", value: number): Partial<SlideElement> {
  const aspectRatio = lockedElementAspectRatio(element);
  if (!aspectRatio) {
    return driver === "width" ? { width: value } : { height: value };
  }
  return driver === "width"
    ? { width: value, height: heightForLockedAspect(value, aspectRatio) }
    : { height: value, width: widthForLockedAspect(value, aspectRatio) };
}
function lockMediaAspect(slideId: string, elementId: string, aspectRatio: number, mutate: (fn: (deck: Deck) => void) => void) {
  if (!(aspectRatio > 0)) return;
  mutate((draft) => {
    const target = findElement(draft, slideId, elementId);
    if (target?.type !== "image" && target?.type !== "video" && target?.type !== "manim") return;
    const fitted = fitAspectBoxInSlide(target, aspectRatio, draft.size);
    target.x = fitted.x;
    target.y = fitted.y;
    target.width = fitted.width;
    target.height = fitted.height;
    target.lockAspectRatio = true;
    target.aspectRatio = aspectRatio;
  });
}
function measureMediaAspect(url: string, kind: "image" | "video"): Promise<number> {
  return new Promise((resolve, reject) => {
    if (kind === "image") {
      const image = new Image();
      image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve(image.naturalWidth / image.naturalHeight) : reject(new Error("missing size"));
      image.onerror = () => reject(new Error("image"));
      image.src = url;
      return;
    }
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => video.videoWidth > 0 && video.videoHeight > 0 ? resolve(video.videoWidth / video.videoHeight) : reject(new Error("missing size"));
    video.onerror = () => reject(new Error("video"));
    video.src = url;
  });
}
function shiftHeld(event: Event | undefined): boolean {
  return Boolean(event && "shiftKey" in event && (event as { shiftKey?: boolean }).shiftKey);
}
function clampOptional(value: number, min?: number, max?: number): number { return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, value)); }
function roundStep(value: number, step: number): number { const precision = Math.max(0, (String(step).split(".")[1] ?? "").length); return Number(value.toFixed(Math.min(8, precision))); }
function normalizedTableCells(table: Extract<SlideElement, { type: "table" }>): string[][] { return Array.from({ length: table.rows }, (_, row) => Array.from({ length: table.columns }, (_, column) => table.cells[row]?.[column] ?? "")); }
function resizeTable(table: Extract<SlideElement, { type: "table" }>, rows: number, columns: number): void { table.rows = clamp(Math.round(rows), 1, 50); table.columns = clamp(Math.round(columns), 1, 20); table.cells = normalizedTableCells(table); }
function isTextEntryTarget(target: EventTarget | null): boolean { return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)); }
function deleteElements(slideId: string, elementIds: string[], mutate: (fn: (deck: Deck) => void) => void, select: (id?: string) => void) {
  if (!elementIds.length) return;
  const ids = new Set(elementIds);
  mutate((draft) => {
    const target = draft.slides.find((item) => item.id === slideId)!;
    target.elements = target.elements.filter((item) => !ids.has(item.id));
    target.timeline = target.timeline.filter((step) => !ids.has(step.targetElementId));
  });
  select();
}
function handleHostMessage(message: HostToWebviewMessage, setDeck: (deck: Deck, revision: string, uri: string, linkedUri: string, history?: { canUndo?: boolean; canRedo?: boolean }) => void, setInvalid: (message: string, gitConflict: boolean, uri: string, linkedUri: string) => void, handleEditResult: (message: Extract<HostToWebviewMessage, { type: "documentEditResult" }>) => void, handleHistoryResult: (message: Extract<HostToWebviewMessage, { type: "historyResult" }>) => void) {
  if (message.type === "deck") setDeck(message.deck, message.revision, message.uri, message.linkedUri, { canUndo: message.canUndo, canRedo: message.canRedo });
  else if (message.type === "invalidDeck") setInvalid(message.message, message.gitConflict, message.uri, message.linkedUri);
  else if (message.type === "documentEditResult") handleEditResult(message);
  else if (message.type === "historyResult") handleHistoryResult(message);
  else if (message.type === "assetImported") {
    pendingAssets.get(message.requestId)?.(message.reference && message.storage ? { reference: message.reference, storage: message.storage } : undefined, message.error);
    pendingAssets.delete(message.requestId);
  } else if (message.type === "fontSelected") pendingFonts.get(message.requestId)?.(message.family, message.error);
  else if (message.type === "manimScriptSelected") { pendingManimScripts.get(message.requestId)?.(message); pendingManimScripts.delete(message.requestId); }
  else if (message.type === "manimScriptCreated") { pendingManimCreates.get(message.requestId)?.(message); pendingManimCreates.delete(message.requestId); }
  else if (message.type === "manimScenesListed") { pendingManimScenes.get(message.requestId)?.(message); pendingManimScenes.delete(message.requestId); }
  else if (message.type === "manimRenderResult") { pendingManimRenders.get(message.requestId)?.(message); pendingManimRenders.delete(message.requestId); }
  else if (message.type === "manimRenderAllResult") { pendingManimRenderAll.get(message.requestId)?.(message); pendingManimRenderAll.delete(message.requestId); }
  else if (message.type === "collaboration") setCollaboration({ status: message.status, role: message.role, canEdit: message.canEdit, hostName: message.hostName, self: message.self, peers: message.peers, temporaryMirror: message.temporaryMirror });
  else if (message.type === "assetsUpdated") noteAssets(message.references);
  else if (message.type === "notify") {
    manimHostAcked.add(message.notificationId);
    if (message.notificationId === "manim-setup") {
      window.clearTimeout(manimSetupTimer);
      if (message.status !== "progress") manimUiBusy = false;
    }
    notifyToast({ id: message.notificationId, kind: message.status, message: message.message, progress: message.progress });
    if (message.elementId) publishManimProgress({ elementId: message.elementId, status: message.status, percent: message.elementProgress ?? message.progress ?? 0 });
  }
}
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
  return { ...copy, id: crypto.randomUUID(), morphKey: preserveMorphKey ? copy.morphKey : crypto.randomUUID(), name: preserveMorphKey ? copy.name : `${elementLabel(copy)} copy`, x: copy.x + (preserveMorphKey ? 0 : 20), y: copy.y + (preserveMorphKey ? 0 : 20) } as SlideElement;
}
function applyTextTab(event: ReactKeyboardEvent<HTMLTextAreaElement>, value: string, apply: (text: string) => void): boolean {
  if (event.key !== "Tab") return false;
  event.preventDefault();
  event.stopPropagation();
  const input = event.currentTarget;
  const edit = insertTextTab(value, { start: input.selectionStart, end: input.selectionEnd }, event.shiftKey);
  apply(edit.text);
  requestAnimationFrame(() => input.setSelectionRange(edit.selection.start, edit.selection.end));
  return true;
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

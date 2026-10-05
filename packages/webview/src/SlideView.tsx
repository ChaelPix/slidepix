import { renderMarkdown, roundedEdgeFadeMask, type Deck, type MediaStorage, type Slide, type SlideElement } from "@slidepix/core";
import type { CSSProperties, MouseEvent } from "react";

type Props = {
  deck: Deck;
  slide: Slide;
  scale?: number;
  interactive?: boolean;
  selectedElementIds?: string[];
  editingElementId?: string;
  resolveAsset?: (source: string, storage: MediaStorage) => string;
  onSelectElement?: (id?: string, additive?: boolean) => void;
  onEditText?: (id: string) => void;
  onEditImage?: (id: string) => void;
};

export function SlideView({
  deck,
  slide,
  scale = 1,
  interactive = false,
  selectedElementIds = [],
  editingElementId,
  resolveAsset = (value) => value,
  onSelectElement,
  onEditText,
  onEditImage
}: Props) {
  const background = slide.background ?? deck.layouts[slide.layout ?? ""]?.background ?? deck.theme.background;
  const backgroundImage = slide.backgroundImage ? `url("${resolveAsset(slide.backgroundImage.src, slide.backgroundImage.storage)}")` : undefined;
  const visibleSlides = deck.slides.filter((item) => !item.hidden);
  const pageIndex = visibleSlides.findIndex((item) => item.id === slide.id);
  const stop = (event: MouseEvent, id: string) => {
    if (!interactive) return;
    event.stopPropagation();
    onSelectElement?.(id, event.shiftKey);
  };
  return (
    <div
      className="slide"
      data-slide-id={slide.id}
      style={{ width: deck.size.width, height: deck.size.height, backgroundColor: background, backgroundImage, backgroundSize: "100% 100%", backgroundRepeat: "no-repeat", transform: `scale(${scale})` }}
      onMouseDown={() => interactive && onSelectElement?.()}
    >
      {[...slide.elements].sort((a, b) => a.z - b.z).map((element) => (
        <ElementView
          key={element.id}
          element={element}
          interactive={interactive}
          selected={selectedElementIds.includes(element.id)}
          editing={editingElementId === element.id}
          resolveAsset={resolveAsset}
          onMouseDown={(event) => stop(event, element.id)}
          onDoubleClick={() => {
            if (element.type === "text") onEditText?.(element.id);
            if (element.type === "image") onEditImage?.(element.id);
          }}
        />
      ))}
      {pageIndex >= 0 && (
        <div className="page-number" style={{ color: deck.pageNumbers.color, fontSize: deck.pageNumbers.fontSize }}>
          {pageIndex + 1}
        </div>
      )}
    </div>
  );
}

function ElementView({
  element,
  interactive,
  selected,
  editing,
  resolveAsset,
  onMouseDown,
  onDoubleClick
}: {
  element: SlideElement;
  interactive: boolean;
  selected: boolean;
  editing: boolean;
  resolveAsset: (source: string, storage: MediaStorage) => string;
  onMouseDown: (event: MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  if (element.hidden) return null;
  const style: CSSProperties = {
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: `rotate(${element.rotation}deg)`,
    opacity: element.opacity,
    zIndex: element.z,
    pointerEvents: element.locked ? "none" : undefined
  };
  return (
    <div
      id={interactive ? `element-${element.id}` : undefined}
      className={`slide-element ${selected ? "selected" : ""} ${editing ? "editing" : ""}`}
      title={interactive && element.type === "text" ? "Double-click to edit text" : undefined}
      data-element-id={element.id}
      style={style}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      {element.type === "text" && (
        <div
          className={`slidepix-text-content valign-${element.style.verticalAlign}`}
          style={{
            fontFamily: element.style.fontFamily,
            fontSize: element.style.fontSize,
            fontWeight: element.style.fontWeight,
            color: element.style.color,
            textAlign: element.style.textAlign,
            lineHeight: element.style.lineHeight,
            padding: element.style.padding
          }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(element.markdown) }}
        />
      )}
      {element.type === "image" && <ImageView element={element} src={resolveAsset(element.src, element.storage)} />}
      {element.type === "video" && (
        <video
          src={resolveAsset(element.src, element.storage)}
          poster={element.poster ? resolveAsset(element.poster, "embedded") : undefined}
          autoPlay={interactive && element.playback.mode === "autoplay"}
          muted={element.playback.muted}
          loop={element.playback.loop}
          controls={interactive && element.playback.controls}
          style={{ borderRadius: element.borderRadius }}
        />
      )}
      {element.type === "manim" && (
        element.outputMedia
          ? element.output === "image"
            ? <img className="manim-output" src={resolveAsset(element.outputMedia.src, element.outputMedia.storage)} alt={element.alt ?? element.scene ?? "Manim"} />
            : <video
                className="manim-output"
                src={resolveAsset(element.outputMedia.src, element.outputMedia.storage)}
                autoPlay={interactive && element.playback.mode === "autoplay"}
                muted={element.playback.muted}
                loop={element.playback.loop}
                controls={interactive && element.playback.controls}
              />
          : <div className="manim-placeholder"><span>{element.scene?.trim() || "Manim"}</span></div>
      )}
      {element.type === "shape" && (
        <div
          className="shape-content"
          style={{
            background: element.fill,
            border: `${element.strokeWidth}px solid ${element.stroke}`,
            borderRadius: element.shape === "ellipse" ? "50%" : element.borderRadius,
            clipPath: element.shape === "triangle" ? "polygon(50% 0, 100% 100%, 0 100%)" : undefined,
            filter: element.shadow.enabled ? `drop-shadow(${element.shadow.offsetX}px ${element.shadow.offsetY}px ${element.shadow.blur}px ${element.shadow.color})` : undefined
          }}
        />
      )}
      {element.type === "table" && (
        <table
          className="slidepix-table-content"
          style={{
            fontFamily: element.style.fontFamily,
            fontSize: element.style.fontSize,
            fontWeight: element.style.fontWeight,
            color: element.style.color
          }}
        >
          <tbody>
            {Array.from({ length: element.rows }, (_, row) => {
              const Cell = element.headerRow && row === 0 ? "th" : "td";
              return <tr key={row}>{Array.from({ length: element.columns }, (_, column) => (
                <Cell
                  key={column}
                  style={{
                    background: row === 0 && element.headerRow ? element.style.headerFill : element.style.cellFill,
                    border: `${element.style.borderWidth}px solid ${element.style.borderColor}`,
                    padding: element.style.padding,
                    textAlign: row === 0 && element.headerRow ? "center" : element.style.textAlign
                  }}
                >
                  <div
                    className="slidepix-table-cell"
                    style={{ justifyContent: element.style.verticalAlign === "middle" ? "center" : element.style.verticalAlign === "bottom" ? "flex-end" : "flex-start" }}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(element.cells[row]?.[column] ?? "") }}
                  />
                </Cell>
              ))}</tr>;
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ImageView({ element, src }: { element: Extract<SlideElement, { type: "image" }>; src: string }) {
  const crop = element.crop;
  const fade = roundedEdgeFadeMask(element.width, element.height, element.borderRadius, element.edgeFade);
  return (
    <div
      className="image-clip"
      style={{
        borderRadius: element.borderRadius,
        border: `${element.border.width}px solid ${element.border.color}`,
        WebkitMaskImage: fade,
        maskImage: fade,
        WebkitMaskSize: "100% 100%",
        maskSize: "100% 100%",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat"
      } as CSSProperties}
    >
      <img
        src={src}
        alt={element.alt ?? ""}
        style={{
          width: `${100 / crop.width}%`,
          height: `${100 / crop.height}%`,
          left: `${-(crop.x / crop.width) * 100}%`,
          top: `${-(crop.y / crop.height) * 100}%`
        }}
      />
    </div>
  );
}

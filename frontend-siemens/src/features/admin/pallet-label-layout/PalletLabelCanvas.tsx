import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

import {
  moveLayoutElement,
  resizeLayoutElement,
  type PalletLabelEditorCanvas,
  type PalletLabelLayout,
  type PalletLabelLayoutElement,
  type PalletLabelLayoutElementId,
} from './palletLabelLayoutModel';

const ELEMENT_LABELS: Record<PalletLabelLayoutElementId, string> = {
  order: 'Заказ',
  customer: 'Заказчик',
  formedAt: 'Сформировано',
  rollCount: 'Рулонов на палете',
  qr: 'QR палетного листа',
  storage: 'Хранение',
};

type Gesture = {
  pointerId: number;
  mode: 'move' | 'resize';
  startClientX: number;
  startClientY: number;
  element: PalletLabelLayoutElement;
  baseLayout: PalletLabelLayout;
  latestLayout: PalletLabelLayout;
};

export function PalletLabelCanvas({
  layout,
  canvas,
  selectedId,
  disabled,
  onSelect,
  onTransientLayout,
  onCommitLayout,
}: {
  layout: PalletLabelLayout;
  canvas: PalletLabelEditorCanvas;
  selectedId: PalletLabelLayoutElementId;
  disabled: boolean;
  onSelect: (id: PalletLabelLayoutElementId) => void;
  onTransientLayout: (layout: PalletLabelLayout) => void;
  onCommitLayout: (layout: PalletLabelLayout, immediatePreview: boolean) => void;
}) {
  const gestureRef = useRef<Gesture | null>(null);
  const selectedElement = layout.elements.find((element) => element.id === selectedId);
  const renderedElements = selectedElement
    ? [...layout.elements.filter((element) => element.id !== selectedId), selectedElement]
    : layout.elements;

  useEffect(() => {
    if (disabled) gestureRef.current = null;
  }, [disabled]);

  function beginGesture(
    event: PointerEvent<SVGGElement | SVGRectElement>,
    element: PalletLabelLayoutElement,
    mode: Gesture['mode'],
  ) {
    if (disabled || element.locked) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(element.id);
    gestureRef.current = {
      pointerId: event.pointerId,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      element,
      baseLayout: layout,
      latestLayout: layout,
    };
  }

  function continueGesture(event: PointerEvent<SVGGElement | SVGRectElement>) {
    if (disabled) {
      gestureRef.current = null;
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const svg = event.currentTarget.ownerSVGElement;
    const renderedWidth = svg?.getBoundingClientRect().width || canvas.widthDots;
    const scale = canvas.widthDots / renderedWidth;
    const deltaX = (event.clientX - gesture.startClientX) * scale;
    const deltaY = (event.clientY - gesture.startClientY) * scale;
    const next =
      gesture.mode === 'move'
        ? moveLayoutElement(
            gesture.baseLayout,
            gesture.element.id,
            gesture.element.xDots + deltaX,
            gesture.element.yDots + deltaY,
            canvas,
          )
        : resizeLayoutElement(
            gesture.baseLayout,
            gesture.element.id,
            gesture.element.widthDots + deltaX,
            gesture.element.heightDots + deltaY,
            canvas,
          );
    gesture.latestLayout = next;
    onTransientLayout(next);
  }

  function endGesture(event: PointerEvent<SVGGElement | SVGRectElement>) {
    if (disabled) {
      gestureRef.current = null;
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    gestureRef.current = null;
    onCommitLayout(gesture.latestLayout, true);
  }

  function moveWithKeyboard(event: KeyboardEvent<SVGGElement>, element: PalletLabelLayoutElement) {
    if (disabled) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(element.id);
      return;
    }
    if (
      element.locked ||
      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    onSelect(element.id);
    const delta = canvas.dotsPerMm * (event.shiftKey ? 5 : 1);
    const x =
      element.xDots + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0);
    const y =
      element.yDots + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0);
    onCommitLayout(moveLayoutElement(layout, element.id, x, y, canvas), true);
  }

  return (
    <svg
      className="pallet-layout-canvas"
      viewBox={`0 0 ${canvas.widthDots} ${canvas.heightDots}`}
      role="group"
      aria-label="Холст палетного листа 100 на 100 мм"
      aria-disabled={disabled}
    >
      <defs>
        <pattern
          id="pallet-layout-minor-grid"
          width={canvas.dotsPerMm}
          height={canvas.dotsPerMm}
          patternUnits="userSpaceOnUse"
        >
          <path
            d={`M ${canvas.dotsPerMm} 0 L 0 0 0 ${canvas.dotsPerMm}`}
            className="pallet-layout-grid-line is-minor"
            fill="none"
          />
        </pattern>
        <pattern
          id="pallet-layout-major-grid"
          width={canvas.dotsPerMm * 5}
          height={canvas.dotsPerMm * 5}
          patternUnits="userSpaceOnUse"
        >
          <path
            d={`M ${canvas.dotsPerMm * 5} 0 L 0 0 0 ${canvas.dotsPerMm * 5}`}
            className="pallet-layout-grid-line is-major"
            fill="none"
          />
        </pattern>
      </defs>
      <rect width={canvas.widthDots} height={canvas.heightDots} className="pallet-layout-page" />
      <rect
        width={canvas.widthDots}
        height={canvas.heightDots}
        fill="url(#pallet-layout-minor-grid)"
      />
      <rect
        width={canvas.widthDots}
        height={canvas.heightDots}
        fill="url(#pallet-layout-major-grid)"
      />
      <rect
        x={canvas.safeInsetDots}
        y={canvas.safeInsetDots}
        width={canvas.widthDots - canvas.safeInsetDots * 2}
        height={canvas.heightDots - canvas.safeInsetDots * 2}
        className="pallet-layout-safe-boundary"
      />
      <line
        x1={canvas.safeInsetDots}
        x2={canvas.widthDots - canvas.safeInsetDots}
        y1={canvas.provenCutYDots}
        y2={canvas.provenCutYDots}
        className="pallet-layout-cut-line"
      />
      <text
        x={canvas.widthDots - canvas.safeInsetDots - 8}
        y={canvas.provenCutYDots - 8}
        textAnchor="end"
        className="pallet-layout-cut-label"
      >
        гарантированная зона до 71,25 мм
      </text>

      {renderedElements.map((element) => {
        const selected = element.id === selectedId;
        const label = ELEMENT_LABELS[element.id];
        return (
          <g
            key={element.id}
            data-layout-element={element.id}
            role="button"
            tabIndex={0}
            aria-label={`Выбрать блок ${label}`}
            aria-pressed={selected}
            aria-disabled={disabled}
            className={`pallet-layout-element${selected ? ' is-selected' : ''}${element.locked ? ' is-locked' : ''}`}
            onClick={() => {
              if (!disabled) onSelect(element.id);
            }}
            onFocus={() => {
              if (!disabled) onSelect(element.id);
            }}
            onKeyDown={(event) => moveWithKeyboard(event, element)}
            onPointerDown={(event) => beginGesture(event, element, 'move')}
            onPointerMove={continueGesture}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
          >
            <rect
              x={element.xDots}
              y={element.yDots}
              width={element.widthDots}
              height={element.heightDots}
              rx={5}
              className="pallet-layout-element-box"
            />
            <text
              x={element.xDots + 12}
              y={element.yDots + 24}
              className="pallet-layout-element-label"
            >
              {label}
            </text>
            {element.heightDots >= 55 ? (
              <text
                x={element.xDots + 12}
                y={element.yDots + 46}
                className="pallet-layout-element-meta"
              >
                {element.locked
                  ? 'зафиксирован'
                  : `${element.widthDots / canvas.dotsPerMm}×${element.heightDots / canvas.dotsPerMm} мм`}
              </text>
            ) : null}
            {selected && !element.locked && !disabled ? (
              <>
                <rect
                  data-layout-resize={element.id}
                  x={element.xDots + element.widthDots - 22}
                  y={element.yDots + element.heightDots - 22}
                  width={28}
                  height={28}
                  rx={5}
                  className="pallet-layout-resize-hit"
                  aria-label={`Изменить размер блока ${label}`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    beginGesture(event, element, 'resize');
                  }}
                  onPointerMove={continueGesture}
                  onPointerUp={endGesture}
                  onPointerCancel={endGesture}
                />
                <rect
                  x={element.xDots + element.widthDots - 22}
                  y={element.yDots + element.heightDots - 22}
                  width={28}
                  height={28}
                  rx={5}
                  className="pallet-layout-resize-handle"
                />
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

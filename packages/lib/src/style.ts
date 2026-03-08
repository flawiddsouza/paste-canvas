export const css = `
  .paste-canvas-root {
    font-family: system-ui, sans-serif;
    background: #1a1a1a;
    color: #e0e0e0;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .paste-canvas-root *, .paste-canvas-root *::before, .paste-canvas-root *::after {
    box-sizing: border-box;
  }

  /* ── Toolbar ── */
  .paste-canvas-root .pc-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #252525;
    border-bottom: 1px solid #333;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .paste-canvas-root .pc-toolbar h1 {
    font-size: 14px;
    font-weight: 600;
    color: #aaa;
    margin-right: 8px;
  }

  .paste-canvas-root .btn {
    padding: 5px 12px;
    border: 1px solid #444;
    border-radius: 5px;
    background: #333;
    color: #ddd;
    font-size: 13px;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .paste-canvas-root .btn:hover { background: #444; border-color: #666; }
  .paste-canvas-root .btn.active { background: #2d6be0; border-color: #4a88f0; color: #fff; }

  .paste-canvas-root .sep { width: 1px; height: 24px; background: #444; }

  .paste-canvas-root .pc-zoom-label {
    font-size: 12px;
    color: #888;
    min-width: 42px;
    text-align: right;
  }

  /* ── Viewport ── */
  .paste-canvas-root .pc-viewport {
    flex: 1;
    overflow: hidden;
    position: relative;
    cursor: default;
    background-color: #111;
    background-image:
      linear-gradient(#222 1px, transparent 1px),
      linear-gradient(90deg, #222 1px, transparent 1px);
    background-size: 40px 40px;
    background-position: 0 0;
  }

  .paste-canvas-root .pc-surface {
    position: absolute;
    top: 0; left: 0;
    width: 0; height: 0;
    transform-origin: 0 0;
  }

  /* ── Items ── */
  .paste-canvas-root .item {
    position: absolute;
    cursor: grab;
    user-select: none;
  }
  .paste-canvas-root .item-img:active { cursor: grabbing; }
  .paste-canvas-root .item.selected .item-inner {
    outline: 2px solid #2d6be0;
    outline-offset: 2px;
  }

  /* ── Marquee ── */
  .paste-canvas-root .pc-marquee {
    position: absolute;
    display: none;
    border: 1px solid #2d6be0;
    background: rgba(45, 107, 224, 0.10);
    pointer-events: none;
    z-index: 9999;
  }

  .paste-canvas-root .item-inner {
    position: relative;
    border-radius: 4px;
    background: #2a2a2a;
    box-shadow: 0 2px 8px rgba(0,0,0,.5);
  }

  /* Image items */
  .paste-canvas-root .item-img .item-inner { position: relative; }
  .paste-canvas-root .item-img .item-inner img {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 4px;
    pointer-events: none;
    min-width: 80px;
  }

  .paste-canvas-root .img-label {
    display: block;
    width: 100%;
    background: rgba(0,0,0,0.65);
    color: #eee;
    font-size: 13px;
    line-height: 1.5;
    padding: 5px 10px;
    border: none;
    outline: none;
    resize: none;
    font-family: inherit;
    border-radius: 0 0 4px 4px;
    overflow: hidden;
    cursor: text;
    min-height: 30px;
  }
  .paste-canvas-root .img-label:placeholder-shown:not(:focus) {
    height: 0;
    min-height: 0;
    padding-top: 0;
    padding-bottom: 0;
  }

  /* Note items */
  .paste-canvas-root .item-note .item-inner {
    background: #2b2b1e;
    border: 1px solid #554;
    min-width: 250px;
    min-height: 100px;
  }

  .paste-canvas-root .note-handle {
    height: 22px;
    background: #3a3a28;
    border-bottom: 1px solid #554;
    border-radius: 4px 4px 0 0;
    cursor: grab;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #776;
    font-size: 13px;
    letter-spacing: 3px;
    user-select: none;
    flex-shrink: 0;
  }
  .paste-canvas-root .note-handle:active { cursor: grabbing; }

  .paste-canvas-root .item-note textarea {
    display: block;
    width: 100%;
    min-width: 250px;
    min-height: 100px;
    resize: none;
    background: transparent;
    border: none;
    outline: none;
    color: #f0e68c;
    font-size: 14px;
    line-height: 1.5;
    padding: 10px 12px;
    font-family: inherit;
    cursor: text;
    overflow: auto;
  }

  /* Item toolbar */
  .paste-canvas-root .item-toolbar {
    position: absolute;
    top: -30px;
    left: 0;
    display: none;
    gap: 4px;
    background: #333;
    border: 1px solid #555;
    border-radius: 5px;
    padding: 3px 5px;
    z-index: 10;
    white-space: nowrap;
  }
  .paste-canvas-root .item.toolbar-active .item-toolbar,
  .paste-canvas-root .item.selected .item-toolbar { display: flex; }

  .paste-canvas-root .item-btn {
    padding: 2px 8px;
    border: none;
    border-radius: 3px;
    background: #444;
    color: #ddd;
    font-size: 11px;
    cursor: pointer;
  }
  .paste-canvas-root .item-btn:hover { background: #2d6be0; color: #fff; }
  .paste-canvas-root .item-btn.danger:hover { background: #c0392b; }

  /* Resize handle */
  .paste-canvas-root .resize-handle {
    position: absolute;
    bottom: 0; right: 0;
    width: 18px; height: 18px;
    cursor: se-resize;
    background: linear-gradient(135deg, transparent 50%, #777 50%);
    border-radius: 0 0 4px 0;
    z-index: 2;
    touch-action: none;
  }
  .paste-canvas-root .resize-handle:hover {
    background: linear-gradient(135deg, transparent 50%, #2d6be0 50%);
  }

  /* ── Tab bar ── */
  .paste-canvas-root .pc-tab-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 8px 0;
    background: #1e1e1e;
    border-bottom: 1px solid #333;
    flex-shrink: 0;
    overflow-x: auto;
  }
  .paste-canvas-root .tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    background: #2a2a2a;
    border: 1px solid #444;
    border-bottom: none;
    border-radius: 5px 5px 0 0;
    cursor: pointer;
    font-size: 12px;
    color: #aaa;
    user-select: none;
    white-space: nowrap;
  }
  .paste-canvas-root .tab.active { background: #333; color: #eee; border-color: #555; }
  .paste-canvas-root .tab-name { outline: none; }
  .paste-canvas-root .tab-close {
    background: none; border: none; color: #666;
    cursor: pointer; font-size: 14px; padding: 0 0 0 4px;
    line-height: 1;
  }
  .paste-canvas-root .tab-close:hover { color: #e55; }
  .paste-canvas-root .pc-add-tab-btn {
    padding: 2px 9px;
    background: none; border: 1px solid #444;
    border-radius: 4px; color: #888;
    cursor: pointer; font-size: 16px; flex-shrink: 0;
    margin-left: 4px;
  }
  .paste-canvas-root .pc-add-tab-btn:hover { background: #333; color: #ccc; }

  /* ── Port dots ── */
  .paste-canvas-root .port {
    position: absolute; width: 10px; height: 10px;
    border-radius: 50%; background: #2d6be0; border: 2px solid #fff;
    cursor: crosshair; z-index: 20; opacity: 0;
    pointer-events: none; transition: opacity .1s;
  }
  .paste-canvas-root .item:hover .port { opacity: 1; pointer-events: all; }
  .paste-canvas-root .port-top    { top: -5px;    left: 50%; transform: translateX(-50%); }
  .paste-canvas-root .port-right  { right: -5px;  top: 50%;  transform: translateY(-50%); }
  .paste-canvas-root .port-bottom { bottom: -5px; left: 50%; transform: translateX(-50%); }
  .paste-canvas-root .port-left   { left: -5px;   top: 50%;  transform: translateY(-50%); }

  /* ── Edge layer ── */
  .paste-canvas-root .pc-edge-layer {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    overflow: visible; pointer-events: none;
    transform-origin: 0 0;
  }
  .paste-canvas-root .edge-path { fill: none; stroke: #888; stroke-width: 2; }
  .paste-canvas-root .edge-path.selected { stroke: #2d6be0; }
  .paste-canvas-root .edge-hit  { fill: none; stroke: transparent; stroke-width: 16;
               pointer-events: stroke; cursor: pointer; }
  .paste-canvas-root .edge-preview { fill: none; stroke: #2d6be0; stroke-width: 2;
                  stroke-dasharray: 6 4; pointer-events: none; }

  /* ── Overview canvas (Canvas2D LOD at very low zoom) ── */
  .paste-canvas-root .pc-overview-canvas {
    position: absolute;
    top: 0; left: 0;
    pointer-events: none;
    display: none;
    transform-origin: 0 0;
    image-rendering: pixelated;
  }

  /* ── LOD: strip decorations when zoomed out below 35% ── */
  .paste-canvas-root .pc-surface.overview-lod .item-toolbar,
  .paste-canvas-root .pc-surface.overview-lod .port,
  .paste-canvas-root .pc-surface.overview-lod .resize-handle,
  .paste-canvas-root .pc-surface.overview-lod .img-label {
    display: none !important;
  }

  /* ── Toast ── */
  .paste-canvas-root .pc-toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%) translateY(60px);
    background: #2d6be0;
    color: #fff;
    padding: 8px 18px;
    border-radius: 6px;
    font-size: 13px;
    pointer-events: none;
    transition: transform .25s ease, opacity .25s ease;
    opacity: 0;
    z-index: 1000;
  }
  .paste-canvas-root .pc-toast.show {
    transform: translateX(-50%) translateY(0);
    opacity: 1;
  }
`;

let injected = false;

export function injectStyles(): void {
  if (injected) return;
  injected = true;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

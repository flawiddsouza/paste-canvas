import type { Ctx, StorageAdapter } from './types.js';
import { injectStyles } from './style.js';
import { applyTransform, saveViewport, toast, viewportCenter, clearSelection, addToSelection, initViewport, initToolbarHover } from './canvas.js';
import { pushUndo, performUndo, performRedo } from './history.js';
import { snapItem, restoreItemSnap, saveItem, createItem, removeItem, placeImage, copyImage, copyText, duplicateSelected } from './items.js';
import { snapEdge, restoreEdgeSnap, removeEdge } from './edges.js';
import { renderTabBar, restoreAll, createTab } from './tabs.js';

export interface PasteCanvasOptions {
  title?: string;
}

export function createCanvas(container: HTMLElement, adapter: StorageAdapter, opts?: PasteCanvasOptions): PasteCanvas {
  return new PasteCanvas(container, adapter, opts);
}

export class PasteCanvas {
  private static instanceCount = 0;

  private ctx: Ctx;
  private abort = new AbortController();

  constructor(container: HTMLElement, adapter: StorageAdapter, opts: PasteCanvasOptions = {}) {
    injectStyles();
    container.className = 'paste-canvas-root';

    const instanceId = ++PasteCanvas.instanceCount;
    const arrowheadId = `pc-arrowhead-${instanceId}`;
    const title = opts.title ?? 'Paste Canvas';

    // ── Build DOM ──────────────────────────────────────────────────────────
    container.innerHTML = `
      <div class="pc-toolbar">
        <h1>${title}</h1>
        <button class="btn pc-btn-note">+ Note</button>
        <button class="btn pc-btn-paste-img">Paste Image</button>
        <div class="sep"></div>
        <button class="btn pc-btn-clear-sel">Deselect</button>
        <button class="btn pc-btn-delete-sel">Delete Selected</button>
        <div class="sep"></div>
        <button class="btn pc-btn-reset-view">Reset View</button>
        <span class="pc-zoom-label">100%</span>
        <span class="pc-coords-label" style="font-size:11px;color:#555;min-width:80px">0, 0</span>
        <div class="sep"></div>
        <small style="color:#666;font-size:11px">Ctrl+V paste \u00b7 Scroll zoom \u00b7 Drag canvas to pan \u00b7 Shift/Ctrl+drag to select</small>
      </div>
      <div class="pc-tab-bar">
        <button class="pc-add-tab-btn">+</button>
      </div>
      <div class="pc-viewport">
        <div class="pc-surface"></div>
        <svg class="pc-edge-layer">
          <defs>
            <marker id="${arrowheadId}" markerWidth="6" markerHeight="4" refX="5" refY="2" orient="auto">
              <polygon points="0 0, 6 2, 0 4" fill="context-stroke"/>
            </marker>
          </defs>
        </svg>
        <div class="pc-marquee"></div>
      </div>
      <div class="pc-toast"></div>
    `;

    const q = <T extends Element>(sel: string) => container.querySelector<T>(sel)!;

    // ── Build context ──────────────────────────────────────────────────────
    this.ctx = {
      surface:     q<HTMLDivElement>('.pc-surface'),
      viewport:    q<HTMLDivElement>('.pc-viewport'),
      edgeLayer:   q<SVGSVGElement>('.pc-edge-layer'),
      marqueeEl:   q<HTMLDivElement>('.pc-marquee'),
      zoomLabel:   q<HTMLSpanElement>('.pc-zoom-label'),
      coordsLabel: q<HTMLSpanElement>('.pc-coords-label'),
      tabBar:      q<HTMLDivElement>('.pc-tab-bar'),
      toastEl:     q<HTMLDivElement>('.pc-toast'),

      scale: 1, panX: 0, panY: 0,

      items: [], selectedItems: new Set(), itemCounter: 0,
      tabs: [], currentTabId: null, tabCounter: 0, placeOffset: 0,
      edges: [], selectedEdges: new Set(), edgeCounter: 0,
      nodeEdgeMap: new Map(),
      undoStack: [], redoStack: [], tabHistory: new Map(),

      toastTimer: null, vpSaveTimer: null,

      arrowheadId,
      signal: this.abort.signal,

      adapter,
    };

    this.setupInteraction(container);
  }

  mount(): this {
    void restoreAll(this.ctx).then(() => {
      if (this.ctx.items.length === 0) {
        toast(this.ctx, 'Ctrl+V to paste images or text  \u00b7  Scroll to zoom  \u00b7  Drag to pan', 3500);
      }
    });
    return this;
  }

  destroy(): void {
    this.abort.abort();
    this.ctx.surface.closest('.paste-canvas-root')?.remove();
  }

  // ── Internal setup ────────────────────────────────────────────────────────

  private setupInteraction(container: HTMLElement): void {
    const ctx = this.ctx;
    initViewport(ctx);
    initToolbarHover(ctx);
    this.setupToolbarButtons(container);
    this.setupPaste();
    this.setupKeyboard();
  }

  private setupToolbarButtons(container: HTMLElement): void {
    const ctx = this.ctx;
    const { signal } = ctx;
    const q = (sel: string) => container.querySelector(sel) as HTMLElement;

    q('.pc-btn-note').addEventListener('click', () => {
      const c = viewportCenter(ctx);
      const off = ctx.placeOffset++ * 24;
      const rec = createItem(ctx, 'note', c.x - 90 + off, c.y - 40 + off);
      const snap = snapItem(ctx, rec);
      pushUndo(ctx, {
        label: 'create note',
        undo() { const r = ctx.items.find(i => i.id === snap.id); if (r) removeItem(ctx, r); return []; },
        redo() { restoreItemSnap(ctx, snap); return [snap.id]; },
      });
    }, { signal });

    q('.pc-btn-paste-img').addEventListener('click', async () => {
      try {
        const items_cb = await navigator.clipboard.read();
        for (const ci of items_cb) {
          const type = ci.types.find(t => t.startsWith('image/'));
          if (type) { placeImage(ctx, URL.createObjectURL(await ci.getType(type))); return; }
        }
        toast(ctx, 'No image in clipboard. Try Ctrl+V instead.');
      } catch {
        toast(ctx, 'Use Ctrl+V to paste from clipboard.');
      }
    }, { signal });

    q('.pc-btn-clear-sel').addEventListener('click', () => clearSelection(ctx), { signal });

    q('.pc-btn-delete-sel').addEventListener('click', () => {
      if (ctx.selectedItems.size === 0 && ctx.selectedEdges.size === 0) {
        toast(ctx, 'No item selected');
        return;
      }
      if (ctx.selectedEdges.size) { this.deleteSelectedEdges(); return; }
      this.deleteSelectedItems();
    }, { signal });

    q('.pc-btn-reset-view').addEventListener('click', () => {
      ctx.scale = 1; ctx.panX = 0; ctx.panY = 0;
      applyTransform(ctx);
      saveViewport(ctx);
    }, { signal });

    ctx.tabBar.querySelector('.pc-add-tab-btn')!
      .addEventListener('click', () => void createTab(ctx, `Board ${ctx.tabs.length + 1}`), { signal });
  }

  private setupPaste(): void {
    const ctx = this.ctx;
    document.addEventListener('paste', (e) => {
      if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
      const dt = e.clipboardData!.items;
      let handled = false;
      for (const item of dt) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          placeImage(ctx, URL.createObjectURL(item.getAsFile()!));
          handled = true;
          break;
        }
      }
      if (!handled) {
        for (const item of dt) {
          if (item.kind === 'string' && item.type === 'text/plain') {
            item.getAsString((text) => {
              if (!text.trim()) return;
              const c = viewportCenter(ctx);
              const off = ctx.placeOffset++ * 24;
              const rec = createItem(ctx, 'note', c.x - 90 + off, c.y - 40 + off);
              (rec.contentEl as HTMLTextAreaElement).value = text;
              void saveItem(ctx, rec);
              const snap = snapItem(ctx, rec);
              pushUndo(ctx, {
                label: 'create note',
                undo() { const r = ctx.items.find(i => i.id === snap.id); if (r) removeItem(ctx, r); return []; },
                redo() { restoreItemSnap(ctx, snap); return [snap.id]; },
              });
            });
            handled = true;
            break;
          }
        }
      }
    }, { signal: ctx.signal });
  }

  private setupKeyboard(): void {
    const ctx = this.ctx;
    document.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); performUndo(ctx); return; }
      if (e.ctrlKey && (e.key === 'y' || e.key === 'Z')) { e.preventDefault(); performRedo(ctx); return; }
      if (e.ctrlKey && e.key === 'a') {
        e.preventDefault();
        clearSelection(ctx);
        for (const item of ctx.items) addToSelection(ctx, item);
        return;
      }
      if (e.ctrlKey && e.key === 'd') { e.preventDefault(); void duplicateSelected(ctx); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (ctx.selectedEdges.size) { this.deleteSelectedEdges(); return; }
        if (ctx.selectedItems.size) { this.deleteSelectedItems(); }
      }
      if (e.key === 'Escape') { clearSelection(ctx); }
      if (e.ctrlKey && e.key === 'c' && ctx.selectedItems.size === 1) {
        const item = [...ctx.selectedItems][0];
        if (item.type === 'img')  void copyImage(ctx, item.contentEl as HTMLImageElement);
        if (item.type === 'note') void copyText(ctx, item.contentEl as HTMLTextAreaElement);
      }
    }, { signal: ctx.signal });
  }

  private deleteSelectedItems(): void {
    const ctx = this.ctx;
    const snaps = [...ctx.selectedItems].map(rec => snapItem(ctx, rec));
    const edgeSnapMap = new Map<number, ReturnType<typeof snapEdge>>();
    for (const item of ctx.selectedItems) {
      for (const er of (ctx.nodeEdgeMap.get(item.id) ?? [])) {
        if (!edgeSnapMap.has(er.id)) edgeSnapMap.set(er.id, snapEdge(er));
      }
    }
    const edgeSnaps = [...edgeSnapMap.values()];
    for (const item of [...ctx.selectedItems]) removeItem(ctx, item, { skipRevoke: true });
    pushUndo(ctx, {
      label: snaps.length === 1
        ? 'delete ' + (snaps[0].type === 'img' ? 'image' : 'note')
        : `delete ${snaps.length} items`,
      undo() { for (const s of snaps) restoreItemSnap(ctx, s); for (const es of edgeSnaps) restoreEdgeSnap(ctx, es); return snaps.map(s => s.id); },
      redo() { for (const s of snaps) { const r = ctx.items.find(i => i.id === s.id); if (r) removeItem(ctx, r, { skipRevoke: true }); } return []; },
      dispose() { for (const s of snaps) { if (s.blobUrl && !ctx.items.find(i => i.id === s.id)) URL.revokeObjectURL(s.blobUrl!); } },
    });
  }

  private deleteSelectedEdges(): void {
    const ctx = this.ctx;
    const snaps = [...ctx.selectedEdges].map(snapEdge);
    for (const er of [...ctx.selectedEdges]) removeEdge(ctx, er);
    pushUndo(ctx, {
      label: snaps.length === 1 ? 'disconnect' : `disconnect ${snaps.length}`,
      undo() { for (const s of snaps) restoreEdgeSnap(ctx, s); return [...new Set(snaps.flatMap(s => [s.fromNode, s.toNode]))]; },
      redo() { for (const s of snaps) { const er = ctx.edges.find(e => e.id === s.id); if (er) removeEdge(ctx, er); } return []; },
    });
  }
}

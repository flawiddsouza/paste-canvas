import type { Ctx, StorageAdapter } from './types.js';
import { injectStyles } from './style.js';
import { applyTransform, saveViewport, toast, viewportCenter, fitItems, clearSelection, addToSelection, initViewport, initToolbarHover, invalidateOverviewCache } from './canvas.js';
import { pushUndo, performUndo, performRedo } from './history.js';
import { snapItem, restoreItemSnap, saveItem, createItem, removeItem, placeImage, copyImage, copyText, duplicateSelected } from './items.js';
import { groupSelectedItems } from './groups.js';
import { snapEdge, restoreEdgeSnap, removeEdge, updateEdgesForItems } from './edges.js';
import { renderTabBar, restoreAll, createTab } from './tabs.js';
import { initContextMenu } from './context-menu.js';

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
        <button class="btn pc-btn-paste">Paste</button>
        <div class="sep"></div>
        <button class="btn pc-btn-group">Group</button>
        <button class="btn pc-btn-delete-sel">Delete</button>
        <div class="sep"></div>
        <button class="btn pc-btn-reset-view">Home</button>
        <button class="btn pc-btn-fit">Fit</button>
        <span class="pc-zoom-label">100%</span>
        <button class="btn pc-btn-help">?</button>
      </div>
      <div class="pc-help-modal" hidden>
        <div class="pc-help-dialog">
          <div class="pc-help-header">
            <strong>Keyboard &amp; Mouse</strong>
            <button class="pc-help-close">\u00d7</button>
          </div>
          <div class="pc-help-body">
            <table class="pc-help-table">
              <tbody>
                <tr><th colspan="2">Canvas</th></tr>
                <tr><td>Scroll</td><td>Zoom in / out</td></tr>
                <tr><td>Drag canvas</td><td>Pan</td></tr>
                <tr><td>Middle-click drag</td><td>Pan</td></tr>
                <tr><th colspan="2">Items</th></tr>
                <tr><td>Ctrl+V</td><td>Paste image or text</td></tr>
                <tr><td>Shift/Ctrl+drag</td><td>Marquee select</td></tr>
                <tr><td>Ctrl+A</td><td>Select all</td></tr>
                <tr><td>Escape</td><td>Deselect</td></tr>
                <tr><td>Delete / Backspace</td><td>Delete selected</td></tr>
                <tr><td>Ctrl+D</td><td>Duplicate selected</td></tr>
                <tr><td>Ctrl+G</td><td>Group selected items</td></tr>
                <tr><td>Ctrl+C</td><td>Copy selected item</td></tr>
                <tr><td>Arrow keys</td><td>Nudge 1px</td></tr>
                <tr><td>Shift+Arrow keys</td><td>Nudge 10px</td></tr>
                <tr><td>Double-click resize handle</td><td>Reset size</td></tr>
                <tr><th colspan="2">View</th></tr>
                <tr><td>F</td><td>Fit selection or all items</td></tr>
                <tr><th colspan="2">History</th></tr>
                <tr><td>Ctrl+Z</td><td>Undo</td></tr>
                <tr><td>Ctrl+Y / Ctrl+Shift+Z</td><td>Redo</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="pc-tab-bar">
        <button class="pc-add-tab-btn">+</button>
      </div>
      <div class="pc-viewport">
        <span class="pc-coords-label"></span>
        <div class="pc-surface">
          <svg class="pc-edge-layer">
            <defs>
              <marker id="${arrowheadId}" markerWidth="6" markerHeight="4" refX="5" refY="2" orient="auto">
                <polygon points="0 0, 6 2, 0 4" fill="context-stroke"/>
              </marker>
            </defs>
          </svg>
        </div>
        <canvas class="pc-overview-canvas"></canvas>
        <div class="pc-marquee"></div>
      </div>
      <div class="pc-toast"></div>
    `;

    const q = <T extends Element>(sel: string) => container.querySelector<T>(sel)!;

    // ── Build context ──────────────────────────────────────────────────────
    this.ctx = {
      surface:        q<HTMLDivElement>('.pc-surface'),
      viewport:       q<HTMLDivElement>('.pc-viewport'),
      edgeLayer:      q<SVGSVGElement>('.pc-edge-layer'),
      overviewCanvas: q<HTMLCanvasElement>('.pc-overview-canvas'),
      marqueeEl:      q<HTMLDivElement>('.pc-marquee'),
      zoomLabel:   q<HTMLSpanElement>('.pc-zoom-label'),
      coordsLabel: q<HTMLSpanElement>('.pc-coords-label'),
      tabBar:      q<HTMLDivElement>('.pc-tab-bar'),
      toastEl:     q<HTMLDivElement>('.pc-toast'),

      scale: 1, panX: 0, panY: 0,

      items: [], selectedItems: new Set(), itemCounter: 0, zCounter: 0, itemsById: new Map(),
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
    this.setupKeyboard(container);
    initContextMenu(ctx, () => this.deleteSelectedItems(), () => this.deleteSelectedEdges());
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

    q('.pc-btn-paste').addEventListener('click', async () => {
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

    q('.pc-btn-group').addEventListener('click', () => {
      groupSelectedItems(ctx);
    }, { signal });

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

    q('.pc-btn-fit').addEventListener('click', () => {
      fitItems(ctx, ctx.selectedItems.size > 0 ? [...ctx.selectedItems] : ctx.items);
    }, { signal });

    const helpModal = q('.pc-help-modal') as HTMLDivElement;
    q('.pc-btn-help').addEventListener('click', () => { helpModal.hidden = false; }, { signal });
    q('.pc-help-close').addEventListener('click', () => { helpModal.hidden = true; }, { signal });
    helpModal.addEventListener('click', (e) => { if (e.target === helpModal) helpModal.hidden = true; }, { signal });

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

  private setupKeyboard(container: HTMLElement): void {
    const ctx = this.ctx;
    document.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); performUndo(ctx); return; }
      if (e.ctrlKey && (e.key === 'y' || e.key === 'Z')) { e.preventDefault(); performRedo(ctx); return; }
      if (e.ctrlKey && e.key === 'a') {
        e.preventDefault();
        clearSelection(ctx);
        for (const item of ctx.items) addToSelection(ctx, item);
        return;
      }
      if (e.ctrlKey && e.key === 'd') { e.preventDefault(); void duplicateSelected(ctx); return; }
      if (e.ctrlKey && e.key === 'g') { e.preventDefault(); groupSelectedItems(ctx); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (ctx.selectedEdges.size) { this.deleteSelectedEdges(); return; }
        if (ctx.selectedItems.size) { this.deleteSelectedItems(); }
      }
      if (e.key === 'Escape') {
        const modal = container.querySelector<HTMLDivElement>('.pc-help-modal');
        if (modal && !modal.hidden) { modal.hidden = true; return; }
        clearSelection(ctx);
      }
      if (e.key === 'f' || e.key === 'F') {
        fitItems(ctx, ctx.selectedItems.size > 0 ? [...ctx.selectedItems] : ctx.items);
        return;
      }
      if (e.ctrlKey && e.key === 'c' && ctx.selectedItems.size === 1) {
        const item = [...ctx.selectedItems][0];
        if (item.type === 'img')  void copyImage(ctx, item.contentEl as HTMLImageElement);
        if (item.type === 'note') void copyText(ctx, item.contentEl as HTMLTextAreaElement);
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && ctx.selectedItems.size > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp'   ? -step : e.key === 'ArrowDown'  ? step : 0;
        const before = new Map([ ...ctx.selectedItems ].map(r => [r.id, { x: r.x, y: r.y }]));
        for (const r of ctx.selectedItems) {
          r.x += dx; r.y += dy;
          r.el.style.left = r.x + 'px';
          r.el.style.top  = r.y + 'px';
        }
        updateEdgesForItems(ctx, ctx.selectedItems);
        invalidateOverviewCache(ctx);
        const after = new Map([ ...ctx.selectedItems ].map(r => [r.id, { x: r.x, y: r.y }]));
        for (const r of ctx.selectedItems) void saveItem(ctx, r);
        pushUndo(ctx, {
          label: 'nudge',
          undo() {
            for (const [id, pos] of before) {
              const r = ctx.items.find(i => i.id === id); if (!r) continue;
              r.x = pos.x; r.y = pos.y;
              r.el.style.left = pos.x + 'px'; r.el.style.top = pos.y + 'px';
              void saveItem(ctx, r);
            }
            updateEdgesForItems(ctx, new Set(ctx.items.filter(i => before.has(i.id))));
            return [...before.keys()];
          },
          redo() {
            for (const [id, pos] of after) {
              const r = ctx.items.find(i => i.id === id); if (!r) continue;
              r.x = pos.x; r.y = pos.y;
              r.el.style.left = pos.x + 'px'; r.el.style.top = pos.y + 'px';
              void saveItem(ctx, r);
            }
            updateEdgesForItems(ctx, new Set(ctx.items.filter(i => after.has(i.id))));
            return [...after.keys()];
          },
        });
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

    // For each selected group, track members NOT in the selection so we can
    // restore their groupId on undo (removeItem clears it).
    const orphanedMembers = new Map<number, number[]>(); // groupId -> memberIds
    for (const item of ctx.selectedItems) {
      if (item.type === 'group') {
        const ids = ctx.items
          .filter(i => i.groupId === item.id && !ctx.selectedItems.has(i))
          .map(i => i.id);
        if (ids.length) orphanedMembers.set(item.id, ids);
      }
    }

    for (const item of [...ctx.selectedItems]) removeItem(ctx, item, { skipRevoke: true });
    pushUndo(ctx, {
      label: snaps.length === 1
        ? 'delete ' + (snaps[0].type === 'img' ? 'image' : snaps[0].type === 'group' ? 'group' : 'note')
        : `delete ${snaps.length} items`,
      undo() {
        for (const s of snaps) restoreItemSnap(ctx, s);
        for (const [groupId, memberIds] of orphanedMembers) {
          for (const mid of memberIds) {
            const m = ctx.itemsById.get(mid);
            if (m) { m.groupId = groupId; void saveItem(ctx, m); }
          }
        }
        for (const es of edgeSnaps) restoreEdgeSnap(ctx, es);
        return snaps.map(s => s.id);
      },
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

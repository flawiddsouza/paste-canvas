import type { Ctx, StorageAdapter } from './types.js';
import type { ItemPlugin, StoredPlugin } from './plugin.js';
import { PastePriority } from './plugin.js';
import { injectStyles } from './style.js';
import { applyTransform, saveViewport, toast, viewportCenter, fitItems, clearSelection, addToSelection, initViewport, initToolbarHover, invalidateOverviewCache } from './canvas.js';
import { pushUndo, performUndo, performRedo } from './history.js';
import { snapItem, restoreItemSnap, saveItem, createItem, removeItem, duplicateSelected } from './items.js';
import { NotePlugin } from './plugins/NotePlugin.js';
import { ImagePlugin } from './plugins/ImagePlugin.js';
import { GroupPlugin } from './plugins/GroupPlugin.js';
import { groupSelectedItems } from './groups.js';
import { snapEdge, restoreEdgeSnap, removeEdge, updateEdgesForItems } from './edges.js';
import { renderTabBar, restoreAll, createTab } from './tabs.js';
import { initContextMenu } from './context-menu.js';

export interface PasteCanvasOptions {
  title?: string;
  itemTypes?: ItemPlugin[];
  /** Item type to create when dragging an edge to empty canvas. Defaults to 'note'. */
  edgeDropType?: string;
}

export const defaultPlugins: ItemPlugin[] = [ImagePlugin, NotePlugin, GroupPlugin];

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

    const plugins = opts?.itemTypes ?? defaultPlugins;

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
      nodeEdgeMap: new Map(), draggingEdge: false,
      undoStack: [], redoStack: [], tabHistory: new Map(),

      toastTimer: null, vpSaveTimer: null,

      arrowheadId,
      signal: this.abort.signal,

      itemPlugins: new Map(plugins.map(p => [p.type, p])),

      adapter,
      edgeDropType: opts?.edgeDropType ?? 'note',
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
        const sorted = [...ctx.itemPlugins.values()]
          .filter(p => p.pasteFromClipboard)
          .sort((a, b) => (b.pastePriority ?? PastePriority.normal) - (a.pastePriority ?? PastePriority.normal));
        for (const p of sorted) {
          let result: Awaited<ReturnType<NonNullable<typeof p.pasteFromClipboard>>>;
          try { result = await p.pasteFromClipboard!(items_cb); }
          catch (e) { console.error(`[paste-canvas] pasteFromClipboard() failed for plugin "${p.type}"`, e); continue; }
          if (result) {
            this.createItemAtViewportCenter(p.type, result.stored, result.width, result.height);
            return;
          }
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
    let middleJustReleased = false;
    document.addEventListener('mouseup', (e) => { if (e.button === 1) middleJustReleased = true; }, { signal: ctx.signal });
    document.addEventListener('keydown', () => { middleJustReleased = false; }, { signal: ctx.signal });
    document.addEventListener('paste', (e) => {
      if (middleJustReleased) { middleJustReleased = false; return; } // suppress middle-click primary-selection paste (Linux X11)
      if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
      const dt = e.clipboardData!;

      // Each plugin's paste() grabs its DataTransfer data synchronously before its first
      // await — kick them all off now so all synchronous grabs happen before we yield.
      const sorted = [...ctx.itemPlugins.values()]
        .filter(p => p.paste)
        .sort((a, b) => (b.pastePriority ?? PastePriority.normal) - (a.pastePriority ?? PastePriority.normal));
      const passesSorted = sorted.flatMap(p => {
        try { return [{ plugin: p, promise: p.paste!(dt) }]; }
        catch (e) { console.error(`[paste-canvas] paste() threw synchronously for plugin "${p.type}"`, e); return []; }
      });

      void (async () => {
        for (const { plugin, promise } of passesSorted) {
          let result: Awaited<ReturnType<NonNullable<typeof plugin.paste>>>;
          try { result = await promise; }
          catch (e) { console.error(`[paste-canvas] paste() failed for plugin "${plugin.type}"`, e); continue; }
          if (result) {
            this.createItemAtViewportCenter(plugin.type, result.stored, result.width, result.height);
            return;
          }
        }
      })();
    }, { signal: ctx.signal });
  }

  private createItemAtViewportCenter(type: string, stored: StoredPlugin, width?: number, height?: number): void {
    const ctx = this.ctx;
    const c = viewportCenter(ctx);
    const w = width  ?? 180;
    const h = height ?? 80;
    const off = ctx.placeOffset++ * 24;
    const rec = createItem(ctx, type, c.x - w / 2 + off, c.y - h / 2 + off);
    rec.bound.suppressDuring(() => {
      try { rec.bound.hydrate(stored); }
      catch (e) { console.error(`[paste-canvas] hydrate() failed for type "${type}"`, e); }
    });
    void saveItem(ctx, rec.id);
    const snap = snapItem(ctx, rec);
    pushUndo(ctx, {
      label: `create ${ctx.itemPlugins.get(type)?.label.toLowerCase() ?? type}`,
      undo() { const r = ctx.items.find(i => i.id === snap.id); if (r) removeItem(ctx, r); return []; },
      redo() { restoreItemSnap(ctx, snap); return [snap.id]; },
    });
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
        item.bound.copy?.();
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
        for (const r of ctx.selectedItems) void saveItem(ctx, r.id);
        pushUndo(ctx, {
          label: 'nudge',
          undo() {
            for (const [id, pos] of before) {
              const r = ctx.items.find(i => i.id === id); if (!r) continue;
              r.x = pos.x; r.y = pos.y;
              r.el.style.left = pos.x + 'px'; r.el.style.top = pos.y + 'px';
              void saveItem(ctx, r.id);
            }
            updateEdgesForItems(ctx, new Set(ctx.items.filter(i => before.has(i.id))));
            return [...before.keys()];
          },
          redo() {
            for (const [id, pos] of after) {
              const r = ctx.items.find(i => i.id === id); if (!r) continue;
              r.x = pos.x; r.y = pos.y;
              r.el.style.left = pos.x + 'px'; r.el.style.top = pos.y + 'px';
              void saveItem(ctx, r.id);
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
      if (ctx.itemPlugins.get(item.type)?.container) {
        const ids = ctx.items
          .filter(i => i.groupId === item.id && !ctx.selectedItems.has(i))
          .map(i => i.id);
        if (ids.length) orphanedMembers.set(item.id, ids);
      }
    }

    for (const item of [...ctx.selectedItems]) removeItem(ctx, item);
    pushUndo(ctx, {
      label: snaps.length === 1
        ? `delete ${ctx.itemPlugins.get(snaps[0].type)?.label.toLowerCase() ?? snaps[0].type}`
        : `delete ${snaps.length} items`,
      undo() {
        for (const s of snaps) restoreItemSnap(ctx, s);
        for (const [groupId, memberIds] of orphanedMembers) {
          for (const mid of memberIds) {
            const m = ctx.itemsById.get(mid);
            if (m) { m.groupId = groupId; void saveItem(ctx, m.id); }
          }
        }
        for (const es of edgeSnaps) restoreEdgeSnap(ctx, es);
        return snaps.map(s => s.id);
      },
      redo() { for (const s of snaps) { const r = ctx.items.find(i => i.id === s.id); if (r) removeItem(ctx, r); } return []; },
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

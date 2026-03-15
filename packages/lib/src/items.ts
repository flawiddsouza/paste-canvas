import type { Ctx, ItemRecord, SnapItem } from './types.js';
import type { BoundView, StoredPlugin } from './plugin.js';
import { makePluginAPI, bindPlugin } from './plugin.js';
import { pushUndo } from './history.js';
import { addToSelection, clearSelection, selectItem, viewportCenter, invalidateOverviewCache, toast } from './canvas.js';
import { removeEdge, snapEdge, restoreEdgeSnap, updateEdgesForItems, startEdgeDrag } from './edges.js';

const GROUP_PAD = 24;

// ── Snapshots ────────────────────────────────────────────────────────────────

export function snapItem(ctx: Ctx, rec: ItemRecord): SnapItem {
  let pluginSnap: unknown = null;
  try { pluginSnap = rec.bound.snapshot(); }
  catch (e) { console.error(`[paste-canvas] snapshot() failed for type "${rec.type}"`, e); }
  return {
    id: rec.id, type: rec.type,
    x: rec.x, y: rec.y, w: rec.w, h: rec.h,
    zIndex: parseInt(rec.el.style.zIndex) || 0,
    groupId: rec.groupId,
    pluginSnap,
  };
}

export function restoreItemSnap(ctx: Ctx, snap: SnapItem): ItemRecord {
  const rec = createItem(ctx, snap.type, snap.x, snap.y, {
    id: snap.id, zIndex: snap.zIndex, skipSelect: true,
  });
  rec.groupId = snap.groupId;
  if (snap.w) { rec.el.style.width  = snap.w + 'px'; rec.w = snap.w; }
  if (snap.h) { rec.el.style.height = snap.h + 'px'; rec.h = snap.h; }
  try { rec.bound.restore(snap.pluginSnap); }
  catch (e) { console.error(`[paste-canvas] restore() failed for type "${rec.type}"`, e); }
  if (snap.w && snap.h) rec.bound.onResize?.(snap.w, snap.h);
  void saveItem(ctx, rec.id);
  return rec;
}

// ── Persistence ───────────────────────────────────────────────────────────────

export async function saveItem(ctx: Ctx, id: number): Promise<void> {
  const rec = ctx.itemsById.get(id);
  if (!rec) return;
  if (rec.mounted) { rec.w = rec.el.offsetWidth; rec.h = rec.el.offsetHeight; }
  let stored: StoredPlugin;
  try { stored = await rec.bound.serialize(); }
  catch (e) {
    console.error(`[paste-canvas] serialize() failed for type "${rec.type}"`, e);
    toast(ctx, `Failed to save ${ctx.itemPlugins.get(rec.type)?.label ?? rec.type}`);
    return;
  }
  ctx.adapter.putItem({
    id: rec.id,
    type: rec.type,
    tabId: ctx.currentTabId!,
    x: rec.x, y: rec.y, w: rec.w, h: rec.h,
    zIndex: parseInt(rec.el.style.zIndex) || 0,
    groupId: rec.groupId,
    pluginData: stored.data,
    binaryData: stored.binary,
    binaryKeys: stored.binary ? Object.keys(stored.binary) : undefined,
  });
}

function expandGroupToFit(ctx: Ctx, member: ItemRecord): ItemRecord | null {
  if (member.groupId == null) return null;
  const group = ctx.itemsById.get(member.groupId);
  if (!group) return null;
  const iRight  = member.x + (member.w || member.el.offsetWidth  || 200);
  const iBottom = member.y + (member.h || member.el.offsetHeight || 200);
  let changed = false;
  if (iRight + GROUP_PAD > group.x + group.w) {
    group.w = iRight + GROUP_PAD - group.x;
    group.el.style.width = group.w + 'px';
    changed = true;
  }
  if (iBottom + GROUP_PAD > group.y + group.h) {
    group.h = iBottom + GROUP_PAD - group.y;
    group.el.style.height = group.h + 'px';
    changed = true;
  }
  return changed ? group : null;
}

function captureGroupSnap(ctx: Ctx, record: ItemRecord): { id: number; w: number; h: number } | null {
  if (record.groupId == null) return null;
  const g = ctx.itemsById.get(record.groupId);
  return g ? { id: g.id, w: g.w, h: g.h } : null;
}

function captureGroupSize(ctx: Ctx, id: number): { w: number; h: number } | null {
  const g = ctx.itemsById.get(id);
  return g ? { w: g.w, h: g.h } : null;
}

function applyGroupSize(ctx: Ctx, id: number, w: number, h: number): void {
  const g = ctx.itemsById.get(id);
  if (!g) return;
  g.w = w; g.h = h;
  g.el.style.width = w + 'px'; g.el.style.height = h + 'px';
  void saveItem(ctx, g.id);
}

// ── Create item ───────────────────────────────────────────────────────────────

interface CreateItemOpts {
  id?: number;
  zIndex?: number;
  skipSelect?: boolean;
  skipMount?: boolean;
}

export function createItem(
  ctx: Ctx,
  type: string,
  x: number,
  y: number,
  opts: CreateItemOpts = {},
): ItemRecord {
  const id = opts.id != null ? opts.id : ++ctx.itemCounter;
  if (opts.id != null) ctx.itemCounter = Math.max(ctx.itemCounter, opts.id);

  const el = document.createElement('div');
  el.className = `item item-${type}`;
  el.style.left   = x + 'px';
  el.style.top    = y + 'px';
  el.style.zIndex = opts.zIndex != null ? String(opts.zIndex) : String(++ctx.zCounter);

  // ── Plugin + bound view ──────────────────────────────────────────────────────
  const plugin = ctx.itemPlugins.get(type);
  let bound: BoundView;
  if (plugin) {
    const { api, abort, suppress } = makePluginAPI(ctx, id);
    let view: { el: HTMLElement };
    try { view = plugin.create(api); }
    catch (err) {
      abort.abort();
      console.error(`[paste-canvas] plugin.create() failed for type "${type}":`, err);
      view = { el: document.createElement('div') };
    }
    bound = bindPlugin(plugin, view as Parameters<typeof bindPlugin>[1], api, abort, suppress);
  } else {
    // Unknown type — placeholder that round-trips stored data
    const pEl = document.createElement('div');
    pEl.style.cssText = 'min-width:120px;min-height:60px;background:#555;opacity:0.6;' +
      'border-radius:4px;display:flex;align-items:center;justify-content:center;' +
      'color:#fff;font-size:11px;padding:8px;box-sizing:border-box;';
    pEl.textContent = `Unknown: ${type}`;
    const abort = new AbortController();
    let phStored: StoredPlugin = {};
    bound = {
      el: pEl,
      snapshot:      () => phStored,
      restore:       (s) => { phStored = s as StoredPlugin; },
      serialize:     () => phStored,
      hydrate:       (s) => { phStored = s; },
      destroy()      { abort.abort(); },
      suppressDuring(fn) { fn(); },
    };
  }

  const isContainer = plugin?.container === true;
  const resizeMode  = plugin?.resize ?? 'both';
  const hasPorts    = !isContainer && plugin?.ports !== false;
  const minW        = plugin?.minWidth  ?? (isContainer ? 120 : 80);
  const minH        = plugin?.minHeight ?? (isContainer ? 80  : 40);

  // ── Toolbar ──────────────────────────────────────────────────────────────────
  const itb = document.createElement('div');
  itb.className = 'item-toolbar';
  itb.addEventListener('pointerdown', (e) => { if (e.button !== 1) e.stopPropagation(); });

  const pluginBtns = bound.toolbarButtons?.() ?? [];
  for (const btn of pluginBtns) itb.appendChild(btn);

  if (isContainer) {
    const ungroupBtn = document.createElement('button');
    ungroupBtn.className   = 'item-btn';
    ungroupBtn.textContent = 'Ungroup';
    ungroupBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rec       = ctx.itemsById.get(id)!;
      const memberIds = ctx.items.filter(i => i.groupId === id).map(i => i.id);
      const groupSnap = snapItem(ctx, rec);
      for (const mid of memberIds) {
        const m = ctx.itemsById.get(mid);
        if (m) { m.groupId = undefined; void saveItem(ctx, m.id); }
      }
      removeItem(ctx, rec);
      pushUndo(ctx, {
        label: 'ungroup',
        undo() {
          restoreItemSnap(ctx, groupSnap);
          for (const mid of memberIds) {
            const m = ctx.itemsById.get(mid);
            if (m) { m.groupId = groupSnap.id; void saveItem(ctx, m.id); }
          }
          return [groupSnap.id, ...memberIds];
        },
        redo() {
          for (const mid of memberIds) {
            const m = ctx.itemsById.get(mid);
            if (m) { m.groupId = undefined; void saveItem(ctx, m.id); }
          }
          const g = ctx.itemsById.get(groupSnap.id);
          if (g) removeItem(ctx, g);
          return memberIds;
        },
      });
    });
    itb.appendChild(ungroupBtn);
  }

  const delBtn = document.createElement('button');
  delBtn.className   = 'item-btn danger';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rec       = ctx.itemsById.get(id)!;
    const snap      = snapItem(ctx, rec);
    const memberIds = isContainer
      ? ctx.items.filter(i => i.groupId === id).map(i => i.id)
      : [];
    const edgeSnaps = isContainer
      ? []
      : [...(ctx.nodeEdgeMap.get(id) ?? [])].map(snapEdge);
    removeItem(ctx, rec);
    pushUndo(ctx, {
      label: `delete ${plugin?.label.toLowerCase() ?? type}`,
      undo() {
        restoreItemSnap(ctx, snap);
        for (const mid of memberIds) {
          const m = ctx.itemsById.get(mid);
          if (m) { m.groupId = snap.id; void saveItem(ctx, m.id); }
        }
        for (const es of edgeSnaps) restoreEdgeSnap(ctx, es);
        return [snap.id, ...memberIds];
      },
      redo() {
        const r = ctx.itemsById.get(snap.id);
        if (r) removeItem(ctx, r);
        return [];
      },
    });
  });
  itb.appendChild(delBtn);
  el.appendChild(itb);

  // ── Content shell ─────────────────────────────────────────────────────────────
  if (isContainer) {
    el.appendChild(bound.el);
  } else {
    const inner = document.createElement('div');
    inner.className = 'item-inner';
    inner.appendChild(bound.el);
    el.appendChild(inner);
  }

  // ── Resize handle ─────────────────────────────────────────────────────────────
  if (resizeMode !== 'none') {
    const rh = document.createElement('div');
    rh.className = 'resize-handle';
    el.appendChild(rh);

    if (isContainer) {
      rh.addEventListener('pointerdown', (e) => {
        if (e.button === 1) return;
        e.stopPropagation();
        e.preventDefault();
        rh.setPointerCapture(e.pointerId);
        const startX = e.clientX, startY = e.clientY;
        const startW = el.offsetWidth, startH = el.offsetHeight;
        const rec = ctx.itemsById.get(id)!;
        let mMinW = minW, mMinH = minH;
        for (const m of ctx.items.filter(i => i.groupId === id)) {
          const mw = m.w || m.el.offsetWidth || 200;
          const mh = m.h || m.el.offsetHeight || 200;
          mMinW = Math.max(mMinW, m.x - rec.x + mw + GROUP_PAD);
          mMinH = Math.max(mMinH, m.y - rec.y + mh + GROUP_PAD);
        }
        const onMove = (ev: PointerEvent) => {
          const dw = (ev.clientX - startX) / ctx.scale;
          const dh = (ev.clientY - startY) / ctx.scale;
          el.style.width  = Math.max(mMinW, startW + dw) + 'px';
          el.style.height = Math.max(mMinH, startH + dh) + 'px';
          const r = ctx.itemsById.get(id);
          if (r) { r.w = el.offsetWidth; r.h = el.offsetHeight; }
          bound.onResize?.(el.offsetWidth, el.offsetHeight);
        };
        const onUp = () => {
          const endW = el.offsetWidth, endH = el.offsetHeight;
          void saveItem(ctx, id);
          if (endW !== startW || endH !== startH) {
            pushUndo(ctx, {
              label: 'resize',
              undo() {
                const r = ctx.itemsById.get(id); if (!r) return [];
                r.el.style.width  = startW + 'px'; r.el.style.height = startH + 'px';
                r.w = startW; r.h = startH;
                r.bound.onResize?.(startW, startH);
                void saveItem(ctx, id); return [id];
              },
              redo() {
                const r = ctx.itemsById.get(id); if (!r) return [];
                r.el.style.width  = endW + 'px'; r.el.style.height = endH + 'px';
                r.w = endW; r.h = endH;
                r.bound.onResize?.(endW, endH);
                void saveItem(ctx, id); return [id];
              },
            });
          }
          rh.removeEventListener('pointermove',   onMove);
          rh.removeEventListener('pointerup',     onUp);
          rh.removeEventListener('pointercancel', onUp);
        };
        rh.addEventListener('pointermove',   onMove);
        rh.addEventListener('pointerup',     onUp);
        rh.addEventListener('pointercancel', onUp);
      });

      // dblclick: auto-fit container to its members
      rh.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const members = ctx.items.filter(i => i.groupId === id);
        if (members.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const m of members) {
          const mw = m.w || m.el.offsetWidth || 200;
          const mh = m.h || m.el.offsetHeight || 200;
          minX = Math.min(minX, m.x); minY = Math.min(minY, m.y);
          maxX = Math.max(maxX, m.x + mw); maxY = Math.max(maxY, m.y + mh);
        }
        const newX = minX - GROUP_PAD, newY = minY - GROUP_PAD;
        const newW = maxX - minX + GROUP_PAD * 2;
        const newH = maxY - minY + GROUP_PAD * 2;
        const rec = ctx.itemsById.get(id); if (!rec) return;
        const prevX = rec.x, prevY = rec.y, prevW = rec.w, prevH = rec.h;
        if (newX === prevX && newY === prevY && newW === prevW && newH === prevH) return;
        rec.x = newX; rec.y = newY;
        el.style.left = newX + 'px'; el.style.top = newY + 'px';
        el.style.width = newW + 'px'; el.style.height = newH + 'px';
        rec.w = newW; rec.h = newH;
        bound.onResize?.(newW, newH);
        void saveItem(ctx, id);
        pushUndo(ctx, {
          label: 'resize',
          undo() {
            const r = ctx.itemsById.get(id); if (!r) return [];
            r.x = prevX; r.y = prevY;
            r.el.style.left = prevX + 'px'; r.el.style.top = prevY + 'px';
            r.el.style.width = prevW + 'px'; r.el.style.height = prevH + 'px';
            r.w = prevW; r.h = prevH;
            r.bound.onResize?.(prevW, prevH);
            void saveItem(ctx, id); return [id];
          },
          redo() {
            const r = ctx.itemsById.get(id); if (!r) return [];
            r.x = newX; r.y = newY;
            r.el.style.left = newX + 'px'; r.el.style.top = newY + 'px';
            r.el.style.width = newW + 'px'; r.el.style.height = newH + 'px';
            r.w = newW; r.h = newH;
            r.bound.onResize?.(newW, newH);
            void saveItem(ctx, id); return [id];
          },
        });
      });
    } else {
      // Non-container resize
      rh.addEventListener('pointerdown', (e) => {
        if (e.button === 1) return;
        e.stopPropagation();
        e.preventDefault();
        rh.setPointerCapture(e.pointerId);
        const startX = e.clientX, startY = e.clientY;
        const startW = el.offsetWidth, startH = el.offsetHeight;
        const rec0      = ctx.itemsById.get(id);
        const groupSnap = rec0 ? captureGroupSnap(ctx, rec0) : null;
        const onMove = (ev: PointerEvent) => {
          const dw = resizeMode !== 'height' ? (ev.clientX - startX) / ctx.scale : 0;
          const dh = resizeMode !== 'width'  ? (ev.clientY - startY) / ctx.scale : 0;
          if (resizeMode !== 'height') el.style.width  = Math.max(minW, startW + dw) + 'px';
          if (resizeMode !== 'width')  el.style.height = Math.max(minH, startH + dh) + 'px';
          const r = ctx.itemsById.get(id);
          if (r) {
            r.w = el.offsetWidth; r.h = el.offsetHeight;
            bound.onResize?.(r.w, r.h);
            expandGroupToFit(ctx, r);
          }
          updateEdgesForItems(ctx, r ? new Set([r]) : new Set());
        };
        const onUp = () => {
          const endW = el.offsetWidth, endH = el.offsetHeight;
          bound.onResize?.(endW, endH);
          void saveItem(ctx, id);
          if (groupSnap) {
            const g = ctx.itemsById.get(groupSnap.id);
            if (g && (g.w !== groupSnap.w || g.h !== groupSnap.h)) void saveItem(ctx, g.id);
          }
          const r = ctx.itemsById.get(id);
          if (r) updateEdgesForItems(ctx, new Set([r]));
          if (endW !== startW || endH !== startH) {
            const groupEnd = groupSnap ? captureGroupSize(ctx, groupSnap.id) : null;
            pushUndo(ctx, {
              label: 'resize',
              undo() {
                const r = ctx.itemsById.get(id); if (!r) return [];
                if (resizeMode !== 'height') r.el.style.width  = startW + 'px';
                if (resizeMode !== 'width')  r.el.style.height = startH + 'px';
                r.w = r.el.offsetWidth; r.h = r.el.offsetHeight;
                r.bound.onResize?.(r.w, r.h);
                void saveItem(ctx, id);
                if (groupSnap) applyGroupSize(ctx, groupSnap.id, groupSnap.w, groupSnap.h);
                updateEdgesForItems(ctx, new Set([r]));
                return [id];
              },
              redo() {
                const r = ctx.itemsById.get(id); if (!r) return [];
                if (resizeMode !== 'height') r.el.style.width  = endW + 'px';
                if (resizeMode !== 'width')  r.el.style.height = endH + 'px';
                r.w = r.el.offsetWidth; r.h = r.el.offsetHeight;
                r.bound.onResize?.(r.w, r.h);
                void saveItem(ctx, id);
                if (groupSnap && groupEnd) applyGroupSize(ctx, groupSnap.id, groupEnd.w, groupEnd.h);
                updateEdgesForItems(ctx, new Set([r]));
                return [id];
              },
            });
          }
          rh.removeEventListener('pointermove',   onMove);
          rh.removeEventListener('pointerup',     onUp);
          rh.removeEventListener('pointercancel', onUp);
        };
        rh.addEventListener('pointermove',   onMove);
        rh.addEventListener('pointerup',     onUp);
        rh.addEventListener('pointercancel', onUp);
      });
    }
  }

  // ── Port dots ─────────────────────────────────────────────────────────────────
  if (hasPorts) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const dot = document.createElement('div');
      dot.className = `port port-${side}`;
      dot.addEventListener('pointerdown', (ev) => {
        if (ev.button === 1) return;
        ev.stopPropagation();
        ev.preventDefault();
        const rec = ctx.itemsById.get(id)!;
        startEdgeDrag(ctx, rec, side, ev);
      });
      el.appendChild(dot);
    }
  }

  // ── Register ──────────────────────────────────────────────────────────────────
  const record: ItemRecord = { id, el, type, x, y, w: 0, h: 0, bound, mounted: false };
  ctx.items.push(record);
  ctx.itemsById.set(id, record);

  if (!opts.skipMount) {
    ctx.surface.appendChild(el);
    record.mounted = true;
    invalidateOverviewCache(ctx);
    bound.afterMount?.(true);
  }

  makeDraggable(ctx, record);

  if (!opts.skipSelect) {
    selectItem(ctx, record);
    void saveItem(ctx, id);
  }

  return record;
}

// ── Remove item ───────────────────────────────────────────────────────────────

export function removeItem(ctx: Ctx, rec: ItemRecord): void {
  // Orphan any members (works for any container type via groupId)
  for (const member of ctx.items) {
    if (member.groupId === rec.id) member.groupId = undefined;
  }
  rec.bound.destroy();
  rec.el.remove();
  ctx.items.splice(ctx.items.indexOf(rec), 1);
  ctx.itemsById.delete(rec.id);
  ctx.selectedItems.delete(rec);
  const edges = [...(ctx.nodeEdgeMap.get(rec.id) ?? [])];
  for (const e of edges) removeEdge(ctx, e);
  ctx.nodeEdgeMap.delete(rec.id);
  ctx.adapter.deleteItem(rec.id);
  invalidateOverviewCache(ctx);
}

// ── Dragging items ────────────────────────────────────────────────────────────

export function makeDraggable(ctx: Ctx, record: ItemRecord): void {
  const el = record.el;
  let dragging = false;
  let startCanvasX = 0, startCanvasY = 0;
  let startPositions: Map<ItemRecord, { x: number; y: number }>;
  let beforeDrag: Map<number, { x: number; y: number }>;
  let movingItems: Set<ItemRecord>;
  let passengers: ItemRecord[] = [];

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLButtonElement   ||
        (e.target as HTMLElement).classList.contains('resize-handle')) return;

    const multiKey = e.shiftKey || e.ctrlKey;
    if (multiKey) {
      // toggleSelection imported indirectly via addToSelection/removeItem patterns
      if (ctx.selectedItems.has(record)) {
        ctx.selectedItems.delete(record);
        record.el.classList.remove('selected');
      } else {
        for (const edge of ctx.selectedEdges) edge.pathEl.classList.remove('selected');
        ctx.selectedEdges.clear();
        addToSelection(ctx, record);
      }
      e.stopPropagation();
      if (!ctx.selectedItems.has(record)) return;
    } else {
      if (!ctx.selectedItems.has(record)) selectItem(ctx, record);
    }

    e.preventDefault();
    dragging = true;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('paste-canvas-dragging');
    for (const r of ctx.items) r.el.classList.remove('toolbar-active');

    const vr = ctx.viewport.getBoundingClientRect();
    startCanvasX = (e.clientX - vr.left - ctx.panX) / ctx.scale;
    startCanvasY = (e.clientY - vr.top  - ctx.panY) / ctx.scale;
    startPositions = new Map();
    beforeDrag = new Map();
    passengers = [];
    for (const item of ctx.selectedItems) {
      const sx = parseFloat(item.el.style.left) || 0;
      const sy = parseFloat(item.el.style.top)  || 0;
      startPositions.set(item, { x: sx, y: sy });
      beforeDrag.set(item.id, { x: sx, y: sy });
      if (ctx.itemPlugins.get(item.type)?.container) {
        for (const member of ctx.items.filter(i => i.groupId === item.id)) {
          if (!ctx.selectedItems.has(member)) {
            passengers.push(member);
            const mx = parseFloat(member.el.style.left) || 0;
            const my = parseFloat(member.el.style.top)  || 0;
            startPositions.set(member, { x: mx, y: my });
            beforeDrag.set(member.id, { x: mx, y: my });
          }
        }
      }
    }
    movingItems = new Set(startPositions.keys());
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const vr = ctx.viewport.getBoundingClientRect();
    const cx = (e.clientX - vr.left - ctx.panX) / ctx.scale;
    const cy = (e.clientY - vr.top  - ctx.panY) / ctx.scale;
    const dx = cx - startCanvasX, dy = cy - startCanvasY;
    for (const [item, start] of startPositions) {
      let nx = start.x + dx;
      let ny = start.y + dy;
      if (item.groupId != null) {
        const group = ctx.itemsById.get(item.groupId);
        if (group && !movingItems.has(group)) {
          const iw = item.w || item.el.offsetWidth || 200;
          const ih = item.h || item.el.offsetHeight || 200;
          nx = Math.max(group.x, Math.min(group.x + group.w - iw, nx));
          ny = Math.max(group.y, Math.min(group.y + group.h - ih, ny));
        }
      }
      item.el.style.left = nx + 'px';
      item.el.style.top  = ny + 'px';
      item.x = nx;
      item.y = ny;
    }
    updateEdgesForItems(ctx, movingItems);
  });

  el.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('paste-canvas-dragging');
    for (const item of startPositions.keys()) void saveItem(ctx, item.id);
    const afterDrag = new Map<number, { x: number; y: number }>();
    let hasMoved = false;
    for (const [id, before] of beforeDrag) {
      const r = ctx.itemsById.get(id);
      if (!r) continue;
      afterDrag.set(id, { x: r.x, y: r.y });
      if (before.x !== r.x || before.y !== r.y) hasMoved = true;
    }
    if (hasMoved) {
      invalidateOverviewCache(ctx);
      const bd = new Map(beforeDrag);
      const ad = new Map(afterDrag);
      pushUndo(ctx, {
        label: 'move',
        undo() {
          for (const [id, pos] of bd) {
            const r = ctx.items.find(i => i.id === id);
            if (!r) continue;
            r.x = pos.x; r.y = pos.y;
            r.el.style.left = pos.x + 'px'; r.el.style.top = pos.y + 'px';
            void saveItem(ctx, r.id);
          }
          updateEdgesForItems(ctx, new Set(ctx.items.filter(i => bd.has(i.id))));
          return [...bd.keys()];
        },
        redo() {
          for (const [id, pos] of ad) {
            const r = ctx.items.find(i => i.id === id);
            if (!r) continue;
            r.x = pos.x; r.y = pos.y;
            r.el.style.left = pos.x + 'px'; r.el.style.top = pos.y + 'px';
            void saveItem(ctx, r.id);
          }
          updateEdgesForItems(ctx, new Set(ctx.items.filter(i => ad.has(i.id))));
          return [...ad.keys()];
        },
      });
    }
  });

  el.addEventListener('pointercancel', () => { dragging = false; document.body.classList.remove('paste-canvas-dragging'); });
}

// ── Duplicate selected ────────────────────────────────────────────────────────

async function cloneInto(ctx: Ctx, dst: ItemRecord, src: ItemRecord): Promise<void> {
  let stored: StoredPlugin;
  try { stored = await src.bound.serialize(); }
  catch (e) { console.error(`[paste-canvas] serialize() failed for type "${src.type}" during duplicate`, e); return; }
  dst.bound.suppressDuring(() => {
    try { dst.bound.hydrate(stored); }
    catch (e) { console.error(`[paste-canvas] hydrate() failed for type "${src.type}" during duplicate`, e); }
  });
}

export async function duplicateSelected(ctx: Ctx): Promise<void> {
  if (ctx.selectedItems.size === 0) return;
  const OFFSET = 24;

  const isContainer = (item: ItemRecord) => ctx.itemPlugins.get(item.type)?.container === true;
  const selectedContainerIds = new Set([...ctx.selectedItems].filter(isContainer).map(i => i.id));
  const toClone       = [...ctx.selectedItems].filter(i =>
    !isContainer(i) && !(i.groupId != null && selectedContainerIds.has(i.groupId))
  );
  const groupsToClone = [...ctx.selectedItems].filter(isContainer);

  clearSelection(ctx);

  const allSnaps: SnapItem[] = [];

  // Duplicate standalone non-container items
  for (const item of toClone) {
    const newRec = createItem(ctx, item.type, item.x + OFFSET, item.y + OFFSET, { skipSelect: true });
    if (item.w) { newRec.el.style.width  = item.w + 'px'; newRec.w = item.w; }
    if (item.h) { newRec.el.style.height = item.h + 'px'; newRec.h = item.h; }
    await cloneInto(ctx, newRec, item);
    void saveItem(ctx, newRec.id);
    addToSelection(ctx, newRec);
    allSnaps.push(snapItem(ctx, newRec));
  }

  // Duplicate container items with their members
  for (const group of groupsToClone) {
    const members = ctx.items.filter(i => i.groupId === group.id);
    const gw = group.w || group.el.offsetWidth;
    const gh = group.h || group.el.offsetHeight;

    const newGroup = createItem(ctx, group.type, group.x + OFFSET, group.y + OFFSET, { skipSelect: true });
    newGroup.el.style.width  = gw + 'px';
    newGroup.el.style.height = gh + 'px';
    newGroup.w = gw; newGroup.h = gh;
    await cloneInto(ctx, newGroup, group);
    addToSelection(ctx, newGroup);

    for (const member of members) {
      const newMember = createItem(ctx, member.type, member.x + OFFSET, member.y + OFFSET, { skipSelect: true });
      if (member.w) { newMember.el.style.width  = member.w + 'px'; newMember.w = member.w; }
      if (member.h) { newMember.el.style.height = member.h + 'px'; newMember.h = member.h; }
      await cloneInto(ctx, newMember, member);
      newMember.groupId = newGroup.id;
      void saveItem(ctx, newMember.id);
      addToSelection(ctx, newMember);
      allSnaps.push(snapItem(ctx, newMember));
    }

    // Group z-index must sit below all its new members
    const memberZIndices = members.map(m => parseInt(m.el.style.zIndex) || 0);
    const targetZ = memberZIndices.length > 0 ? Math.max(1, Math.min(...memberZIndices) - 1) : parseInt(newGroup.el.style.zIndex);
    newGroup.el.style.zIndex = String(targetZ);
    void saveItem(ctx, newGroup.id);
    allSnaps.push(snapItem(ctx, newGroup));
  }

  if (allSnaps.length === 0) return;
  pushUndo(ctx, {
    label: allSnaps.length === 1 ? 'duplicate' : `duplicate ${allSnaps.length} items`,
    undo() { for (const s of allSnaps) { const r = ctx.items.find(i => i.id === s.id); if (r) removeItem(ctx, r); } return []; },
    redo() { for (const s of allSnaps) restoreItemSnap(ctx, s); return allSnaps.map(s => s.id); },
  });
}

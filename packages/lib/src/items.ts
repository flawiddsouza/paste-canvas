import type { Ctx, ItemRecord, SnapItem } from './types.js';
import { pushUndo } from './history.js';
import { addToSelection, clearSelection, selectItem, viewportCenter, invalidateOverviewCache } from './canvas.js';
import { removeEdge, snapEdge, restoreEdgeSnap, updateEdgesForItems, startEdgeDrag } from './edges.js';
import { toast } from './canvas.js';

// ── Snapshots ────────────────────────────────────────────────────────────────

export function snapItem(ctx: Ctx, rec: ItemRecord): SnapItem {
  return {
    id: rec.id,
    type: rec.type,
    x: rec.x,
    y: rec.y,
    w: rec.w,
    h: rec.h,
    zIndex: parseInt(rec.el.style.zIndex) || 0,
    text:          rec.type === 'note' ? (rec.contentEl as HTMLTextAreaElement).value : undefined,
    contentWidth:  rec.type === 'note' ? rec.contentEl.offsetWidth                   : undefined,
    contentHeight: rec.type === 'note' ? rec.contentEl.offsetHeight                  : undefined,
    blobUrl:    rec.type === 'img' ? (rec.contentEl as HTMLImageElement).src                        : undefined,
    imageWidth: rec.type === 'img' ? rec.contentEl.parentElement?.offsetWidth        : undefined,
    label:      rec.type === 'img' ? (rec.labelEl?.value ?? '')                      : undefined,
  };
}

export function restoreItemSnap(ctx: Ctx, snap: SnapItem): ItemRecord {
  const rec = createItem(ctx, snap.type, snap.x, snap.y, { id: snap.id, restore: true });
  rec.el.style.zIndex = String(snap.zIndex);
  if (snap.type === 'note') {
    (rec.contentEl as HTMLTextAreaElement).value = snap.text || '';
    if (snap.contentWidth)  rec.contentEl.style.width  = snap.contentWidth  + 'px';
    if (snap.contentHeight) rec.contentEl.style.height = snap.contentHeight + 'px';
  } else {
    if (snap.w) rec.w = snap.w;
    if (snap.h) rec.h = snap.h;
    const imgEl = rec.contentEl as HTMLImageElement;
    imgEl.onload = () => {
      if (rec.mounted) {
        rec.w = rec.el.offsetWidth;
        rec.h = rec.el.offsetHeight;
      }
      updateEdgesForItems(ctx, new Set([rec]));
    };
    imgEl.src = snap.blobUrl!;
    if (snap.imageWidth) imgEl.parentElement!.style.width = snap.imageWidth + 'px';
    if (snap.label && rec.labelEl) rec.labelEl.value = snap.label;
  }
  void saveItem(ctx, rec);
  return rec;
}

// ── Persistence ───────────────────────────────────────────────────────────────

export async function saveItem(ctx: Ctx, record: ItemRecord): Promise<void> {
  if (record.mounted) {
    record.w = record.el.offsetWidth;
    record.h = record.el.offsetHeight;
  }
  const data = {
    id:     record.id,
    type:   record.type,
    tabId:  ctx.currentTabId!,
    x:      record.x,
    y:      record.y,
    w:      record.w,
    h:      record.h,
    zIndex: parseInt(record.el.style.zIndex) || 0,
  } as Parameters<typeof ctx.adapter.putItem>[0];

  if (record.type === 'img') {
    const imgEl = record.contentEl as HTMLImageElement;
    if (!imgEl.src) return;
    try {
      const res  = await fetch(imgEl.src);
      const blob = await res.blob();
      data.imageData = await blob.arrayBuffer();
      data.imageType = blob.type || 'image/png';
      data.width     = imgEl.parentElement!.offsetWidth;
      data.label     = record.labelEl ? record.labelEl.value : '';
    } catch { return; }
  } else {
    const ta = record.contentEl as HTMLTextAreaElement;
    data.text   = ta.value;
    data.width  = ta.offsetWidth;
    data.height = ta.offsetHeight;
  }
  ctx.adapter.putItem(data);
}

// ── Create item ───────────────────────────────────────────────────────────────

interface CreateItemOpts {
  id?: number;
  restore?: boolean;
  skipMount?: boolean;
}

export function createItem(
  ctx: Ctx,
  type: 'note' | 'img',
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
  el.style.zIndex = String(id);

  const inner = document.createElement('div');
  inner.className = 'item-inner';

  let contentEl: HTMLElement;
  let labelEl: HTMLTextAreaElement | undefined;

  if (type === 'img') {
    contentEl = document.createElement('img');
    inner.appendChild(contentEl);

    labelEl = document.createElement('textarea');
    labelEl.className = 'img-label';
    labelEl.placeholder = 'Label\u2026';
    labelEl.rows = 1;
    inner.appendChild(labelEl);

    const rh = document.createElement('div');
    rh.className = 'resize-handle';
    inner.appendChild(rh);

    rh.addEventListener('pointerdown', (e) => {
      if (e.button === 1) return;
      e.stopPropagation();
      e.preventDefault();
      rh.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = inner.offsetWidth;
      const onMove = (ev: PointerEvent) => {
        const dw = (ev.clientX - startX) / ctx.scale;
        inner.style.width = Math.max(80, startW + dw) + 'px';
        record.w = record.el.offsetWidth;
        record.h = record.el.offsetHeight;
        updateEdgesForItems(ctx, new Set([record]));
      };
      const onUp = () => {
        const endW = inner.offsetWidth;
        void saveItem(ctx, record);
        updateEdgesForItems(ctx, new Set([record]));
        if (endW !== startW) {
          const itemId = record.id;
          pushUndo(ctx, {
            label: 'resize',
            undo() {
              const r = ctx.items.find(i => i.id === itemId);
              if (!r) return [];
              (r.contentEl.parentElement as HTMLElement).style.width = startW + 'px';
              void saveItem(ctx, r);
              updateEdgesForItems(ctx, new Set([r]));
              return [itemId];
            },
            redo() {
              const r = ctx.items.find(i => i.id === itemId);
              if (!r) return [];
              (r.contentEl.parentElement as HTMLElement).style.width = endW + 'px';
              void saveItem(ctx, r);
              updateEdgesForItems(ctx, new Set([r]));
              return [itemId];
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
  } else {
    const handle = document.createElement('div');
    handle.className = 'note-handle';
    handle.textContent = '\u28ff\u28ff\u28ff';
    inner.appendChild(handle);
    contentEl = document.createElement('textarea');
    (contentEl as HTMLTextAreaElement).placeholder = 'Type a note\u2026';
    (contentEl as HTMLTextAreaElement).rows = 3;
    inner.appendChild(contentEl);

    const rh = document.createElement('div');
    rh.className = 'resize-handle';
    inner.appendChild(rh);

    rh.addEventListener('pointerdown', (e) => {
      if (e.button === 1) return;
      e.stopPropagation();
      e.preventDefault();
      rh.setPointerCapture(e.pointerId);
      const startX = e.clientX, startY = e.clientY;
      const startW = contentEl.offsetWidth, startH = contentEl.offsetHeight;
      const onMove = (ev: PointerEvent) => {
        const dw = (ev.clientX - startX) / ctx.scale;
        const dh = (ev.clientY - startY) / ctx.scale;
        contentEl.style.width  = Math.max(250, startW + dw) + 'px';
        contentEl.style.height = Math.max(100, startH + dh) + 'px';
        record.w = record.el.offsetWidth;
        record.h = record.el.offsetHeight;
        updateEdgesForItems(ctx, new Set([record]));
      };
      const onUp = () => {
        const endW = contentEl.offsetWidth, endH = contentEl.offsetHeight;
        void saveItem(ctx, record);
        updateEdgesForItems(ctx, new Set([record]));
        if (endW !== startW || endH !== startH) {
          const itemId = record.id;
          pushUndo(ctx, {
            label: 'resize',
            undo() {
              const r = ctx.items.find(i => i.id === itemId);
              if (!r) return [];
              r.contentEl.style.width  = startW + 'px';
              r.contentEl.style.height = startH + 'px';
              void saveItem(ctx, r);
              updateEdgesForItems(ctx, new Set([r]));
              return [itemId];
            },
            redo() {
              const r = ctx.items.find(i => i.id === itemId);
              if (!r) return [];
              r.contentEl.style.width  = endW + 'px';
              r.contentEl.style.height = endH + 'px';
              void saveItem(ctx, r);
              updateEdgesForItems(ctx, new Set([r]));
              return [itemId];
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

  // Per-item toolbar
  const itb = document.createElement('div');
  itb.className = 'item-toolbar';
  itb.addEventListener('pointerdown', (e) => { if (e.button !== 1) e.stopPropagation(); });

  if (type === 'img') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'item-btn';
    copyBtn.textContent = 'Copy Image';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void copyImage(ctx, contentEl as HTMLImageElement);
    });
    itb.appendChild(copyBtn);

    const labelBtn = document.createElement('button');
    labelBtn.className = 'item-btn';
    labelBtn.textContent = 'Label';
    labelBtn.addEventListener('click', (e) => { e.stopPropagation(); labelEl!.focus(); });
    itb.appendChild(labelBtn);
  } else {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'item-btn';
    copyBtn.textContent = 'Copy Text';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void copyText(ctx, contentEl as HTMLTextAreaElement);
    });
    itb.appendChild(copyBtn);
  }

  const delBtn = document.createElement('button');
  delBtn.className = 'item-btn danger';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const snap = snapItem(ctx, record);
    const edgeSnaps = [...(ctx.nodeEdgeMap.get(record.id) ?? [])].map(snapEdge);
    removeItem(ctx, record, { skipRevoke: true });
    pushUndo(ctx, {
      label: 'delete ' + (snap.type === 'img' ? 'image' : 'note'),
      undo() { restoreItemSnap(ctx, snap); for (const es of edgeSnaps) restoreEdgeSnap(ctx, es); return [snap.id]; },
      redo() { const r = ctx.items.find(i => i.id === snap.id); if (r) removeItem(ctx, r, { skipRevoke: true }); return []; },
      dispose() { if (snap.blobUrl && !ctx.items.find(i => i.id === snap.id)) URL.revokeObjectURL(snap.blobUrl!); },
    });
  });
  itb.appendChild(delBtn);

  el.appendChild(itb);
  el.appendChild(inner);

  // record must exist before makeDraggable + port listener closures reference it
  const record: ItemRecord = { id, el, type, x, y, w: 0, h: 0, contentEl, labelEl, mounted: false };
  ctx.items.push(record);
  ctx.itemsById.set(id, record);

  if (!opts.skipMount) {
    ctx.surface.appendChild(el);
    record.mounted = true;
    invalidateOverviewCache(ctx);
  }

  makeDraggable(ctx, record);

  if (type === 'note') {
    let noteTimer: ReturnType<typeof setTimeout> | null = null;
    contentEl.addEventListener('input', () => {
      clearTimeout(noteTimer ?? undefined);
      noteTimer = setTimeout(() => void saveItem(ctx, record), 600);
    });
  }

  if (type === 'img' && labelEl) {
    const autoGrow = () => {
      if (!labelEl!.value) {
        labelEl!.style.height = '';
      } else {
        labelEl!.style.height = 'auto';
        labelEl!.style.height = labelEl!.scrollHeight + 'px';
      }
    };
    let labelTimer: ReturnType<typeof setTimeout> | null = null;
    labelEl.addEventListener('input', () => {
      autoGrow();
      clearTimeout(labelTimer ?? undefined);
      labelTimer = setTimeout(() => void saveItem(ctx, record), 600);
    });
    record._autoGrowLabel = autoGrow;
  }

  // Port dots
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const dot = document.createElement('div');
    dot.className = `port port-${side}`;
    dot.addEventListener('pointerdown', (ev) => {
      if (ev.button === 1) return;
      ev.stopPropagation();
      ev.preventDefault();
      startEdgeDrag(ctx, record, side, ev);
    });
    el.appendChild(dot);
  }

  if (!opts.restore) {
    selectItem(ctx, record);
    if (type === 'note') {
      (contentEl as HTMLTextAreaElement).focus();
      void saveItem(ctx, record);
    }
  }

  return record;
}

// ── Remove item ───────────────────────────────────────────────────────────────

export function removeItem(ctx: Ctx, record: ItemRecord, { skipRevoke = false } = {}): void {
  const connected = ctx.nodeEdgeMap.get(record.id);
  if (connected) { for (const e of [...connected]) removeEdge(ctx, e); }
  ctx.nodeEdgeMap.delete(record.id);
  ctx.adapter.deleteItem(record.id);
  if (!skipRevoke && record.type === 'img') {
    const src = (record.contentEl as HTMLImageElement).src;
    if (src.startsWith('blob:')) URL.revokeObjectURL(src);
  }
  invalidateOverviewCache(ctx);
  record.mounted = false;
  record.el.remove();
  ctx.itemsById.delete(record.id);
  ctx.items = ctx.items.filter(i => i !== record);
  ctx.selectedItems.delete(record);
  record.el.classList.remove('selected');
}

// ── Copy helpers ──────────────────────────────────────────────────────────────

export async function copyImage(ctx: Ctx, imgEl: HTMLImageElement): Promise<void> {
  try {
    const res = await fetch(imgEl.src);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const cvs = document.createElement('canvas');
    cvs.width = bmp.width; cvs.height = bmp.height;
    cvs.getContext('2d')!.drawImage(bmp, 0, 0);
    cvs.toBlob(async (pngBlob) => {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob! })]);
      toast(ctx, 'Image copied to clipboard!');
    }, 'image/png');
  } catch (err) {
    toast(ctx, 'Copy failed: ' + (err as Error).message);
  }
}

export async function copyText(ctx: Ctx, textarea: HTMLTextAreaElement): Promise<void> {
  const text = textarea.value;
  if (!text.trim()) { toast(ctx, 'Nothing to copy'); return; }
  await navigator.clipboard.writeText(text);
  toast(ctx, 'Text copied to clipboard!');
}

// ── Image placer ──────────────────────────────────────────────────────────────

export function placeImage(ctx: Ctx, url: string): void {
  const c   = viewportCenter(ctx);
  const rec = createItem(ctx, 'img', c.x - 150, c.y - 100);
  const imgEl = rec.contentEl as HTMLImageElement;
  imgEl.onload = () => {
    const w = imgEl.naturalWidth;
    imgEl.parentElement!.style.width = w + 'px';
    rec.x = Math.round(c.x - w / 2);
    rec.y = Math.round(c.y - imgEl.naturalHeight / 2);
    rec.el.style.left = rec.x + 'px';
    rec.el.style.top  = rec.y + 'px';
    void saveItem(ctx, rec);
    const snap = snapItem(ctx, rec);
    pushUndo(ctx, {
      label: 'create image',
      _blobUrl: snap.blobUrl,
      undo() { const r = ctx.items.find(i => i.id === snap.id); if (r) removeItem(ctx, r, { skipRevoke: true }); return []; },
      redo() { restoreItemSnap(ctx, snap); return [snap.id]; },
      dispose() { if (!ctx.items.find(i => i.id === snap.id)) URL.revokeObjectURL(snap.blobUrl!); },
    });
  };
  imgEl.src = url;
}

// ── Dragging items ────────────────────────────────────────────────────────────

export function makeDraggable(ctx: Ctx, record: ItemRecord): void {
  const el = record.el;
  let dragging = false;
  let startCanvasX = 0, startCanvasY = 0;
  let startPositions: Map<ItemRecord, { x: number; y: number }>;
  let beforeDrag: Map<number, { x: number; y: number }>;

  el.addEventListener('pointerdown', (e) => {
    if (e.button === 1) return;
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

    const vr = ctx.viewport.getBoundingClientRect();
    startCanvasX = (e.clientX - vr.left - ctx.panX) / ctx.scale;
    startCanvasY = (e.clientY - vr.top  - ctx.panY) / ctx.scale;
    startPositions = new Map();
    beforeDrag = new Map();
    for (const item of ctx.selectedItems) {
      const sx = parseFloat(item.el.style.left) || 0;
      const sy = parseFloat(item.el.style.top)  || 0;
      startPositions.set(item, { x: sx, y: sy });
      beforeDrag.set(item.id, { x: sx, y: sy });
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const vr = ctx.viewport.getBoundingClientRect();
    const cx = (e.clientX - vr.left - ctx.panX) / ctx.scale;
    const cy = (e.clientY - vr.top  - ctx.panY) / ctx.scale;
    const dx = cx - startCanvasX, dy = cy - startCanvasY;
    for (const [item, start] of startPositions) {
      item.el.style.left = (start.x + dx) + 'px';
      item.el.style.top  = (start.y + dy) + 'px';
      item.x = start.x + dx;
      item.y = start.y + dy;
    }
    updateEdgesForItems(ctx, ctx.selectedItems);
  });

  el.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    for (const item of ctx.selectedItems) void saveItem(ctx, item);
    const afterDrag = new Map<number, { x: number; y: number }>();
    let hasMoved = false;
    for (const item of ctx.selectedItems) {
      const before = beforeDrag.get(item.id);
      afterDrag.set(item.id, { x: item.x, y: item.y });
      if (before && (before.x !== item.x || before.y !== item.y)) hasMoved = true;
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
            void saveItem(ctx, r);
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
            void saveItem(ctx, r);
          }
          updateEdgesForItems(ctx, new Set(ctx.items.filter(i => ad.has(i.id))));
          return [...ad.keys()];
        },
      });
    }
  });

  el.addEventListener('pointercancel', () => { dragging = false; });
}

// ── Duplicate selected ────────────────────────────────────────────────────────

export async function duplicateSelected(ctx: Ctx): Promise<void> {
  if (ctx.selectedItems.size === 0) return;
  const OFFSET = 24;
  const toClone = [...ctx.selectedItems];
  clearSelection(ctx);

  const allSnaps: SnapItem[] = [];
  const imgLoadPromises: Promise<void>[] = [];

  for (const item of toClone) {
    if (item.type === 'note') {
      const rec = createItem(ctx, 'note', item.x + OFFSET, item.y + OFFSET, { restore: true });
      (rec.contentEl as HTMLTextAreaElement).value = (item.contentEl as HTMLTextAreaElement).value;
      rec.contentEl.style.width  = item.contentEl.offsetWidth  + 'px';
      rec.contentEl.style.height = item.contentEl.offsetHeight + 'px';
      void saveItem(ctx, rec);
      addToSelection(ctx, rec);
      allSnaps.push(snapItem(ctx, rec));
    } else {
      const rec = createItem(ctx, 'img', item.x + OFFSET, item.y + OFFSET, { restore: true });
      rec.contentEl.parentElement!.style.width = item.contentEl.parentElement!.offsetWidth + 'px';
      if (item.labelEl && rec.labelEl) rec.labelEl.value = item.labelEl.value;
      addToSelection(ctx, rec);
      const p = new Promise<void>(resolve => {
        fetch((item.contentEl as HTMLImageElement).src)
          .then(r => r.blob())
          .then(blob => {
            const url = URL.createObjectURL(blob);
            (rec.contentEl as HTMLImageElement).onload = () => {
              rec.w = rec.el.offsetWidth;
              rec.h = rec.el.offsetHeight;
              void saveItem(ctx, rec);
              allSnaps.push(snapItem(ctx, rec));
              resolve();
            };
            (rec.contentEl as HTMLImageElement).src = url;
          })
          .catch(resolve);
      });
      imgLoadPromises.push(p);
    }
  }

  await Promise.all(imgLoadPromises);
  if (allSnaps.length === 0) return;
  pushUndo(ctx, {
    label: allSnaps.length === 1 ? 'duplicate' : `duplicate ${allSnaps.length} items`,
    undo()    { for (const s of allSnaps) { const r = ctx.items.find(i => i.id === s.id); if (r) removeItem(ctx, r, { skipRevoke: true }); } return []; },
    redo()    { for (const s of allSnaps) restoreItemSnap(ctx, s); return allSnaps.map(s => s.id); },
    dispose() { for (const s of allSnaps) { if (s.blobUrl && !ctx.items.find(i => i.id === s.id)) URL.revokeObjectURL(s.blobUrl!); } },
  });
}

import type { Ctx, ItemRecord, SnapItem } from './types.js';
import { pushUndo } from './history.js';
import { addToSelection, clearSelection, selectItem, viewportCenter, invalidateOverviewCache } from './canvas.js';
import { removeEdge, snapEdge, restoreEdgeSnap, updateEdgesForItems, startEdgeDrag } from './edges.js';
import { toast } from './canvas.js';

// ── Note color helper ─────────────────────────────────────────────────────────

const COLOR_HEX: Record<string, string> = {
  '1': '#ff5252',
  '2': '#ff9040',
  '3': '#ffd433',
  '4': '#44cf6e',
  '5': '#438dff',
  '6': '#a15ef4',
  '7': '#d06090',
};
const HEX_TO_SWATCH: Record<string, string> = Object.fromEntries(
  Object.entries(COLOR_HEX).map(([k, v]) => [v, k])
);

export function applyNoteColor(rec: ItemRecord, color: string | undefined): void {
  if (!color) {
    rec.el.style.removeProperty('--note-color');
    rec.el.classList.remove('colored');
  } else {
    rec.el.style.setProperty('--note-color', color);
    rec.el.classList.add('colored');
  }
}

// ── Snapshots ────────────────────────────────────────────────────────────────

export function snapItem(ctx: Ctx, rec: ItemRecord): SnapItem {
  return {
    id: rec.id,
    type: rec.type,
    x: rec.x,
    y: rec.y,
    w: rec.w,
    h: rec.h,
    zIndex:  parseInt(rec.el.style.zIndex) || 0,
    groupId: rec.groupId,
    text:          (rec.type === 'note' || rec.type === 'group') ? (rec.contentEl as HTMLTextAreaElement).value : undefined,
    contentWidth:  rec.type === 'note' ? rec.contentEl.offsetWidth  : undefined,
    contentHeight: rec.type === 'note' ? rec.contentEl.offsetHeight : undefined,
    blobUrl:    rec.type === 'img' ? (rec.contentEl as HTMLImageElement).src          : undefined,
    imageWidth: rec.type === 'img' ? rec.contentEl.parentElement?.offsetWidth        : undefined,
    label:      rec.type === 'img' ? (rec.labelEl?.value ?? '')                      : undefined,
    color:      rec.type === 'note' ? rec.color : undefined,
  };
}

export function restoreItemSnap(ctx: Ctx, snap: SnapItem): ItemRecord {
  const rec = createItem(ctx, snap.type, snap.x, snap.y, { id: snap.id, restore: true });
  rec.el.style.zIndex = String(snap.zIndex);
  rec.groupId = snap.groupId;
  if (snap.type === 'note') {
    (rec.contentEl as HTMLTextAreaElement).value = snap.text || '';
    if (snap.contentWidth)  rec.contentEl.style.width  = snap.contentWidth  + 'px';
    if (snap.contentHeight) rec.contentEl.style.height = snap.contentHeight + 'px';
    if (snap.color) { rec.color = snap.color; applyNoteColor(rec, snap.color); }
  } else if (snap.type === 'group') {
    if (snap.w) { rec.el.style.width  = snap.w + 'px'; rec.w = snap.w; }
    if (snap.h) { rec.el.style.height = snap.h + 'px'; rec.h = snap.h; }
    if (snap.text) (rec.contentEl as HTMLTextAreaElement).value = snap.text;
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
    if (snap.label && rec.labelEl) { rec.labelEl.value = snap.label; rec._autoGrowLabel?.(); rec._autoGrowLabel = undefined; }
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
    id:      record.id,
    type:    record.type,
    tabId:   ctx.currentTabId!,
    x:       record.x,
    y:       record.y,
    w:       record.w,
    h:       record.h,
    zIndex:  parseInt(record.el.style.zIndex) || 0,
    groupId: record.groupId,
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
  } else if (record.type === 'group') {
    data.text = (record.contentEl as HTMLTextAreaElement).value;
  } else {
    const ta = record.contentEl as HTMLTextAreaElement;
    data.text   = ta.value;
    data.width  = ta.offsetWidth;
    data.height = ta.offsetHeight;
    if (record.color) data.color = record.color;
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
  type: 'note' | 'img' | 'group',
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

  // ── Group items: no item-inner, label textarea is contentEl ─────────────
  if (type === 'group') {
    const groupLabel = document.createElement('textarea');
    groupLabel.className = 'group-label';
    groupLabel.placeholder = 'Label\u2026';
    groupLabel.rows = 1;
    groupLabel.spellcheck = false;

    const rh = document.createElement('div');
    rh.className = 'resize-handle';

    const itb = document.createElement('div');
    itb.className = 'item-toolbar';
    itb.addEventListener('pointerdown', (e) => { if (e.button !== 1) e.stopPropagation(); });

    const ungroupBtn = document.createElement('button');
    ungroupBtn.className = 'item-btn';
    ungroupBtn.textContent = 'Ungroup';

    const delBtn = document.createElement('button');
    delBtn.className = 'item-btn danger';
    delBtn.textContent = 'Delete';

    itb.appendChild(ungroupBtn);
    itb.appendChild(delBtn);
    el.appendChild(itb);
    el.appendChild(groupLabel);
    el.appendChild(rh);

    const record: ItemRecord = { id, el, type, x, y, w: 0, h: 0, contentEl: groupLabel, mounted: false };
    ctx.items.push(record);
    ctx.itemsById.set(id, record);

    if (!opts.skipMount) {
      ctx.surface.appendChild(el);
      record.mounted = true;
      invalidateOverviewCache(ctx);
    }

    makeDraggable(ctx, record);

    rh.addEventListener('pointerdown', (e) => {
      if (e.button === 1) return;
      e.stopPropagation();
      e.preventDefault();
      rh.setPointerCapture(e.pointerId);
      const startX = e.clientX, startY = e.clientY;
      const startW = el.offsetWidth, startH = el.offsetHeight;
      const onMove = (ev: PointerEvent) => {
        const dw = (ev.clientX - startX) / ctx.scale;
        const dh = (ev.clientY - startY) / ctx.scale;
        el.style.width  = Math.max(120, startW + dw) + 'px';
        el.style.height = Math.max(80,  startH + dh) + 'px';
        record.w = el.offsetWidth;
        record.h = el.offsetHeight;
      };
      const onUp = () => {
        const endW = el.offsetWidth, endH = el.offsetHeight;
        void saveItem(ctx, record);
        if (endW !== startW || endH !== startH) {
          const itemId = record.id;
          pushUndo(ctx, {
            label: 'resize',
            undo() {
              const r = ctx.items.find(i => i.id === itemId);
              if (!r) return [];
              r.el.style.width  = startW + 'px';
              r.el.style.height = startH + 'px';
              void saveItem(ctx, r);
              return [itemId];
            },
            redo() {
              const r = ctx.items.find(i => i.id === itemId);
              if (!r) return [];
              r.el.style.width  = endW + 'px';
              r.el.style.height = endH + 'px';
              void saveItem(ctx, r);
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

    rh.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const members = ctx.items.filter(i => i.groupId === record.id);
      if (members.length === 0) return;
      const PAD = 24;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const m of members) {
        const mw = m.w || m.el.offsetWidth || 200;
        const mh = m.h || m.el.offsetHeight || 200;
        minX = Math.min(minX, m.x); minY = Math.min(minY, m.y);
        maxX = Math.max(maxX, m.x + mw); maxY = Math.max(maxY, m.y + mh);
      }
      const newX = minX - PAD, newY = minY - PAD;
      const newW = maxX - minX + PAD * 2;
      const newH = maxY - minY + PAD * 2;
      const prevX = record.x, prevY = record.y;
      const prevW = record.w, prevH = record.h;
      if (newX === prevX && newY === prevY && newW === prevW && newH === prevH) return;
      record.x = newX; record.y = newY;
      el.style.left = newX + 'px'; el.style.top  = newY + 'px';
      el.style.width = newW + 'px'; el.style.height = newH + 'px';
      record.w = newW; record.h = newH;
      void saveItem(ctx, record);
      const itemId = record.id;
      pushUndo(ctx, {
        label: 'resize',
        undo() {
          const r = ctx.itemsById.get(itemId);
          if (!r) return [];
          r.x = prevX; r.y = prevY;
          r.el.style.left = prevX + 'px'; r.el.style.top  = prevY + 'px';
          r.el.style.width = prevW + 'px'; r.el.style.height = prevH + 'px';
          r.w = prevW; r.h = prevH;
          void saveItem(ctx, r);
          return [itemId];
        },
        redo() {
          const r = ctx.itemsById.get(itemId);
          if (!r) return [];
          r.x = newX; r.y = newY;
          r.el.style.left = newX + 'px'; r.el.style.top  = newY + 'px';
          r.el.style.width = newW + 'px'; r.el.style.height = newH + 'px';
          r.w = newW; r.h = newH;
          void saveItem(ctx, r);
          return [itemId];
        },
      });
    });

    ungroupBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const memberIds = ctx.items.filter(i => i.groupId === record.id).map(i => i.id);
      const groupSnap = snapItem(ctx, record);
      for (const mid of memberIds) {
        const m = ctx.itemsById.get(mid);
        if (m) { m.groupId = undefined; void saveItem(ctx, m); }
      }
      removeItem(ctx, record);
      pushUndo(ctx, {
        label: 'ungroup',
        undo() {
          const g = createItem(ctx, 'group', groupSnap.x, groupSnap.y, { id: groupSnap.id, restore: true });
          g.el.style.width  = (groupSnap.w || 200) + 'px';
          g.el.style.height = (groupSnap.h || 100) + 'px';
          g.w = groupSnap.w || 200; g.h = groupSnap.h || 100;
          g.el.style.zIndex = String(groupSnap.zIndex);
          if (groupSnap.text) (g.contentEl as HTMLTextAreaElement).value = groupSnap.text;
          for (const mid of memberIds) {
            const m = ctx.itemsById.get(mid);
            if (m) { m.groupId = groupSnap.id; void saveItem(ctx, m); }
          }
          void saveItem(ctx, g);
          return [groupSnap.id, ...memberIds];
        },
        redo() {
          for (const mid of memberIds) {
            const m = ctx.itemsById.get(mid);
            if (m) { m.groupId = undefined; void saveItem(ctx, m); }
          }
          const g = ctx.itemsById.get(groupSnap.id);
          if (g) removeItem(ctx, g);
          return memberIds;
        },
      });
    });

    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const snap = snapItem(ctx, record);
      const memberIds = ctx.items.filter(i => i.groupId === record.id).map(i => i.id);
      removeItem(ctx, record);
      pushUndo(ctx, {
        label: 'delete group',
        undo() {
          restoreItemSnap(ctx, snap);
          for (const mid of memberIds) {
            const m = ctx.itemsById.get(mid);
            if (m) { m.groupId = snap.id; void saveItem(ctx, m); }
          }
          return [snap.id, ...memberIds];
        },
        redo() {
          const r = ctx.itemsById.get(snap.id);
          if (r) removeItem(ctx, r);
          return [];
        },
      });
    });

    let labelTimer: ReturnType<typeof setTimeout> | null = null;
    groupLabel.addEventListener('input', () => {
      clearTimeout(labelTimer ?? undefined);
      labelTimer = setTimeout(() => void saveItem(ctx, record), 600);
    });

    if (!opts.restore) selectItem(ctx, record);

    return record;
  }

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
    labelEl.spellcheck = false;
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
    rh.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const imgEl = contentEl as HTMLImageElement;
      if (!imgEl.naturalWidth) return;
      const prevW = inner.offsetWidth;
      inner.style.width = imgEl.naturalWidth + 'px';
      const endW = inner.offsetWidth;
      record.w = record.el.offsetWidth;
      record.h = record.el.offsetHeight;
      void saveItem(ctx, record);
      updateEdgesForItems(ctx, new Set([record]));
      if (prevW !== endW) {
        const itemId = record.id;
        pushUndo(ctx, {
          label: 'resize',
          undo() {
            const r = ctx.items.find(i => i.id === itemId);
            if (!r) return [];
            (r.contentEl.parentElement as HTMLElement).style.width = prevW + 'px';
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
    });
  } else {
    const handle = document.createElement('div');
    handle.className = 'note-handle';
    handle.textContent = '\u28ff\u28ff\u28ff';
    inner.appendChild(handle);
    contentEl = document.createElement('textarea');
    (contentEl as HTMLTextAreaElement).placeholder = 'Type a note\u2026';
    (contentEl as HTMLTextAreaElement).rows = 3;
    (contentEl as HTMLTextAreaElement).spellcheck = false;
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
    rh.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const prevW = contentEl.offsetWidth, prevH = contentEl.offsetHeight;
      contentEl.style.width  = '';
      contentEl.style.height = '';
      const endW = contentEl.offsetWidth, endH = contentEl.offsetHeight;
      record.w = record.el.offsetWidth;
      record.h = record.el.offsetHeight;
      void saveItem(ctx, record);
      updateEdgesForItems(ctx, new Set([record]));
      if (prevW !== endW || prevH !== endH) {
        const itemId = record.id;
        pushUndo(ctx, {
          label: 'resize',
          undo() {
            const r = ctx.items.find(i => i.id === itemId);
            if (!r) return [];
            r.contentEl.style.width  = prevW + 'px';
            r.contentEl.style.height = prevH + 'px';
            void saveItem(ctx, r);
            updateEdgesForItems(ctx, new Set([r]));
            return [itemId];
          },
          redo() {
            const r = ctx.items.find(i => i.id === itemId);
            if (!r) return [];
            r.contentEl.style.width  = '';
            r.contentEl.style.height = '';
            void saveItem(ctx, r);
            updateEdgesForItems(ctx, new Set([r]));
            return [itemId];
          },
        });
      }
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

    // Color swatches
    const swatchSep = document.createElement('span');
    swatchSep.style.cssText = 'width:1px;height:12px;background:#555;margin:0 2px;flex-shrink:0;align-self:center';
    itb.appendChild(swatchSep);

    const COLORS = ['1','2','3','4','5','6','7'] as const;
    const swatchEls: HTMLButtonElement[] = [];

    const resetSwatch = document.createElement('button');
    resetSwatch.className = 'item-color-swatch active';
    resetSwatch.dataset.color = 'reset';
    resetSwatch.title = 'Default color';
    itb.appendChild(resetSwatch);
    swatchEls.push(resetSwatch);

    for (const c of COLORS) {
      const sw = document.createElement('button');
      sw.className = 'item-color-swatch';
      sw.dataset.color = c;
      sw.title = `Color ${c}`;
      itb.appendChild(sw);
      swatchEls.push(sw);
    }

    const activeSwatchKey = (color: string | undefined) =>
      color ? (HEX_TO_SWATCH[color] ?? color) : 'reset';

    const syncSwatches = () => {
      const key = activeSwatchKey(record.color);
      for (const sw of swatchEls) sw.classList.toggle('active', sw.dataset.color === key);
    };

    const setColor = (newColor: string | undefined) => {
      // newColor is a swatch key ("1"-"7") or undefined — convert to hex for storage
      const hexColor = newColor ? (COLOR_HEX[newColor] ?? newColor) : undefined;
      if (record.color === hexColor) return;
      const prevColor = record.color;
      const itemId = record.id;
      record.color = hexColor;
      applyNoteColor(record, hexColor);
      syncSwatches();
      void saveItem(ctx, record);
      pushUndo(ctx, {
        label: 'color',
        undo() {
          const r = ctx.itemsById.get(itemId); if (!r) return [];
          r.color = prevColor;
          applyNoteColor(r, prevColor);
          r.el.querySelectorAll<HTMLButtonElement>('.item-color-swatch').forEach(sw =>
            sw.classList.toggle('active', sw.dataset.color === activeSwatchKey(r.color)));
          void saveItem(ctx, r);
          return [itemId];
        },
        redo() {
          const r = ctx.itemsById.get(itemId); if (!r) return [];
          r.color = hexColor;
          applyNoteColor(r, hexColor);
          r.el.querySelectorAll<HTMLButtonElement>('.item-color-swatch').forEach(sw =>
            sw.classList.toggle('active', sw.dataset.color === activeSwatchKey(r.color)));
          void saveItem(ctx, r);
          return [itemId];
        },
      });
    };

    resetSwatch.addEventListener('click', (e) => { e.stopPropagation(); setColor(undefined); });
    for (const sw of swatchEls) {
      if (sw.dataset.color === 'reset') continue;
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = sw.dataset.color!;
        setColor(activeSwatchKey(record.color) === c ? undefined : c);
      });
    }
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
  if (record.type === 'group') {
    for (const member of ctx.items.filter(i => i.groupId === record.id)) {
      member.groupId = undefined;
      void saveItem(ctx, member);
    }
  }
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
      if (item.type === 'group') {
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
      item.el.style.left = (start.x + dx) + 'px';
      item.el.style.top  = (start.y + dy) + 'px';
      item.x = start.x + dx;
      item.y = start.y + dy;
    }
    updateEdgesForItems(ctx, movingItems);
  });

  el.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    for (const item of startPositions.keys()) void saveItem(ctx, item);
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

  const selectedGroupIds = new Set([...ctx.selectedItems].filter(i => i.type === 'group').map(i => i.id));
  // Standalone: not groups, and not members of a selected group
  const toClone = [...ctx.selectedItems].filter(
    i => i.type !== 'group' && !(i.groupId != null && selectedGroupIds.has(i.groupId))
  );
  const groupsToClone = [...ctx.selectedItems].filter(i => i.type === 'group');

  clearSelection(ctx);

  const allSnaps: SnapItem[] = [];
  const imgLoadPromises: Promise<void>[] = [];

  // Duplicate standalone items
  for (const item of toClone) {
    if (item.type === 'note') {
      const rec = createItem(ctx, 'note', item.x + OFFSET, item.y + OFFSET, { restore: true });
      (rec.contentEl as HTMLTextAreaElement).value = (item.contentEl as HTMLTextAreaElement).value;
      rec.contentEl.style.width  = item.contentEl.offsetWidth  + 'px';
      rec.contentEl.style.height = item.contentEl.offsetHeight + 'px';
      if (item.color) { rec.color = item.color; applyNoteColor(rec, item.color); }
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

  // Duplicate groups with their members
  for (const group of groupsToClone) {
    const members = ctx.items.filter(i => i.groupId === group.id);
    const gw = group.w || group.el.offsetWidth;
    const gh = group.h || group.el.offsetHeight;

    const newGroup = createItem(ctx, 'group', group.x + OFFSET, group.y + OFFSET, { restore: true });
    newGroup.el.style.width  = gw + 'px';
    newGroup.el.style.height = gh + 'px';
    newGroup.w = gw; newGroup.h = gh;
    const srcLabel = (group.contentEl as HTMLTextAreaElement).value;
    if (srcLabel) (newGroup.contentEl as HTMLTextAreaElement).value = srcLabel;
    addToSelection(ctx, newGroup);

    for (const member of members) {
      if (member.type === 'note') {
        const rec = createItem(ctx, 'note', member.x + OFFSET, member.y + OFFSET, { restore: true });
        (rec.contentEl as HTMLTextAreaElement).value = (member.contentEl as HTMLTextAreaElement).value;
        rec.contentEl.style.width  = member.contentEl.offsetWidth  + 'px';
        rec.contentEl.style.height = member.contentEl.offsetHeight + 'px';
        if (member.color) { rec.color = member.color; applyNoteColor(rec, member.color); }
        rec.groupId = newGroup.id;
        void saveItem(ctx, rec);
        addToSelection(ctx, rec);
        allSnaps.push(snapItem(ctx, rec));
      } else if (member.type === 'img') {
        const rec = createItem(ctx, 'img', member.x + OFFSET, member.y + OFFSET, { restore: true });
        rec.contentEl.parentElement!.style.width = member.contentEl.parentElement!.offsetWidth + 'px';
        if (member.labelEl && rec.labelEl) rec.labelEl.value = member.labelEl.value;
        rec.groupId = newGroup.id;
        addToSelection(ctx, rec);
        const p = new Promise<void>(resolve => {
          fetch((member.contentEl as HTMLImageElement).src)
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

    // Group z-index must sit below all its new members
    const memberZIndices = members.map(m => parseInt(m.el.style.zIndex) || 0);
    const targetZ = memberZIndices.length > 0 ? Math.max(1, Math.min(...memberZIndices) - 1) : parseInt(newGroup.el.style.zIndex);
    newGroup.el.style.zIndex = String(targetZ);
    void saveItem(ctx, newGroup);
    allSnaps.push(snapItem(ctx, newGroup));
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

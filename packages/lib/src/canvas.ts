import type { Ctx, ItemRecord } from './types.js';

// ── Transform ───────────────────────────────────────────────────────────────

export function applyTransform(ctx: Ctx): void {
  const t = `translate(${ctx.panX}px, ${ctx.panY}px) scale(${ctx.scale})`;
  ctx.surface.style.transform = t;
  ctx.edgeLayer.style.transform = t;
  ctx.zoomLabel.textContent = Math.round(ctx.scale * 100) + '%';
  const gs = 40 * ctx.scale;
  ctx.viewport.style.backgroundSize = `${gs}px ${gs}px`;
  ctx.viewport.style.backgroundPosition = `${ctx.panX % gs}px ${ctx.panY % gs}px`;
  ctx.coordsLabel.textContent = `${Math.round(-ctx.panX / ctx.scale)}, ${Math.round(-ctx.panY / ctx.scale)}`;
}

// ── Viewport save (debounced) ───────────────────────────────────────────────

export function saveViewport(ctx: Ctx): void {
  clearTimeout(ctx.vpSaveTimer ?? undefined);
  ctx.vpSaveTimer = setTimeout(() => {
    if (ctx.currentTabId !== null)
      ctx.adapter.saveViewport(ctx.currentTabId, { panX: ctx.panX, panY: ctx.panY, scale: ctx.scale });
  }, 500);
}

// ── Toast ───────────────────────────────────────────────────────────────────

export function toast(ctx: Ctx, msg: string, ms = 2000): void {
  ctx.toastEl.textContent = msg;
  ctx.toastEl.classList.add('show');
  clearTimeout(ctx.toastTimer ?? undefined);
  ctx.toastTimer = setTimeout(() => ctx.toastEl.classList.remove('show'), ms);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function viewportCenter(ctx: Ctx): { x: number; y: number } {
  const r = ctx.viewport.getBoundingClientRect();
  return {
    x: (r.width  / 2 - ctx.panX) / ctx.scale,
    y: (r.height / 2 - ctx.panY) / ctx.scale,
  };
}

export function fitItems(ctx: Ctx, recs: ItemRecord[] = ctx.items): void {
  if (!recs.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rec of recs) {
    const w = rec.w || rec.el.offsetWidth;
    const h = rec.h || rec.el.offsetHeight;
    minX = Math.min(minX, rec.x);     minY = Math.min(minY, rec.y);
    maxX = Math.max(maxX, rec.x + w); maxY = Math.max(maxY, rec.y + h);
  }
  const pad = 64;
  const vr = ctx.viewport.getBoundingClientRect();
  const newScale = Math.min(1, Math.max(0.1, Math.min(
    (vr.width  - pad * 2) / (maxX - minX),
    (vr.height - pad * 2) / (maxY - minY),
  )));
  ctx.scale = newScale;
  ctx.panX = vr.width  / 2 - ((minX + maxX) / 2) * newScale;
  ctx.panY = vr.height / 2 - ((minY + maxY) / 2) * newScale;
  applyTransform(ctx);
  saveViewport(ctx);
}

export function clearEdgeSelection(ctx: Ctx): void {
  for (const e of ctx.selectedEdges) e.pathEl.classList.remove('selected');
  ctx.selectedEdges.clear();
}

export function clearSelection(ctx: Ctx): void {
  for (const item of ctx.selectedItems) item.el.classList.remove('selected');
  ctx.selectedItems.clear();
  clearEdgeSelection(ctx);
}

export function addToSelection(ctx: Ctx, item: ItemRecord): void {
  ctx.selectedItems.add(item);
  item.el.classList.add('selected');
  item.el.style.zIndex = String(++ctx.itemCounter);
}

export function selectItem(ctx: Ctx, item: ItemRecord | null): void {
  clearSelection(ctx);
  if (item) addToSelection(ctx, item);
}

export function toggleSelection(ctx: Ctx, item: ItemRecord): void {
  if (ctx.selectedItems.has(item)) {
    ctx.selectedItems.delete(item);
    item.el.classList.remove('selected');
  } else {
    clearEdgeSelection(ctx);
    addToSelection(ctx, item);
  }
}

// ── Viewport interaction (pan, marquee, zoom) ───────────────────────────────

export function initViewport(ctx: Ctx): void {
  const { signal } = ctx;
  const marqueeEl = ctx.marqueeEl;
  let mode = 'idle';
  let panMoved = false;
  let px0 = 0, py0 = 0;
  let mStartX = 0, mStartY = 0;

  ctx.viewport.addEventListener('pointerdown', (e) => {
    const isMiddle = e.button === 1;
    if (!isMiddle && e.target !== ctx.viewport && e.target !== ctx.surface) return;
    px0 = e.clientX - ctx.panX;
    py0 = e.clientY - ctx.panY;

    if (!isMiddle && (e.shiftKey || e.ctrlKey)) {
      mode = 'marquee';
      panMoved = false;
      const vr = ctx.viewport.getBoundingClientRect();
      mStartX = e.clientX - vr.left;
      mStartY = e.clientY - vr.top;
      marqueeEl.style.cssText = `display:block;left:${mStartX}px;top:${mStartY}px;width:0;height:0`;
      ctx.viewport.setPointerCapture(e.pointerId);
    } else {
      mode = 'panning';
      panMoved = false;
      ctx.viewport.style.cursor = 'grabbing';
      ctx.viewport.setPointerCapture(e.pointerId);
    }
  }, { signal });

  ctx.viewport.addEventListener('pointermove', (e) => {
    if (mode === 'panning') {
      panMoved = true;
      ctx.panX = e.clientX - px0;
      ctx.panY = e.clientY - py0;
      applyTransform(ctx);
    } else if (mode === 'marquee') {
      panMoved = true;
      const vr = ctx.viewport.getBoundingClientRect();
      const cx = e.clientX - vr.left, cy = e.clientY - vr.top;
      marqueeEl.style.left   = Math.min(mStartX, cx) + 'px';
      marqueeEl.style.top    = Math.min(mStartY, cy) + 'px';
      marqueeEl.style.width  = Math.abs(cx - mStartX) + 'px';
      marqueeEl.style.height = Math.abs(cy - mStartY) + 'px';
    }
  }, { signal });

  ctx.viewport.addEventListener('pointerup', (e) => {
    if (mode === 'panning') {
      if (!panMoved) clearSelection(ctx);
      if (panMoved)  saveViewport(ctx);
      ctx.viewport.style.cursor = 'default';
    } else if (mode === 'marquee') {
      marqueeEl.style.display = 'none';
      const vr  = ctx.viewport.getBoundingClientRect();
      const cx  = e.clientX - vr.left, cy = e.clientY - vr.top;
      const rx1 = Math.min(mStartX, cx), ry1 = Math.min(mStartY, cy);
      const rx2 = Math.max(mStartX, cx), ry2 = Math.max(mStartY, cy);
      if (rx2 - rx1 > 4 || ry2 - ry1 > 4) {
        clearSelection(ctx);
        for (const item of ctx.items) {
          const ir = item.el.getBoundingClientRect();
          if (ir.right > vr.left + rx1 && ir.left < vr.left + rx2 &&
              ir.bottom > vr.top + ry1 && ir.top < vr.top + ry2) {
            addToSelection(ctx, item);
          }
        }
        for (const edge of ctx.edges) {
          const bbox = edge.pathEl.getBoundingClientRect();
          if (bbox.right  > vr.left + rx1 && bbox.left   < vr.left + rx2 &&
              bbox.bottom > vr.top  + ry1 && bbox.top    < vr.top  + ry2) {
            ctx.selectedEdges.add(edge);
            edge.pathEl.classList.add('selected');
          }
        }
      } else {
        clearSelection(ctx);
      }
    }
    mode = 'idle';
    panMoved = false;
  }, { signal });

  ctx.viewport.addEventListener('pointercancel', () => {
    marqueeEl.style.display = 'none';
    ctx.viewport.style.cursor = 'default';
    mode = 'idle';
    panMoved = false;
  }, { signal });

  window.addEventListener('blur', () => {
    marqueeEl.style.display = 'none';
    ctx.viewport.style.cursor = 'default';
    mode = 'idle';
    panMoved = false;
  }, { signal });

  ctx.viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta    = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(5, Math.max(0.1, ctx.scale * delta));
    const vr = ctx.viewport.getBoundingClientRect();
    const mx = e.clientX - vr.left;
    const my = e.clientY - vr.top;
    ctx.panX = mx - (mx - ctx.panX) * (newScale / ctx.scale);
    ctx.panY = my - (my - ctx.panY) * (newScale / ctx.scale);
    ctx.scale = newScale;
    applyTransform(ctx);
    saveViewport(ctx);
  }, { passive: false, signal });
}

// ── Toolbar hover hit-test ──────────────────────────────────────────────────

export function initToolbarHover(ctx: Ctx): void {
  const { signal } = ctx;
  ctx.viewport.addEventListener('pointermove', (e) => {
    for (const record of ctx.items) {
      const rect = record.el.getBoundingClientRect();
      const inZone = e.clientX >= rect.left && e.clientX <= rect.right &&
                     e.clientY >= rect.top - 36 && e.clientY <= rect.bottom;
      record.el.classList.toggle('toolbar-active', inZone);
    }
  }, { signal });
  ctx.viewport.addEventListener('pointerleave', () => {
    for (const record of ctx.items) record.el.classList.remove('toolbar-active');
  }, { signal });
}

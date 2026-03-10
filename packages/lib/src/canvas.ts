import type { Ctx, ItemRecord } from './types.js';

// ── Transform ───────────────────────────────────────────────────────────────

export function applyTransform(ctx: Ctx): void {
  // Snap translation to physical-pixel boundaries so images & text don't render on
  // sub-pixel offsets (which causes blur, especially noticeable on images).
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round(ctx.panX * dpr) / dpr;
  const py = Math.round(ctx.panY * dpr) / dpr;
  const t = `translate(${px}px, ${py}px) scale(${ctx.scale})`;
  ctx.surface.style.transform = t;
  ctx.zoomLabel.textContent = Math.round(ctx.scale * 100) + '%';
  const gs = 40 * ctx.scale;
  ctx.viewport.style.backgroundSize = `${gs}px ${gs}px`;
  ctx.viewport.style.backgroundPosition = `${px % gs}px ${py % gs}px`;
  ctx.coordsLabel.textContent = `${Math.round(-ctx.panX / ctx.scale)}, ${Math.round(-ctx.panY / ctx.scale)}`;
  updateCulling(ctx);
}

// ── Viewport save (debounced) ───────────────────────────────────────────────

export function saveViewport(ctx: Ctx): void {
  clearTimeout(ctx.vpSaveTimer ?? undefined);
  ctx.vpSaveTimer = setTimeout(() => {
    if (ctx.currentTabId !== null)
      ctx.adapter.saveViewport(ctx.currentTabId, { panX: ctx.panX, panY: ctx.panY, scale: ctx.scale });
  }, 500);
}

// ── Confirm dialog ──────────────────────────────────────────────────────────

export function showConfirm(ctx: Ctx, message: string, confirmLabel = 'Confirm'): Promise<boolean> {
  return new Promise(resolve => {
    const root = ctx.tabBar.parentElement!;

    const overlay = document.createElement('div');
    overlay.className = 'pc-confirm-modal';

    const dialog = document.createElement('div');
    dialog.className = 'pc-confirm-dialog';

    const msg = document.createElement('p');
    msg.className = 'pc-confirm-msg';
    msg.innerHTML = message;

    const btns = document.createElement('div');
    btns.className = 'pc-confirm-btns';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn pc-confirm-ok';
    confirmBtn.textContent = confirmLabel;

    const done = (result: boolean) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };

    cancelBtn.addEventListener('click', () => done(false));
    confirmBtn.addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey);

    btns.appendChild(cancelBtn);
    btns.appendChild(confirmBtn);
    dialog.appendChild(msg);
    dialog.appendChild(btns);
    overlay.appendChild(dialog);
    root.appendChild(overlay);

    cancelBtn.focus();
  });
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
  const newScale = Math.min(1, Math.max(0.01, Math.min(
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
  ctx.editingEdge?.inputEl?.blur();
}

export function addToSelection(ctx: Ctx, item: ItemRecord): void {
  ctx.selectedItems.add(item);
  item.el.classList.add('selected');
  if (item.type !== 'group') {
    item.el.style.zIndex = String(++ctx.zCounter);
    for (const edge of (ctx.nodeEdgeMap.get(item.id) ?? [])) {
      if (edge.toNode === item.id) edge.svgEl.style.zIndex = item.el.style.zIndex;
    }
  }
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
        const canvasX1 = (rx1 - ctx.panX) / ctx.scale;
        const canvasY1 = (ry1 - ctx.panY) / ctx.scale;
        const canvasX2 = (rx2 - ctx.panX) / ctx.scale;
        const canvasY2 = (ry2 - ctx.panY) / ctx.scale;

        clearSelection(ctx);
        for (const item of ctx.items) {
          const iw = item.w || 200;
          const ih = item.h || 200;
          if (item.x + iw > canvasX1 && item.x < canvasX2 &&
              item.y + ih > canvasY1 && item.y < canvasY2) {
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
    const px       = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 600 : e.deltaY;
    const delta    = Math.pow(0.999, px);
    const newScale = Math.min(5, Math.max(0.01, ctx.scale * delta));
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
    const vr = ctx.viewport.getBoundingClientRect();
    const cx = (e.clientX - vr.left - ctx.panX) / ctx.scale;
    const cy = (e.clientY - vr.top  - ctx.panY) / ctx.scale;
    for (const record of ctx.items) {
      if (!record.mounted) {
        record.el.classList.remove('toolbar-active');
        continue;
      }
      const w = record.w || record.el.offsetWidth;
      const h = record.h || record.el.offsetHeight;
      const inZone = (cx >= record.x && cx <= record.x + w &&
                      cy >= record.y - 36 / ctx.scale && cy <= record.y + h)
                  || record.el.contains(e.target as Node);
      record.el.classList.toggle('toolbar-active', inZone);
    }
  }, { signal });
  ctx.viewport.addEventListener('pointerleave', () => {
    for (const record of ctx.items) record.el.classList.remove('toolbar-active');
  }, { signal });
}

const OVERVIEW_SCALE        = 0.25;
const LOD_SCALE             = 0.5;
const OVERVIEW_RENDER_SCALE = 0.1; // render cache at 10% – one-time cost, then CSS transform for pan/zoom

// Per-canvas cache state (WeakMap so it's GC-safe across destroy/recreate cycles)
const overviewCache = new WeakMap<HTMLCanvasElement, { minX: number; minY: number; renderScale: number }>();

function buildOverviewCache(ctx: Ctx): void {
  const canvas = ctx.overviewCanvas;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const item of ctx.items) {
    const w = item.w || 200, h = item.h || 200;
    minX = Math.min(minX, item.x); maxX = Math.max(maxX, item.x + w);
    minY = Math.min(minY, item.y); maxY = Math.max(maxY, item.y + h);
  }
  if (!isFinite(minX)) return;
  const MAX_CACHE_PX = 4096;
  const fitScale = Math.min(OVERVIEW_RENDER_SCALE,
    MAX_CACHE_PX / Math.max(maxX - minX, maxY - minY));
  canvas.width  = Math.max(1, Math.ceil((maxX - minX) * fitScale));
  canvas.height = Math.max(1, Math.ceil((maxY - minY) * fitScale));
  const c2d = canvas.getContext('2d')!;
  c2d.save();
  c2d.scale(fitScale, fitScale);
  c2d.translate(-minX, -minY);
  for (const item of ctx.items) {
    const iw = item.w || 200, ih = item.h || 200;
    if (item.type === 'group') {
      c2d.fillStyle = 'rgba(255, 200, 60, 0.07)';
      c2d.fillRect(item.x, item.y, iw, ih);
      c2d.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      c2d.lineWidth = 2;
      c2d.strokeRect(item.x, item.y, iw, ih);
    } else if (item.type === 'img') {
      const img = item.contentEl as HTMLImageElement;
      if (img.complete && img.naturalWidth > 0) {
        c2d.drawImage(img, item.x, item.y, iw, ih);
      } else {
        c2d.fillStyle = '#333';
        c2d.fillRect(item.x, item.y, iw, ih);
      }
    } else {
      c2d.fillStyle = '#2b2b1e';
      c2d.fillRect(item.x, item.y, iw, ih);
    }
  }
  c2d.restore();
  overviewCache.set(canvas, { minX, minY, renderScale: fitScale });
}

export function invalidateOverviewCache(ctx: Ctx): void {
  overviewCache.delete(ctx.overviewCanvas);
}

export function updateCulling(ctx: Ctx): void {
  if (!ctx.items.length) {
    ctx.surface.classList.remove('overview-lod');
    ctx.surface.style.display = '';
    ctx.overviewCanvas.style.display = 'none';
    return;
  }
  const vr = ctx.viewport.getBoundingClientRect();
  if (vr.width === 0 || vr.height === 0) return;

  ctx.surface.classList.toggle('overview-lod', ctx.scale < LOD_SCALE);

  if (ctx.scale < OVERVIEW_SCALE) {
    ctx.surface.style.display = 'none';
    ctx.overviewCanvas.style.display = 'block';
    if (!overviewCache.has(ctx.overviewCanvas)) buildOverviewCache(ctx);
    const cache = overviewCache.get(ctx.overviewCanvas);
    if (cache) {
      const ds = ctx.scale / cache.renderScale;
      ctx.overviewCanvas.style.transform =
        `translate(${ctx.panX + cache.minX * ctx.scale}px,${ctx.panY + cache.minY * ctx.scale}px) scale(${ds})`;
    }
    return;
  }

  ctx.surface.style.display = '';
  ctx.overviewCanvas.style.display = 'none';

  const BUFFER = 0.5;
  const bufW = vr.width  * BUFFER;
  const bufH = vr.height * BUFFER;
  const left   = (-ctx.panX - bufW) / ctx.scale;
  const top    = (-ctx.panY - bufH) / ctx.scale;
  const right  = (vr.width  - ctx.panX + bufW) / ctx.scale;
  const bottom = (vr.height - ctx.panY + bufH) / ctx.scale;

  for (const item of ctx.items) {
    const w = item.w || 200;
    const h = item.h || 200;
    const visible =
      item.x + w > left && item.x < right &&
      item.y + h > top  && item.y < bottom;
    if (visible && !item.mounted) {
      ctx.surface.appendChild(item.el);
      item.mounted = true;
      item._autoGrowLabel?.();
      item._autoGrowLabel = undefined;
    } else if (!visible && item.mounted) {
      item.el.remove();
      item.mounted = false;
    }
  }
}

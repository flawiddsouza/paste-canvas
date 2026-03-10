import type { Ctx, EdgeRecord, ItemRecord, Side, SnapEdge } from './types.js';
import { pushUndo } from './history.js';
import { clearSelection } from './canvas.js';

// ── Port position ────────────────────────────────────────────────────────────

export function getPortPos(record: ItemRecord, side: Side): { x: number; y: number } {
  const x = record.x;
  const y = record.y;
  const w = record.w || record.el.offsetWidth;
  const h = record.h || record.el.offsetHeight;
  switch (side) {
    case 'top':    return { x: x + w / 2, y };
    case 'right':  return { x: x + w,     y: y + h / 2 };
    case 'bottom': return { x: x + w / 2, y: y + h };
    case 'left':   return { x,             y: y + h / 2 };
  }
}

// ── Path generation ──────────────────────────────────────────────────────────

function bezierPoints(
  from: { x: number; y: number }, fromSide: Side,
  to:   { x: number; y: number }, toSide: Side,
): { cp1x: number; cp1y: number; cp2x: number; cp2y: number } {
  const dist   = Math.hypot(to.x - from.x, to.y - from.y);
  const offset = Math.min(Math.max(dist * 0.4, 40), 200);
  const dirs: Record<Side, [number, number]> = {
    top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0],
  };
  const [fdx, fdy] = dirs[fromSide];
  const [tdx, tdy] = dirs[toSide];
  return {
    cp1x: from.x + fdx * offset, cp1y: from.y + fdy * offset,
    cp2x: to.x   + tdx * offset, cp2y: to.y   + tdy * offset,
  };
}

export function edgePathD(
  from: { x: number; y: number }, fromSide: Side,
  to:   { x: number; y: number }, toSide: Side,
): string {
  const { cp1x, cp1y, cp2x, cp2y } = bezierPoints(from, fromSide, to, toSide);
  return `M ${from.x} ${from.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.x} ${to.y}`;
}

// ── Bezier midpoint ──────────────────────────────────────────────────────────

export function edgeMidpoint(
  from: { x: number; y: number }, fromSide: Side,
  to:   { x: number; y: number }, toSide: Side,
): { x: number; y: number } {
  const { cp1x, cp1y, cp2x, cp2y } = bezierPoints(from, fromSide, to, toSide);
  return {
    x: 0.125 * from.x + 0.375 * cp1x + 0.375 * cp2x + 0.125 * to.x,
    y: 0.125 * from.y + 0.375 * cp1y + 0.375 * cp2y + 0.125 * to.y,
  };
}

// ── Update / render ──────────────────────────────────────────────────────────

export function updateEdgePath(ctx: Ctx, edgeRec: EdgeRecord): void {
  const fromRec = ctx.itemsById.get(edgeRec.fromNode);
  const toRec   = ctx.itemsById.get(edgeRec.toNode);
  if (!fromRec || !toRec) return;
  const from = getPortPos(fromRec, edgeRec.fromSide);
  const to   = getPortPos(toRec,   edgeRec.toSide);
  const d = edgePathD(from, edgeRec.fromSide, to, edgeRec.toSide);
  edgeRec.pathEl.setAttribute('d', d);
  edgeRec.hitEl.setAttribute('d', d);
  if (edgeRec.labelTextEl || edgeRec.inputEl) {
    const raw = edgeMidpoint(from, edgeRec.fromSide, to, edgeRec.toSide);
    const mx  = Math.round(raw.x);
    const my  = Math.round(raw.y);
    if (edgeRec.labelTextEl) {
      edgeRec.labelTextEl.setAttribute('x', String(mx));
      edgeRec.labelTextEl.setAttribute('y', String(my));
    }
    if (edgeRec.inputEl) {
      edgeRec.inputEl.style.left = (mx - 60) + 'px';
      edgeRec.inputEl.style.top  = (my - 14) + 'px';
    }
  }
}

export function renderEdge(ctx: Ctx, edgeRec: EdgeRecord): void {
  const NS   = 'http://www.w3.org/2000/svg';
  const svg  = document.createElementNS(NS, 'svg');
  const path = document.createElementNS(NS, 'path');
  const hit  = document.createElementNS(NS, 'path');
  path.setAttribute('class', 'edge-path');
  path.setAttribute('marker-end', `url(#${ctx.arrowheadId})`);
  hit.setAttribute('class', 'edge-hit');

  // SVG text for display
  const labelText = document.createElementNS(NS, 'text');
  labelText.setAttribute('class', 'edge-label-text');
  labelText.setAttribute('text-anchor', 'middle');
  labelText.setAttribute('dominant-baseline', 'middle');
  if (edgeRec.label) labelText.textContent = edgeRec.label;

  svg.appendChild(path);
  svg.appendChild(hit);
  svg.appendChild(labelText);
  svg.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;overflow:visible;pointer-events:none';
  const toRec = ctx.itemsById.get(edgeRec.toNode);
  svg.style.zIndex = toRec ? toRec.el.style.zIndex : '0';
  ctx.edgeLayer.after(svg);
  edgeRec.svgEl       = svg;
  edgeRec.pathEl      = path;
  edgeRec.hitEl       = hit;
  edgeRec.labelTextEl = labelText;

  // HTML input for editing only (in canvas-space on the surface, hidden until editing)
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.className = 'edge-label-input';
  ctx.surface.appendChild(input);
  edgeRec.inputEl = input;

  let prevLabel = '';

  hit.addEventListener('click', (e) => {
    e.stopPropagation();
    selectEdge(ctx, edgeRec, e.shiftKey || e.ctrlKey);
  });

  hit.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    selectEdge(ctx, edgeRec);
    prevLabel = edgeRec.label ?? '';
    input.value = prevLabel;
    input.style.zIndex = String(ctx.zCounter + 1);
    labelText.style.display = 'none';
    input.classList.add('editing');
    ctx.editingEdge = edgeRec;
    input.focus();
    input.select();
  });

  const commitLabel = () => {
    const newLabel = input.value.trim();
    edgeRec.label = newLabel || undefined;
    labelText.textContent = newLabel;
    labelText.style.display = '';
    input.classList.remove('editing');
    ctx.editingEdge = undefined;
    saveEdge(ctx, edgeRec);
    if (newLabel !== prevLabel) {
      const edgeId = edgeRec.id;
      const captured = { prev: prevLabel, next: newLabel };
      const applyLabel = (value: string) => {
        const er = ctx.edges.find(e => e.id === edgeId);
        if (!er) return [];
        er.label = value || undefined;
        if (er.labelTextEl) er.labelTextEl.textContent = value;
        if (er.inputEl) er.inputEl.value = value;
        saveEdge(ctx, er);
        return [];
      };
      pushUndo(ctx, {
        label: 'label edge',
        undo() { return applyLabel(captured.prev); },
        redo() { return applyLabel(captured.next); },
      });
    }
  };

  input.addEventListener('blur', commitLabel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = edgeRec.label ?? ''; input.blur(); }
    e.stopPropagation();
  });

  updateEdgePath(ctx, edgeRec);
}

export function selectEdge(ctx: Ctx, edgeRec: EdgeRecord, multi = false): void {
  for (const item of ctx.selectedItems) item.el.classList.remove('selected');
  ctx.selectedItems.clear();
  if (!multi) {
    for (const e of ctx.selectedEdges) e.pathEl.classList.remove('selected');
    ctx.selectedEdges.clear();
  }
  if (edgeRec) {
    if (multi && ctx.selectedEdges.has(edgeRec)) {
      ctx.selectedEdges.delete(edgeRec);
      edgeRec.pathEl.classList.remove('selected');
    } else {
      ctx.selectedEdges.add(edgeRec);
      edgeRec.pathEl.classList.add('selected');
    }
  }
}

export function updateEdgesForItems(ctx: Ctx, itemSet: Set<ItemRecord>): void {
  const seen = new Set<EdgeRecord>();
  for (const item of itemSet) {
    const connected = ctx.nodeEdgeMap.get(item.id);
    if (!connected) continue;
    for (const edgeRec of connected) {
      if (!seen.has(edgeRec)) { seen.add(edgeRec); updateEdgePath(ctx, edgeRec); }
    }
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────

export function saveEdge(ctx: Ctx, edgeRec: EdgeRecord): void {
  ctx.adapter.putEdge({
    id: edgeRec.id, tabId: edgeRec.tabId,
    fromNode: edgeRec.fromNode, fromSide: edgeRec.fromSide,
    toNode:   edgeRec.toNode,   toSide:   edgeRec.toSide,
    label:    edgeRec.label,
  });
}

// ── Snapshots ────────────────────────────────────────────────────────────────

export function snapEdge(er: EdgeRecord): SnapEdge {
  return {
    id: er.id, tabId: er.tabId,
    fromNode: er.fromNode, fromSide: er.fromSide,
    toNode:   er.toNode,   toSide:   er.toSide,
    label:    er.label,
  };
}

export function restoreEdgeSnap(ctx: Ctx, snap: SnapEdge): EdgeRecord | null {
  const fromRec = ctx.itemsById.get(snap.fromNode);
  const toRec   = ctx.itemsById.get(snap.toNode);
  if (!fromRec || !toRec) return null;
  const er = { ...snap } as EdgeRecord;
  ctx.edges.push(er);
  if (!ctx.nodeEdgeMap.has(fromRec.id)) ctx.nodeEdgeMap.set(fromRec.id, new Set());
  if (!ctx.nodeEdgeMap.has(toRec.id))   ctx.nodeEdgeMap.set(toRec.id,   new Set());
  ctx.nodeEdgeMap.get(fromRec.id)!.add(er);
  ctx.nodeEdgeMap.get(toRec.id)!.add(er);
  renderEdge(ctx, er);
  saveEdge(ctx, er);
  return er;
}

// ── Create / remove ───────────────────────────────────────────────────────────

export function createEdge(
  ctx: Ctx,
  fromRec: ItemRecord, fromSide: Side,
  toRec: ItemRecord,   toSide: Side,
): void {
  if (fromRec === toRec) return;
  if (ctx.edges.find(e =>
    e.fromNode === fromRec.id && e.toNode === toRec.id &&
    e.fromSide === fromSide   && e.toSide === toSide)) return;

  const edgeRec = {
    id: ++ctx.edgeCounter, tabId: ctx.currentTabId!,
    fromNode: fromRec.id, fromSide, toNode: toRec.id, toSide,
  } as EdgeRecord;
  ctx.edges.push(edgeRec);
  if (!ctx.nodeEdgeMap.has(fromRec.id)) ctx.nodeEdgeMap.set(fromRec.id, new Set());
  if (!ctx.nodeEdgeMap.has(toRec.id))   ctx.nodeEdgeMap.set(toRec.id,   new Set());
  ctx.nodeEdgeMap.get(fromRec.id)!.add(edgeRec);
  ctx.nodeEdgeMap.get(toRec.id)!.add(edgeRec);
  renderEdge(ctx, edgeRec);
  saveEdge(ctx, edgeRec);
  const snap = snapEdge(edgeRec);
  pushUndo(ctx, {
    label: 'connect',
    undo() {
      const er = ctx.edges.find(e => e.id === snap.id);
      if (er) removeEdge(ctx, er);
      return [snap.fromNode, snap.toNode];
    },
    redo() { restoreEdgeSnap(ctx, snap); return [snap.fromNode, snap.toNode]; },
  });
}

export function removeEdge(ctx: Ctx, edgeRec: EdgeRecord): void {
  edgeRec.svgEl.remove();
  edgeRec.inputEl?.remove();
  ctx.edges = ctx.edges.filter(e => e !== edgeRec);
  ctx.nodeEdgeMap.get(edgeRec.fromNode)?.delete(edgeRec);
  ctx.nodeEdgeMap.get(edgeRec.toNode)?.delete(edgeRec);
  ctx.selectedEdges.delete(edgeRec);
  ctx.adapter.deleteEdge(edgeRec.id);
}

// ── Drop target detection ─────────────────────────────────────────────────────

export function findDropTarget(
  ctx: Ctx,
  clientX: number, clientY: number,
  excludeRecord: ItemRecord,
): { record: ItemRecord; side: Side } | null {
  const vr = ctx.viewport.getBoundingClientRect();
  const cx = (clientX - vr.left - ctx.panX) / ctx.scale;
  const cy = (clientY - vr.top  - ctx.panY) / ctx.scale;
  for (const item of ctx.items) {
    if (item === excludeRecord || !item.mounted) continue;
    const w = item.w || 200;
    const h = item.h || 200;
    if (cx >= item.x && cx <= item.x + w && cy >= item.y && cy <= item.y + h) {
      const relX = (cx - item.x) / w;
      const relY = (cy - item.y) / h;
      const dists: Record<Side, number> = {
        top: relY, bottom: 1 - relY, left: relX, right: 1 - relX,
      };
      const side = (Object.entries(dists).sort(([, a], [, b]) => a - b)[0][0]) as Side;
      return { record: item, side };
    }
  }
  return null;
}

// ── Interactive edge drag ─────────────────────────────────────────────────────

export function startEdgeDrag(ctx: Ctx, fromRecord: ItemRecord, fromSide: Side, e: PointerEvent): void {
  clearSelection(ctx);
  const pid = e.pointerId;
  const preview = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  preview.setAttribute('class', 'edge-preview');
  ctx.edgeLayer.appendChild(preview);

  const oppSide: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pid) return;
    const vr = ctx.viewport.getBoundingClientRect();
    const cx = (ev.clientX - vr.left - ctx.panX) / ctx.scale;
    const cy = (ev.clientY - vr.top  - ctx.panY) / ctx.scale;
    const from   = getPortPos(fromRecord, fromSide);
    const target = findDropTarget(ctx, ev.clientX, ev.clientY, fromRecord);
    const to     = target ? getPortPos(target.record, target.side) : { x: cx, y: cy };
    const toSide = target ? target.side : oppSide[fromSide];
    preview.setAttribute('d', edgePathD(from, fromSide, to, toSide));
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pid) return;
    preview.remove();
    const target = findDropTarget(ctx, ev.clientX, ev.clientY, fromRecord);
    if (target) createEdge(ctx, fromRecord, fromSide, target.record, target.side);
    document.removeEventListener('pointermove',   onMove);
    document.removeEventListener('pointerup',     onUp);
    document.removeEventListener('pointercancel', onUp);
  };

  document.addEventListener('pointermove',   onMove);
  document.addEventListener('pointerup',     onUp);
  document.addEventListener('pointercancel', onUp);
}

import type { Ctx, ItemRecord, EdgeRecord } from './types.js';
import { saveItem, createItem, snapItem, restoreItemSnap, removeItem } from './items.js';
import { clearSelection, selectItem } from './canvas.js';
import { pushUndo } from './history.js';

// ── Target detection ─────────────────────────────────────────────────────────

type MenuTarget =
  | { type: 'item';   record: ItemRecord }
  | { type: 'edge';   record: EdgeRecord }
  | { type: 'canvas'; canvasX: number; canvasY: number };

function findTarget(ctx: Ctx, e: MouseEvent): MenuTarget {
  // SVG hit elements belong to edges
  for (const edge of ctx.edges) {
    if (edge.hitEl === e.target) return { type: 'edge', record: edge };
  }
  // Walk up the DOM to find an item root div
  let el = e.target as HTMLElement | null;
  while (el && el !== ctx.viewport) {
    if (el.classList?.contains('item')) {
      const item = ctx.items.find(i => i.el === el);
      if (item) return { type: 'item', record: item };
    }
    el = el.parentElement;
  }
  const rect = ctx.viewport.getBoundingClientRect();
  return {
    type: 'canvas',
    canvasX: (e.clientX - rect.left - ctx.panX) / ctx.scale,
    canvasY: (e.clientY - rect.top  - ctx.panY) / ctx.scale,
  };
}

// ── Z-order operations ───────────────────────────────────────────────────────

function restoreZMap(ctx: Ctx, map: Map<number, number>): number[] {
  for (const [id, z] of map) {
    const r = ctx.itemsById.get(id); if (!r) continue;
    r.el.style.zIndex = String(z);
    void saveItem(ctx, r);
  }
  return [...map.keys()];
}

function applyZIndexChange(
  ctx: Ctx,
  items: ItemRecord[],
  label: string,
  apply: (item: ItemRecord) => void,
): void {
  const before = new Map(items.map(i => [i.id, parseInt(i.el.style.zIndex) || 0]));
  for (const item of items) {
    if (item.type === 'group') continue;
    apply(item);
    void saveItem(ctx, item);
  }
  const after = new Map(items.map(i => [i.id, parseInt(i.el.style.zIndex) || 0]));
  pushUndo(ctx, {
    label,
    undo() { return restoreZMap(ctx, before); },
    redo() { return restoreZMap(ctx, after); },
  });
}

function syncEdgeZ(ctx: Ctx, item: ItemRecord, z: string): void {
  for (const edge of (ctx.nodeEdgeMap.get(item.id) ?? [])) {
    if (edge.toNode === item.id) edge.svgEl.style.zIndex = z;
  }
}

function bringToFront(ctx: Ctx, items: ItemRecord[]): void {
  applyZIndexChange(ctx, items, 'bring to front', (item) => {
    const z = String(++ctx.itemCounter);
    item.el.style.zIndex = z;
    syncEdgeZ(ctx, item, z);
  });
}

function sendToBack(ctx: Ctx, items: ItemRecord[]): void {
  const itemIds = new Set(items.map(i => i.id));
  const others  = ctx.items.filter(i => !itemIds.has(i.id) && i.type !== 'group');
  const minZ    = others.length > 0
    ? others.reduce((m, i) => Math.min(m, parseInt(i.el.style.zIndex) || 1), Infinity)
    : 1;
  const z = String(Math.max(1, isFinite(minZ) ? minZ - 1 : 1));
  applyZIndexChange(ctx, items, 'send to back', (item) => {
    item.el.style.zIndex = z;
    syncEdgeZ(ctx, item, z);
  });
}

// ── Public init ──────────────────────────────────────────────────────────────

export function initContextMenu(
  ctx: Ctx,
  deleteItems: () => void,
  deleteEdges: () => void,
): void {
  const root = ctx.tabBar.parentElement!;
  const menu = document.createElement('div');
  menu.className = 'pc-context-menu';
  menu.hidden = true;
  root.appendChild(menu);

  function hide(): void {
    menu.hidden = true;
    menu.innerHTML = '';
  }

  function addEntry(label: string, danger: boolean, onClick: () => void): void {
    const btn = document.createElement('button');
    btn.className = 'pc-ctx-item' + (danger ? ' danger' : '');
    btn.textContent = label;
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); hide(); onClick(); });
    menu.appendChild(btn);
  }

  function addSep(): void {
    const sep = document.createElement('div');
    sep.className = 'pc-ctx-sep';
    menu.appendChild(sep);
  }

  ctx.viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    hide();

    const target = findTarget(ctx, e);

    if (target.type === 'item') {
      const clicked = target.record;
      if (!ctx.selectedItems.has(clicked)) selectItem(ctx, clicked);
      const targets  = [...ctx.selectedItems];
      const hasItems = targets.some(i => i.type !== 'group');

      if (hasItems) {
        addEntry('Bring to Front', false, () => bringToFront(ctx, targets));
        addEntry('Send to Back',   false, () => sendToBack(ctx, targets));
        addSep();
      }

      const delLabel = targets.length === 1
        ? `Delete ${targets[0].type === 'img' ? 'Image' : targets[0].type === 'group' ? 'Group' : 'Note'}`
        : `Delete ${targets.length} Items`;
      addEntry(delLabel, true, deleteItems);

    } else if (target.type === 'edge') {
      const edge = target.record;
      if (!ctx.selectedEdges.has(edge)) {
        clearSelection(ctx);
        ctx.selectedEdges.add(edge);
        edge.pathEl.classList.add('selected');
      }
      addEntry('Delete Connection', true, deleteEdges);

    } else {
      const { canvasX, canvasY } = target;
      addEntry('Add Note Here', false, () => {
        const rec  = createItem(ctx, 'note', canvasX - 90, canvasY - 40);
        const snap = snapItem(ctx, rec);
        pushUndo(ctx, {
          label: 'create note',
          undo() { const r = ctx.items.find(i => i.id === snap.id); if (r) removeItem(ctx, r); return []; },
          redo() { restoreItemSnap(ctx, snap); return [snap.id]; },
        });
      });
    }

    // Show and clamp to screen edges
    menu.hidden = false;
    menu.style.left = e.clientX + 'px';
    menu.style.top  = e.clientY + 'px';
    const mr = menu.getBoundingClientRect();
    if (mr.right  > window.innerWidth  - 4) menu.style.left = (e.clientX - mr.width)  + 'px';
    if (mr.bottom > window.innerHeight - 4) menu.style.top  = (e.clientY - mr.height) + 'px';
  }, { signal: ctx.signal });

  // Dismiss on click outside or Escape
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) hide();
  }, { signal: ctx.signal });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); hide(); }
  }, { signal: ctx.signal, capture: true });
}

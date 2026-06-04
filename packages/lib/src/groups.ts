import type { Ctx, ItemRecord } from './types.js';
import { createItem, removeItem, saveItem } from './items.js';
import { pushUndo } from './history.js';
import { toast, selectItem } from './canvas.js';

const GROUP_PAD = 24;

/** Grow `group` on any side needed so it contains `member` plus GROUP_PAD. */
export function expandGroupToContain(group: ItemRecord, member: ItemRecord): void {
  const mw = member.w || member.el.offsetWidth  || 200;
  const mh = member.h || member.el.offsetHeight || 200;
  let gx = group.x, gy = group.y;
  let gRight = group.x + group.w, gBottom = group.y + group.h;
  if (member.x - GROUP_PAD < gx)         gx = member.x - GROUP_PAD;
  if (member.y - GROUP_PAD < gy)         gy = member.y - GROUP_PAD;
  if (member.x + mw + GROUP_PAD > gRight)  gRight  = member.x + mw + GROUP_PAD;
  if (member.y + mh + GROUP_PAD > gBottom) gBottom = member.y + mh + GROUP_PAD;
  const nw = gRight - gx, nh = gBottom - gy;
  if (gx === group.x && gy === group.y && nw === group.w && nh === group.h) return;
  group.x = gx; group.y = gy; group.w = nw; group.h = nh;
  group.el.style.left = gx + 'px'; group.el.style.top = gy + 'px';
  group.el.style.width = nw + 'px'; group.el.style.height = nh + 'px';
  group.bound.onResize?.(nw, nh);
}

export function getGroupMembers(ctx: Ctx, groupId: number): ItemRecord[] {
  return ctx.items.filter(i => i.groupId === groupId);
}

/** True if `candidate` is `item`, or nested anywhere inside `item` (a member, member-of-member, ...). */
function isSelfOrDescendant(ctx: Ctx, candidate: ItemRecord, item: ItemRecord): boolean {
  let cur: ItemRecord | undefined = candidate;
  const seen = new Set<number>();
  while (cur) {
    if (cur.id === item.id) return true;
    if (seen.has(cur.id)) break;          // guard against any pre-existing cycle
    seen.add(cur.id);
    cur = cur.groupId != null ? ctx.itemsById.get(cur.groupId) : undefined;
  }
  return false;
}

/**
 * The group a drop at (x, y) lands in. Innermost (highest z-index) wins.
 * Groups that are one of `dragged` — or nested inside one — are excluded so a
 * group cannot be dropped into itself or its own member. Returns null if none.
 */
export function resolveDropGroup(
  ctx: Ctx,
  x: number,
  y: number,
  dragged: Iterable<ItemRecord>,
): ItemRecord | null {
  const draggedArr = [...dragged];
  let best: ItemRecord | null = null;
  let bestZ = -Infinity;
  for (const g of ctx.items) {
    if (ctx.itemPlugins.get(g.type)?.container !== true) continue;
    if (draggedArr.some(d => isSelfOrDescendant(ctx, g, d))) continue;
    const gw = g.w || g.el.offsetWidth  || 0;
    const gh = g.h || g.el.offsetHeight || 0;
    if (x < g.x || y < g.y || x > g.x + gw || y > g.y + gh) continue;
    const z = parseInt(g.el.style.zIndex) || 0;
    if (z >= bestZ) { bestZ = z; best = g; }
  }
  return best;
}

/** All items nested under `id` — its direct and transitive members. */
function descendantsOf(ctx: Ctx, id: number): ItemRecord[] {
  const result: ItemRecord[] = [];
  const seen = new Set<number>([id]);
  const stack = [id];
  while (stack.length) {
    const pid = stack.pop()!;
    for (const m of ctx.items) {
      if (m.groupId === pid && !seen.has(m.id)) {
        seen.add(m.id);
        result.push(m);
        stack.push(m.id);
      }
    }
  }
  return result;
}

export interface ReparentData {
  changed: boolean;
  itemsBefore: Map<number, { groupId?: number; z: number }>;
  itemsAfter:  Map<number, { groupId?: number; z: number }>;
  groupBefore: Map<number, { x: number; y: number; w: number; h: number }>;
  groupAfter:  Map<number, { x: number; y: number; w: number; h: number }>;
}

/**
 * Re-parent `items` into `target` (or detach when `target` is null).
 * Bumps a joined item above the group's z-index when needed and grows the
 * target group to contain it. Persists changes and returns before/after data
 * for undo. Items already in the target group are skipped.
 */
export function reparentItems(
  ctx: Ctx,
  items: ItemRecord[],
  target: ItemRecord | null,
): ReparentData {
  const itemsBefore = new Map<number, { groupId?: number; z: number }>();
  const itemsAfter  = new Map<number, { groupId?: number; z: number }>();
  const groupBefore = new Map<number, { x: number; y: number; w: number; h: number }>();
  const groupAfter  = new Map<number, { x: number; y: number; w: number; h: number }>();
  const newGid = target ? target.id : undefined;
  let changed = false;

  if (target) groupBefore.set(target.id, { x: target.x, y: target.y, w: target.w, h: target.h });

  const explicitIds = new Set(items.map(i => i.id));

  for (const it of items) {
    if (it.groupId === newGid) continue;
    const zBefore = parseInt(it.el.style.zIndex) || 0;
    itemsBefore.set(it.id, { groupId: it.groupId, z: zBefore });
    it.groupId = newGid;
    let zAfter = zBefore;
    if (target) {
      const gz = parseInt(target.el.style.zIndex) || 0;
      if (zBefore <= gz) { zAfter = gz + 1; it.el.style.zIndex = String(zAfter); }
      expandGroupToContain(target, it);
    }
    itemsAfter.set(it.id, { groupId: newGid, z: zAfter });
    changed = true;
    void saveItem(ctx, it.id);

    // Lifting a nested group above its new parent must lift the group's own
    // members by the same amount, or they'd drop behind its background.
    const delta = zAfter - zBefore;
    if (delta > 0) {
      for (const d of descendantsOf(ctx, it.id)) {
        if (explicitIds.has(d.id) || itemsBefore.has(d.id)) continue;
        const dz = parseInt(d.el.style.zIndex) || 0;
        itemsBefore.set(d.id, { groupId: d.groupId, z: dz });
        d.el.style.zIndex = String(dz + delta);
        itemsAfter.set(d.id, { groupId: d.groupId, z: dz + delta });
        void saveItem(ctx, d.id);
      }
    }
  }

  if (target) {
    if (changed) {
      groupAfter.set(target.id, { x: target.x, y: target.y, w: target.w, h: target.h });
      void saveItem(ctx, target.id);
    } else {
      groupBefore.delete(target.id);
    }
  }

  return { changed, itemsBefore, itemsAfter, groupBefore, groupAfter };
}

export function groupSelectedItems(ctx: Ctx): void {
  const candidates = [...ctx.selectedItems].filter(i => {
    if (i.groupId != null) {
      const group = ctx.itemsById.get(i.groupId);
      if (group && ctx.selectedItems.has(group)) return false;
    }
    return true;
  });
  if (candidates.length === 0) {
    toast(ctx, 'Select items to group');
    return;
  }

  const PAD = 24;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of candidates) {
    const w = item.w || item.el.offsetWidth || 200;
    const h = item.h || item.el.offsetHeight || 200;
    minX = Math.min(minX, item.x);     minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + w); maxY = Math.max(maxY, item.y + h);
  }

  const gx = minX - PAD, gy = minY - PAD;
  const gw = maxX - minX + PAD * 2;
  const gh = maxY - minY + PAD * 2;

  const memberMinZ = Math.min(...candidates.map(m => parseInt(m.el.style.zIndex) || 0));
  const groupZIndex = Math.max(1, memberMinZ - 1);

  const groupRec = createItem(ctx, 'group', gx, gy, { zIndex: groupZIndex, skipSelect: true });
  groupRec.el.style.width  = gw + 'px';
  groupRec.el.style.height = gh + 'px';
  groupRec.w = gw;
  groupRec.h = gh;

  const groupId        = groupRec.id;
  const memberIds      = candidates.map(i => i.id);
  const prevGroupIds   = candidates.map(i => i.groupId);

  for (const item of candidates) {
    item.groupId = groupRec.id;
    void saveItem(ctx, item.id);
  }
  void saveItem(ctx, groupRec.id);
  selectItem(ctx, groupRec);

  pushUndo(ctx, {
    label: 'group',
    undo() {
      for (let i = 0; i < memberIds.length; i++) {
        const m = ctx.itemsById.get(memberIds[i]);
        if (m) { m.groupId = prevGroupIds[i]; void saveItem(ctx, m.id); }
      }
      const g = ctx.itemsById.get(groupId);
      if (g) removeItem(ctx, g);
      return memberIds;
    },
    redo() {
      const g = createItem(ctx, 'group', gx, gy, { id: groupId, zIndex: groupZIndex, skipSelect: true });
      g.el.style.width  = gw + 'px';
      g.el.style.height = gh + 'px';
      g.w = gw; g.h = gh;
      for (const mid of memberIds) {
        const m = ctx.itemsById.get(mid);
        if (m) { m.groupId = groupId; void saveItem(ctx, m.id); }
      }
      void saveItem(ctx, g.id);
      return [groupId, ...memberIds];
    },
  });
}

import type { Ctx, ItemRecord } from './types.js';
import { createItem, removeItem, saveItem } from './items.js';
import { pushUndo } from './history.js';
import { toast, selectItem } from './canvas.js';

export function getGroupMembers(ctx: Ctx, groupId: number): ItemRecord[] {
  return ctx.items.filter(i => i.groupId === groupId);
}

export function groupSelectedItems(ctx: Ctx): void {
  const candidates = [...ctx.selectedItems].filter(i => !ctx.itemPlugins.get(i.type)?.container);
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

  for (const item of candidates) {
    item.groupId = groupRec.id;
    void saveItem(ctx, item.id);
  }
  void saveItem(ctx, groupRec.id);
  selectItem(ctx, groupRec);

  const groupId   = groupRec.id;
  const memberIds = candidates.map(i => i.id);

  pushUndo(ctx, {
    label: 'group',
    undo() {
      for (const mid of memberIds) {
        const m = ctx.itemsById.get(mid);
        if (m) { m.groupId = undefined; void saveItem(ctx, m.id); }
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

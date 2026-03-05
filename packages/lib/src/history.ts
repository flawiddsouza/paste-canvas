import type { Ctx, UndoCmd } from './types.js';
import { applyTransform, saveViewport } from './canvas.js';
import { toast } from './canvas.js';

const HISTORY_LIMIT = 100;

export function pushUndo(ctx: Ctx, cmd: UndoCmd): void {
  ctx.undoStack.push(cmd);
  if (ctx.undoStack.length > HISTORY_LIMIT) ctx.undoStack.shift()!.dispose?.();
  for (const c of ctx.redoStack) c.dispose?.();
  ctx.redoStack = [];
}

export function saveTabHistory(ctx: Ctx, tabId: number): void {
  ctx.tabHistory.set(tabId, { undoStack: ctx.undoStack, redoStack: ctx.redoStack });
}

export function restoreTabHistory(ctx: Ctx, tabId: number): void {
  const h = ctx.tabHistory.get(tabId);
  ctx.undoStack = h ? h.undoStack : [];
  ctx.redoStack = h ? h.redoStack : [];
}

export function focusItems(ctx: Ctx, ids: number[]): void {
  const recs = ids.map(id => ctx.items.find(i => i.id === id)).filter(Boolean) as typeof ctx.items;
  if (!recs.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rec of recs) {
    const w = rec.w || rec.el.offsetWidth;
    const h = rec.h || rec.el.offsetHeight;
    minX = Math.min(minX, rec.x);     minY = Math.min(minY, rec.y);
    maxX = Math.max(maxX, rec.x + w); maxY = Math.max(maxY, rec.y + h);
  }
  const vr = ctx.viewport.getBoundingClientRect();
  const pad = 48;
  const vx1 = minX * ctx.scale + ctx.panX, vy1 = minY * ctx.scale + ctx.panY;
  const vx2 = maxX * ctx.scale + ctx.panX, vy2 = maxY * ctx.scale + ctx.panY;
  if (vx1 >= pad && vy1 >= pad && vx2 <= vr.width - pad && vy2 <= vr.height - pad) return;
  ctx.panX = vr.width  / 2 - ((minX + maxX) / 2) * ctx.scale;
  ctx.panY = vr.height / 2 - ((minY + maxY) / 2) * ctx.scale;
  applyTransform(ctx);
  saveViewport(ctx);
}

export function performUndo(ctx: Ctx): void {
  const cmd = ctx.undoStack.pop();
  if (!cmd) return;
  const ids = cmd.undo();
  ctx.redoStack.push(cmd);
  toast(ctx, 'Undone: ' + (cmd.label ?? 'action'));
  if (ids?.length) focusItems(ctx, ids);
}

export function performRedo(ctx: Ctx): void {
  const cmd = ctx.redoStack.pop();
  if (!cmd) return;
  const ids = cmd.redo();
  ctx.undoStack.push(cmd);
  toast(ctx, 'Redone: ' + (cmd.label ?? 'action'));
  if (ids?.length) focusItems(ctx, ids);
}

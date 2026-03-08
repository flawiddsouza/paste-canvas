import type { Ctx, EdgeRecord } from './types.js';
import { applyTransform, saveViewport, updateCulling, invalidateOverviewCache, toast, showConfirm } from './canvas.js';
import { renderEdge, updateEdgesForItems } from './edges.js';
import { createItem, saveItem } from './items.js';
import { saveTabHistory, restoreTabHistory } from './history.js';

// ── Unload current tab's items/edges ─────────────────────────────────────────

export function unloadItems(ctx: Ctx, protectedBlobs: Set<string> = new Set()): void {
  for (const e of ctx.edges) { e.svgEl?.remove(); e.inputEl?.remove(); }
  ctx.edges = [];
  ctx.selectedEdges.clear();
  ctx.nodeEdgeMap.clear();
  for (const rec of ctx.items) {
    rec.mounted = false;
    const src = (rec.contentEl as HTMLImageElement).src;
    if (rec.type === 'img' && src?.startsWith('blob:') && !protectedBlobs.has(src))
      URL.revokeObjectURL(src);
    rec.el.remove();
  }
  ctx.items = [];
  ctx.itemsById.clear();
  ctx.selectedItems.clear();
  invalidateOverviewCache(ctx);
}

// ── Load a tab ────────────────────────────────────────────────────────────────

export async function loadTab(ctx: Ctx, tabId: number): Promise<void> {
  // Apply saved viewport BEFORE rendering items to avoid flash of movement
  const firstTabId = ctx.tabs[0]?.id;
  let vp = await ctx.adapter.loadViewport(tabId);
  if (!vp && tabId === firstTabId) {
    // legacy fallback: try loading without a tabId key (old single-tab data)
    vp = await ctx.adapter.loadViewport(0);
  }
  ctx.panX  = vp?.panX  ?? 0;
  ctx.panY  = vp?.panY  ?? 0;
  ctx.scale = vp?.scale ?? 1;
  applyTransform(ctx);

  const allItems = await ctx.adapter.getAllItems();
  const tabItems = allItems
    .filter(s => s.tabId === tabId || (s.tabId === undefined && tabId === firstTabId))
    .sort((a, b) => a.zIndex - b.zIndex);

  for (const saved of tabItems) {
    let rec: ReturnType<typeof createItem>;
    if (saved.type === 'group') {
      rec = createItem(ctx, 'group', saved.x, saved.y, { id: saved.id, restore: true, skipMount: true });
      rec.el.style.zIndex = String(saved.zIndex);
      if (saved.w) { rec.el.style.width  = saved.w + 'px'; rec.w = saved.w; }
      if (saved.h) { rec.el.style.height = saved.h + 'px'; rec.h = saved.h; }
      if (saved.text) (rec.contentEl as HTMLTextAreaElement).value = saved.text;
    } else if (saved.type === 'img') {
      const blob = new Blob([saved.imageData!], { type: saved.imageType || 'image/png' });
      rec = createItem(ctx, 'img', saved.x, saved.y, { id: saved.id, restore: true, skipMount: true });
      rec.contentEl.parentElement!.style.width = (saved.width || 300) + 'px';
      rec.el.style.zIndex = String(saved.zIndex);
      const imgEl = rec.contentEl as HTMLImageElement;
      imgEl.onload = () => {
        if (rec.mounted) {
          rec.w = rec.el.offsetWidth;
          rec.h = rec.el.offsetHeight;
        }
        updateEdgesForItems(ctx, new Set([rec]));
      };
      imgEl.src = URL.createObjectURL(blob);
      if (saved.label && rec.labelEl) {
        rec.labelEl.value = saved.label;
        if (rec._autoGrowLabel) rec._autoGrowLabel();
      }
    } else {
      rec = createItem(ctx, 'note', saved.x, saved.y, { id: saved.id, restore: true, skipMount: true });
      (rec.contentEl as HTMLTextAreaElement).value = saved.text || '';
      if (saved.width)  rec.contentEl.style.width  = saved.width  + 'px';
      if (saved.height) rec.contentEl.style.height = saved.height + 'px';
      rec.el.style.zIndex = String(saved.zIndex);
    }
    if (saved.w != null) rec.w = saved.w;
    if (saved.h != null) rec.h = saved.h;
  }

  // Second pass: restore groupId on member items
  for (const saved of tabItems) {
    if (saved.groupId) {
      const rec = ctx.itemsById.get(saved.id);
      if (rec && ctx.itemsById.has(saved.groupId)) rec.groupId = saved.groupId;
    }
  }

  // Load edges
  const savedEdges = (await ctx.adapter.getAllEdges()).filter(e => e.tabId === tabId);
  if (savedEdges.length) ctx.edgeCounter = Math.max(ctx.edgeCounter, ...savedEdges.map(e => e.id));
  for (const saved of savedEdges) {
    const fromRec = ctx.itemsById.get(saved.fromNode);
    const toRec   = ctx.itemsById.get(saved.toNode);
    if (!fromRec || !toRec) continue;
    const edgeRec = {
      id: saved.id, tabId: saved.tabId,
      fromNode: saved.fromNode, fromSide: saved.fromSide,
      toNode:   saved.toNode,   toSide:   saved.toSide,
      label:    saved.label,
    } as EdgeRecord;
    ctx.edges.push(edgeRec);
    if (!ctx.nodeEdgeMap.has(fromRec.id)) ctx.nodeEdgeMap.set(fromRec.id, new Set());
    if (!ctx.nodeEdgeMap.has(toRec.id))   ctx.nodeEdgeMap.set(toRec.id,   new Set());
    ctx.nodeEdgeMap.get(fromRec.id)!.add(edgeRec);
    ctx.nodeEdgeMap.get(toRec.id)!.add(edgeRec);
    renderEdge(ctx, edgeRec);
  }
  updateCulling(ctx);
}

// ── Render tab bar ────────────────────────────────────────────────────────────

export function renderTabBar(ctx: Ctx): void {
  ctx.tabBar.querySelectorAll('.tab').forEach(el => el.remove());
  const addBtn = ctx.tabBar.querySelector('.pc-add-tab-btn')!;
  for (const tab of ctx.tabs) {
    const tabEl = document.createElement('div');
    tabEl.className = 'tab' + (tab.id === ctx.currentTabId ? ' active' : '');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';
    nameSpan.textContent = tab.name;

    nameSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      nameSpan.contentEditable = 'true';
      nameSpan.focus();
      const range = document.createRange();
      range.selectNodeContents(nameSpan);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });

    const commitName = () => {
      nameSpan.contentEditable = 'false';
      const newName = nameSpan.textContent?.trim() || tab.name;
      nameSpan.textContent = newName;
      tab.name = newName;
      ctx.adapter.putTab(tab);
    };
    nameSpan.addEventListener('blur', commitName);
    nameSpan.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); commitName(); nameSpan.blur(); }
      if (e.key === 'Escape') { nameSpan.textContent = tab.name; nameSpan.contentEditable = 'false'; nameSpan.blur(); }
    });

    tabEl.addEventListener('click', () => {
      if (nameSpan.contentEditable === 'true') return;
      void switchTab(ctx, tab.id);
    });
    tabEl.appendChild(nameSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Delete tab';
    closeBtn.style.display = ctx.tabs.length === 1 ? 'none' : '';
    closeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const items = tab.id === ctx.currentTabId
        ? ctx.items
        : (await ctx.adapter.getAllItems()).filter(i => i.tabId === tab.id);
      const notes  = items.filter(i => i.type === 'note').length;
      const images = items.filter(i => i.type === 'img').length;
      const groups = items.filter(i => i.type === 'group').length;
      const parts  = [
        notes  ? `${notes} ${notes  === 1 ? 'note'  : 'notes'}`  : '',
        images ? `${images} ${images === 1 ? 'image' : 'images'}` : '',
        groups ? `${groups} ${groups === 1 ? 'group' : 'groups'}` : '',
      ].filter(Boolean);
      const safeName = tab.name.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const msg = parts.length
        ? `Delete <strong>${safeName}</strong>? It contains ${parts.join(' and ')} that will be permanently deleted.`
        : `Delete <strong>${safeName}</strong>?`;
      const ok = await showConfirm(ctx, msg, 'Delete tab');
      if (ok) void deleteTab(ctx, tab.id);
    });
    tabEl.appendChild(closeBtn);

    ctx.tabBar.insertBefore(tabEl, addBtn);
  }
}

// ── Switch / create / delete tabs ─────────────────────────────────────────────

export async function switchTab(ctx: Ctx, tabId: number): Promise<void> {
  if (tabId === ctx.currentTabId) return;
  ctx.placeOffset = 0;
  clearTimeout(ctx.vpSaveTimer ?? undefined);
  ctx.adapter.saveViewport(ctx.currentTabId!, {
    panX: ctx.panX, panY: ctx.panY, scale: ctx.scale,
  });
  saveTabHistory(ctx, ctx.currentTabId!);
  const protectedBlobs = new Set<string>();
  for (const cmd of [...ctx.undoStack, ...ctx.redoStack]) {
    if (cmd._blobUrl) protectedBlobs.add(cmd._blobUrl);
  }
  unloadItems(ctx, protectedBlobs);
  ctx.currentTabId = tabId;
  ctx.adapter.saveActiveTab(tabId);
  renderTabBar(ctx);
  await loadTab(ctx, tabId);
  restoreTabHistory(ctx, tabId);
}

export async function createTab(ctx: Ctx, name: string): Promise<void> {
  const id = ++ctx.tabCounter;
  const tab = { id, name, order: ctx.tabs.length };
  ctx.tabs.push(tab);
  ctx.adapter.putTab(tab);
  await switchTab(ctx, id);
}

export async function deleteTab(ctx: Ctx, tabId: number): Promise<void> {
  if (ctx.tabs.length <= 1) { toast(ctx, "Can't delete the last tab"); return; }
  const idx = ctx.tabs.findIndex(t => t.id === tabId);
  const nextTab = ctx.tabs[idx + 1] ?? ctx.tabs[idx - 1];
  if (tabId === ctx.currentTabId) await switchTab(ctx, nextTab.id);
  const allItems = await ctx.adapter.getAllItems();
  for (const item of allItems) {
    if (item.tabId === tabId) ctx.adapter.deleteItem(item.id);
  }
  // edges for this tab
  const allEdges = await ctx.adapter.getAllEdges();
  for (const edge of allEdges) {
    if (edge.tabId === tabId) ctx.adapter.deleteEdge(edge.id);
  }
  ctx.adapter.deleteTab(tabId);
  const oldHistory = ctx.tabHistory.get(tabId);
  if (oldHistory) {
    for (const c of [...oldHistory.undoStack, ...oldHistory.redoStack]) c.dispose?.();
    ctx.tabHistory.delete(tabId);
  }
  ctx.tabs = ctx.tabs.filter(t => t.id !== tabId);
  renderTabBar(ctx);
}

// ── Restore all (initial load) ────────────────────────────────────────────────

export async function restoreAll(ctx: Ctx): Promise<void> {
  const allItems = await ctx.adapter.getAllItems();
  for (const item of allItems) ctx.itemCounter = Math.max(ctx.itemCounter, item.id, item.zIndex ?? 0);
  const allEdges = await ctx.adapter.getAllEdges();
  for (const edge of allEdges) ctx.edgeCounter = Math.max(ctx.edgeCounter, edge.id);

  let savedTabs = await ctx.adapter.getAllTabs();
  if (savedTabs.length === 0) {
    const defaultTab = { id: 1, name: 'Board 1', order: 0 };
    ctx.adapter.putTab(defaultTab);
    savedTabs = [defaultTab];
    ctx.tabCounter = 1;
  } else {
    ctx.tabCounter = Math.max(...savedTabs.map(t => t.id));
  }
  ctx.tabs = savedTabs.sort((a, b) => a.order - b.order);

  const activeTabId = await ctx.adapter.loadActiveTab();
  ctx.currentTabId = activeTabId ?? ctx.tabs[0].id;
  if (!ctx.tabs.find(t => t.id === ctx.currentTabId)) ctx.currentTabId = ctx.tabs[0].id;

  renderTabBar(ctx);
  await loadTab(ctx, ctx.currentTabId);
}

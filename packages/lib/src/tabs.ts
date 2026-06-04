import type { Ctx, EdgeRecord, TabLayout } from './types.js';
import { applyTransform, saveViewport, updateCulling, invalidateOverviewCache, toast, showConfirm } from './canvas.js';
import { renderEdge } from './edges.js';
import { createItem } from './items.js';
import { saveTabHistory, restoreTabHistory } from './history.js';

// ── Unload current tab's items/edges ─────────────────────────────────────────

export function unloadItems(ctx: Ctx): void {
  for (const e of ctx.edges) { e.svgEl?.remove(); e.inputEl?.remove(); }
  ctx.edges = [];
  ctx.selectedEdges.clear();
  ctx.nodeEdgeMap.clear();
  for (const rec of ctx.items) {
    rec.bound.destroy();
    rec.el.remove();
    rec.mounted = false;
  }
  ctx.items = [];
  ctx.itemsById.clear();
  ctx.selectedItems.clear();
  invalidateOverviewCache(ctx);
}

// ── Load a tab ────────────────────────────────────────────────────────────────

export async function loadTab(ctx: Ctx, tabId: number): Promise<void> {
  // Apply saved viewport BEFORE rendering items to avoid flash of movement
  let vp = await ctx.adapter.loadViewport(tabId);
  ctx.panX  = vp?.panX  ?? 0;
  ctx.panY  = vp?.panY  ?? 0;
  ctx.scale = vp?.scale ?? 1;
  applyTransform(ctx);

  const tabItems = (await ctx.adapter.getItemsForTab(tabId))
    .sort((a, b) => a.zIndex - b.zIndex);

  for (const saved of tabItems) {
    const rec = createItem(ctx, saved.type, saved.x, saved.y, {
      id: saved.id, zIndex: saved.zIndex, skipSelect: true, skipMount: true,
    });
    rec.bound.suppressDuring(() => {
      try { rec.bound.hydrate({ data: saved.pluginData ?? null, binary: saved.binaryData }); }
      catch (e) { console.error(`[paste-canvas] hydrate() failed for type "${saved.type}"`, e); }
    });
    if (saved.w != null) { rec.el.style.width  = saved.w + 'px'; rec.w = saved.w; }
    // Don't constrain height for width-only resize items (e.g. images) — their height
    // is content-driven and the saved value was captured before the image decoded.
    const heightFixed = ctx.itemPlugins.get(saved.type)?.resize !== 'width';
    if (saved.h != null && heightFixed) { rec.el.style.height = saved.h + 'px'; rec.h = saved.h; }
  }

  // Second pass: restore groupId on member items
  for (const saved of tabItems) {
    if (saved.groupId) {
      const rec = ctx.itemsById.get(saved.id);
      if (rec && ctx.itemsById.has(saved.groupId)) rec.groupId = saved.groupId;
    }
  }

  // Load edges
  const savedEdges = await ctx.adapter.getEdgesForTab(tabId);
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

// ── Layout (top bar <-> sidebar) ──────────────────────────────────────────────

/** Apply a layout to the DOM + ctx without persisting (used on initial load). */
function applyTabLayout(ctx: Ctx, layout: TabLayout): void {
  ctx.tabLayout = layout;
  ctx.root.classList.toggle('layout-sidebar', layout === 'sidebar');
}

/** Switch layout in response to a user action and persist the choice. */
export function setTabLayout(ctx: Ctx, layout: TabLayout): void {
  applyTabLayout(ctx, layout);
  void ctx.adapter.saveTabLayout(layout);
}

// ── Reorder tabs ──────────────────────────────────────────────────────────────

/**
 * Move the tab at `fromIndex` to `toIndex` (index in the array AFTER removal),
 * reassign every tab's `order` to its new position, and persist the ones that
 * changed. Does not re-render - the caller renders after.
 */
export function moveTab(ctx: Ctx, fromIndex: number, toIndex: number): void {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
  if (fromIndex >= ctx.tabs.length || toIndex >= ctx.tabs.length) return;
  const [moved] = ctx.tabs.splice(fromIndex, 1);
  ctx.tabs.splice(toIndex, 0, moved);
  ctx.tabs.forEach((tab, i) => {
    if (tab.order !== i) { tab.order = i; void ctx.adapter.putTab(tab); }
  });
}

// ── Render tab bar ────────────────────────────────────────────────────────────

export function renderTabBar(ctx: Ctx): void {
  ctx.tabBar.querySelectorAll('.tab').forEach(el => el.remove());
  const addBtn = ctx.tabBar.querySelector('.pc-add-tab-btn')!;
  let justDragged = false;

  const attachTabDrag = (tabEl: HTMLElement, tab: { id: number }) => {
    tabEl.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('.tab-close')) return;                 // delete button
      if (tabEl.querySelector<HTMLElement>('.tab-name')?.isContentEditable) return; // renaming

      justDragged = false;
      const startX = e.clientX, startY = e.clientY;
      const startIndex = ctx.tabs.findIndex(t => t.id === tab.id);
      let dragging = false;
      let targetIndex = startIndex;

      const onMove = (ev: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
          dragging = true;
          tabEl.classList.add('dragging');
        }
        ev.preventDefault(); // suppress text selection while dragging
        const vertical = ctx.tabLayout === 'sidebar';
        const others = [...ctx.tabBar.querySelectorAll<HTMLElement>('.tab')].filter(el => el !== tabEl);
        let idx = 0;
        for (const el of others) {
          const r = el.getBoundingClientRect();
          const mid = vertical ? r.top + r.height / 2 : r.left + r.width / 2;
          const pos = vertical ? ev.clientY : ev.clientX;
          if (pos > mid) idx++;
        }
        targetIndex = idx;
        // Live feedback: move the dragged element among its siblings.
        ctx.tabBar.insertBefore(tabEl, others[targetIndex] ?? addBtn);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (!dragging) return;
        tabEl.classList.remove('dragging');
        justDragged = true;            // swallow the trailing click
        if (targetIndex !== startIndex) {
          moveTab(ctx, startIndex, targetIndex);
          renderTabBar(ctx);           // rebuild from canonical order
        } else {
          renderTabBar(ctx);           // restore DOM position after the live move
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  };

  for (const tab of ctx.tabs) {
    const tabEl = document.createElement('div');
    tabEl.className = 'tab' + (tab.id === ctx.currentTabId ? ' active' : '');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';
    nameSpan.textContent = tab.name;

    nameSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      nameSpan.contentEditable = 'plaintext-only';
      nameSpan.spellcheck = false;
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
      if (nameSpan.isContentEditable) return;
      if (justDragged) { justDragged = false; return; }
      void switchTab(ctx, tab.id);
    });
    attachTabDrag(tabEl, tab);
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
        : await ctx.adapter.getItemsForTab(tab.id);
      const labelCounts = new Map<string, number>();
      for (const i of items) {
        const label = ctx.itemPlugins.get(i.type)?.label ?? i.type;
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
      const parts = [...labelCounts.entries()].map(([label, count]) =>
        `${count} ${count === 1 ? label.toLowerCase() : label.toLowerCase() + 's'}`
      );
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
  unloadItems(ctx);
  ctx.currentTabId = tabId;
  ctx.adapter.saveActiveTab(tabId);
  renderTabBar(ctx);
  await loadTab(ctx, tabId);
  restoreTabHistory(ctx, tabId);
}

export async function createTab(ctx: Ctx, name: string, atStart = false): Promise<void> {
  const id = ++ctx.tabCounter;
  const tab = { id, name, order: atStart ? 0 : ctx.tabs.length };
  if (atStart) ctx.tabs.unshift(tab); else ctx.tabs.push(tab);
  // Re-sequence orders to match array positions; persist the new tab plus any that shifted.
  ctx.tabs.forEach((t, i) => {
    if (t.order !== i || t === tab) { t.order = i; ctx.adapter.putTab(t); }
  });
  await switchTab(ctx, id);
}

export async function deleteTab(ctx: Ctx, tabId: number): Promise<void> {
  if (ctx.tabs.length <= 1) { toast(ctx, "Can't delete the last tab"); return; }
  const idx = ctx.tabs.findIndex(t => t.id === tabId);
  const nextTab = ctx.tabs[idx + 1] ?? ctx.tabs[idx - 1];
  if (tabId === ctx.currentTabId) await switchTab(ctx, nextTab.id);
  const tabItems = await ctx.adapter.getItemsForTab(tabId);
  for (const item of tabItems) ctx.adapter.deleteItem(item.id);
  // edges for this tab
  const tabEdges = await ctx.adapter.getEdgesForTab(tabId);
  for (const edge of tabEdges) ctx.adapter.deleteEdge(edge.id);
  ctx.adapter.deleteTab(tabId);
  ctx.adapter.deleteViewport(tabId);
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
  for (const item of allItems) {
    ctx.itemCounter = Math.max(ctx.itemCounter, item.id);
    ctx.zCounter    = Math.max(ctx.zCounter, item.zIndex ?? 0);
  }
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

  applyTabLayout(ctx, (await ctx.adapter.loadTabLayout()) ?? 'topbar');

  renderTabBar(ctx);
  await loadTab(ctx, ctx.currentTabId);
}

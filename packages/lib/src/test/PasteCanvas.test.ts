import { describe, expect, it, vi } from 'vitest';
import type { CanvasAPI, CanvasPlugin } from '../canvas-plugin.js';
import type { Ctx, EdgeData, ItemData, ItemRecord, StorageAdapter, TabData, ViewportState } from '../types.js';

vi.mock('../style.js', () => ({
  injectStyles: vi.fn(),
}));

vi.mock('../canvas.js', () => ({
  applyTransform: vi.fn(),
  saveViewport: vi.fn(),
  toast: vi.fn(),
  showConfirm: vi.fn(),
  viewportCenter: vi.fn(() => ({ x: 0, y: 0 })),
  fitItems: vi.fn(),
  clearSelection: vi.fn(),
  addToSelection: vi.fn(),
  selectItem: vi.fn(),
  initViewport: vi.fn(),
  invalidateOverviewCache: vi.fn(),
  refreshOverview: vi.fn(),
  updateCulling: vi.fn(),
}));

vi.mock('../history.js', () => ({
  pushUndo: vi.fn(),
  performUndo: vi.fn(),
  performRedo: vi.fn(),
}));

vi.mock('../items.js', () => ({
  snapItem: vi.fn(),
  restoreItemSnap: vi.fn(),
  saveItem: vi.fn(),
  createItem: vi.fn(),
  removeItem: vi.fn(),
  duplicateSelected: vi.fn(),
}));

vi.mock('../groups.js', () => ({
  groupSelectedItems: vi.fn(),
}));

vi.mock('../edges.js', () => ({
  snapEdge: vi.fn(),
  restoreEdgeSnap: vi.fn(),
  removeEdge: vi.fn(),
  updateEdgesForItems: vi.fn(),
}));

vi.mock('../tabs.js', () => ({
  renderTabBar: vi.fn(),
  restoreAll: vi.fn(async (ctx: Ctx) => {
    ctx.tabs = [{ id: 1, name: 'Board 1', order: 0 }];
    ctx.currentTabId = 1;
    ctx.tabCounter = 1;
    ctx.itemCounter = 5;
    ctx.zCounter = 20;
    ctx.edgeCounter = 3;
  }),
  createTab: vi.fn(),
  setTabLayout: vi.fn(),
}));

vi.mock('../context-menu.js', () => ({
  initContextMenu: vi.fn(),
}));

import { PasteCanvas } from '../PasteCanvas.js';
import { renderTabBar } from '../tabs.js';
import { saveItem } from '../items.js';
import type { ItemPlugin } from '../plugin.js';

function makeAdapter(overrides?: Partial<StorageAdapter>): StorageAdapter {
  return {
    putItem: async (_item: ItemData) => {},
    deleteItem: async (_id: number) => {},
    getAllItems: async () => [],
    getItemsForTab: async (_tabId: number) => [],
    putTab: async (_tab: TabData) => {},
    deleteTab: async (_id: number) => {},
    getAllTabs: async () => [],
    putEdge: async (_edge: EdgeData) => {},
    deleteEdge: async (_id: number) => {},
    getAllEdges: async () => [],
    getEdgesForTab: async (_tabId: number) => [],
    saveViewport: async (_tabId: number, _state: ViewportState) => {},
    loadViewport: async (_tabId: number) => null,
    deleteViewport: async (_tabId: number) => {},
    saveActiveTab: async (_tabId: number) => {},
    loadActiveTab: async () => null,
    saveTabLayout: async (_layout) => {},
    loadTabLayout: async () => null,
    ...overrides,
  };
}

describe('PasteCanvas refreshTabs', () => {
  it('updates tabs and counters using only newly discovered tab data', async () => {
    let api!: CanvasAPI;
    const onMount = vi.fn((canvasApi: CanvasAPI) => {
      api = canvasApi;
    });
    const plugin: CanvasPlugin = {
      kind: 'canvas',
      onMount,
    };

    const getItemsForTab = vi.fn<(tabId: number) => Promise<ItemData[]>>()
      .mockImplementation(async (tabId: number) => {
        if (tabId === 2) {
          return [
            { id: 7, type: 'note', tabId: 2, x: 0, y: 0, w: 10, h: 10, zIndex: 11 },
          ];
        }
        if (tabId === 3) {
          return [
            { id: 9, type: 'img', tabId: 3, x: 0, y: 0, w: 20, h: 20, zIndex: 4 },
          ];
        }
        return [];
      });
    const adapter = makeAdapter({
      getAllTabs: vi.fn<() => Promise<TabData[]>>().mockResolvedValue([
        { id: 1, name: 'Board 1', order: 0 },
        { id: 2, name: 'Board 2', order: 1 },
        { id: 3, name: 'Board 3', order: 2 },
      ]),
      getItemsForTab,
      getEdgesForTab: vi.fn<(tabId: number) => Promise<EdgeData[]>>()
        .mockImplementation(async (tabId: number) => {
          if (tabId === 2) {
            return [
              { id: 4, tabId: 2, fromNode: 7, fromSide: 'left', toNode: 7, toSide: 'right' },
            ];
          }
          if (tabId === 3) {
            return [
              { id: 8, tabId: 3, fromNode: 9, fromSide: 'left', toNode: 9, toSide: 'right' },
            ];
          }
          return [];
        }),
    });

    const container = document.createElement('div');
    const canvas = new PasteCanvas(container, adapter, { plugins: [plugin] }).mount();

    await vi.waitFor(() => expect(onMount).toHaveBeenCalledOnce());
    await api.refreshTabs();

    const ctx = (canvas as unknown as { ctx: Ctx }).ctx;

    expect(getItemsForTab).toHaveBeenCalledTimes(2);
    expect(getItemsForTab).toHaveBeenNthCalledWith(1, 2);
    expect(getItemsForTab).toHaveBeenNthCalledWith(2, 3);
    expect(vi.mocked(renderTabBar)).toHaveBeenCalled();
    expect(ctx.tabs.map(tab => tab.id)).toEqual([1, 2, 3]);
    expect(ctx.tabCounter).toBe(3);
    expect(ctx.itemCounter).toBe(9);
    expect(ctx.zCounter).toBe(20);
    expect(ctx.edgeCounter).toBe(8);
  });
});

describe('PasteCanvas keyboard guard', () => {
  it('ignores viewport shortcuts while typing in a contentEditable field (e.g. tab title)', async () => {
    let api!: CanvasAPI;
    const onMount = vi.fn((canvasApi: CanvasAPI) => { api = canvasApi; });
    const plugin: CanvasPlugin = { kind: 'canvas', onMount };

    const container = document.createElement('div');
    const canvas = new PasteCanvas(container, makeAdapter(), { plugins: [plugin] }).mount();
    await vi.waitFor(() => expect(onMount).toHaveBeenCalledOnce());

    const ctx = (canvas as unknown as { ctx: Ctx }).ctx;

    // A selected item sitting in the viewport.
    const item = {
      id: 1, type: 'note', x: 0, y: 0, w: 10, h: 10,
      el: document.createElement('div'), bound: {}, mounted: true,
    } as unknown as ItemRecord;
    ctx.selectedItems.add(item);
    vi.mocked(saveItem).mockClear();

    // Focus a contentEditable span, like the tab-title editor.
    const editable = document.createElement('span');
    editable.contentEditable = 'true';
    document.body.appendChild(editable);
    editable.focus();

    try {
      // Arrow keys inside the editable must NOT nudge the selected item.
      // The guard is a single early-return, so this also covers Backspace/Delete/etc.
      editable.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight', bubbles: true, cancelable: true,
      }));

      expect(item.x).toBe(0);
      expect(vi.mocked(saveItem)).not.toHaveBeenCalled();
    } finally {
      editable.remove();
      ctx.selectedItems.delete(item);
    }
  });
});

describe('PasteCanvas paste guard', () => {
  it('does not run canvas paste when pasting into an editable field (input / contentEditable)', async () => {
    const pasteFn = vi.fn().mockResolvedValue(null);
    const itemPlugin = {
      kind: 'item', type: 'fake', label: 'Fake',
      create: () => ({ el: document.createElement('div') }),
      snapshot: () => ({}),
      restore: () => {},
      serialize: () => ({}),
      hydrate: () => {},
      paste: pasteFn,
    } as unknown as ItemPlugin;

    const onMount = vi.fn();
    const canvasPlugin: CanvasPlugin = { kind: 'canvas', onMount };

    const container = document.createElement('div');
    new PasteCanvas(container, makeAdapter(), { plugins: [canvasPlugin, itemPlugin] }).mount();
    await vi.waitFor(() => expect(onMount).toHaveBeenCalledOnce());

    const editable = document.createElement('span');
    editable.contentEditable = 'plaintext-only';
    const input = document.createElement('input');
    document.body.append(editable, input);

    try {
      // Pasting into editable targets must NOT trigger plugin paste / item creation.
      editable.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }));
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }));
      expect(pasteFn).not.toHaveBeenCalled();

      // Control: pasting onto a non-editable target still runs plugin paste.
      document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }));
      expect(pasteFn).toHaveBeenCalled();
    } finally {
      editable.remove();
      input.remove();
    }
  });
});

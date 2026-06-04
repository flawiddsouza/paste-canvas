import { describe, expect, it, vi } from 'vitest';
import type { Ctx, StorageAdapter, TabData, ViewportState, ItemData, EdgeData, TabLayout } from '../types.js';

vi.mock('../canvas.js', () => ({
  applyTransform: vi.fn(), saveViewport: vi.fn(), updateCulling: vi.fn(),
  invalidateOverviewCache: vi.fn(), toast: vi.fn(), showConfirm: vi.fn(),
}));
vi.mock('../edges.js', () => ({ renderEdge: vi.fn() }));
vi.mock('../items.js', () => ({ createItem: vi.fn() }));
vi.mock('../history.js', () => ({ saveTabHistory: vi.fn(), restoreTabHistory: vi.fn() }));

import { setTabLayout, restoreAll } from '../tabs.js';

function makeAdapter(overrides?: Partial<StorageAdapter>): StorageAdapter {
  return {
    putItem: async (_i: ItemData) => {}, deleteItem: async (_id: number) => {},
    getAllItems: async () => [], getItemsForTab: async (_t: number) => [],
    putTab: async (_t: TabData) => {}, deleteTab: async (_id: number) => {}, getAllTabs: async () => [],
    putEdge: async (_e: EdgeData) => {}, deleteEdge: async (_id: number) => {},
    getAllEdges: async () => [], getEdgesForTab: async (_t: number) => [],
    saveViewport: async (_t: number, _s: ViewportState) => {}, loadViewport: async (_t: number) => null,
    deleteViewport: async (_t: number) => {}, saveActiveTab: async (_t: number) => {}, loadActiveTab: async () => null,
    saveTabLayout: async (_l: TabLayout) => {}, loadTabLayout: async () => null,
    ...overrides,
  };
}

function makeCtx(adapter: StorageAdapter): Ctx {
  const root = document.createElement('div');
  root.className = 'paste-canvas-root';
  return { root, tabLayout: 'topbar', adapter } as unknown as Ctx;
}

describe('setTabLayout', () => {
  it('switches to sidebar: sets the class, updates ctx, and persists', () => {
    const saveTabLayout = vi.fn<(l: TabLayout) => Promise<void>>().mockResolvedValue();
    const ctx = makeCtx(makeAdapter({ saveTabLayout }));

    setTabLayout(ctx, 'sidebar');

    expect(ctx.tabLayout).toBe('sidebar');
    expect(ctx.root.classList.contains('layout-sidebar')).toBe(true);
    expect(saveTabLayout).toHaveBeenCalledWith('sidebar');
  });

  it('switches back to topbar: removes the class and persists', () => {
    const saveTabLayout = vi.fn<(l: TabLayout) => Promise<void>>().mockResolvedValue();
    const ctx = makeCtx(makeAdapter({ saveTabLayout }));

    setTabLayout(ctx, 'sidebar');
    setTabLayout(ctx, 'topbar');

    expect(ctx.tabLayout).toBe('topbar');
    expect(ctx.root.classList.contains('layout-sidebar')).toBe(false);
    expect(saveTabLayout).toHaveBeenLastCalledWith('topbar');
  });
});

describe('restoreAll layout', () => {
  it('applies the persisted sidebar layout before rendering', async () => {
    const adapter = makeAdapter({
      getAllItems: async () => [], getAllEdges: async () => [],
      getAllTabs: async () => [{ id: 1, name: 'A', order: 0 }],
      loadActiveTab: async () => 1,
      loadTabLayout: async () => 'sidebar',
    });
    const ctx = makeCtx(adapter);
    const tabBar = document.createElement('div');
    const addBtn = document.createElement('button');
    addBtn.className = 'pc-add-tab-btn';
    tabBar.appendChild(addBtn);
    (ctx as unknown as { tabBar: HTMLElement }).tabBar = tabBar;
    ctx.currentTabId = 1;

    await restoreAll(ctx);

    expect(ctx.tabLayout).toBe('sidebar');
    expect(ctx.root.classList.contains('layout-sidebar')).toBe(true);
  });

  it('defaults to topbar when nothing is persisted', async () => {
    const adapter = makeAdapter({
      getAllItems: async () => [], getAllEdges: async () => [],
      getAllTabs: async () => [{ id: 1, name: 'A', order: 0 }],
      loadActiveTab: async () => 1,
      loadTabLayout: async () => null,
    });
    const ctx = makeCtx(adapter);
    const tabBar = document.createElement('div');
    const addBtn = document.createElement('button');
    addBtn.className = 'pc-add-tab-btn';
    tabBar.appendChild(addBtn);
    (ctx as unknown as { tabBar: HTMLElement }).tabBar = tabBar;
    ctx.currentTabId = 1;

    await restoreAll(ctx);

    expect(ctx.tabLayout).toBe('topbar');
    expect(ctx.root.classList.contains('layout-sidebar')).toBe(false);
  });
});

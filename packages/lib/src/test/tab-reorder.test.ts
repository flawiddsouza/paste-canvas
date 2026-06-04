import { describe, expect, it, vi } from 'vitest';
import type { Ctx, StorageAdapter, TabData, ViewportState, ItemData, EdgeData, TabLayout } from '../types.js';

vi.mock('../canvas.js', () => ({
  applyTransform: vi.fn(), saveViewport: vi.fn(), updateCulling: vi.fn(),
  invalidateOverviewCache: vi.fn(), toast: vi.fn(), showConfirm: vi.fn(),
}));
vi.mock('../edges.js', () => ({ renderEdge: vi.fn() }));
vi.mock('../items.js', () => ({ createItem: vi.fn() }));
vi.mock('../history.js', () => ({ saveTabHistory: vi.fn(), restoreTabHistory: vi.fn() }));

import { moveTab } from '../tabs.js';

function makeCtx(): { ctx: Ctx; putTab: ReturnType<typeof vi.fn> } {
  const putTab = vi.fn<(t: TabData) => Promise<void>>().mockResolvedValue();
  const adapter = {
    putItem: async (_i: ItemData) => {}, deleteItem: async (_id: number) => {},
    getAllItems: async () => [], getItemsForTab: async (_t: number) => [],
    putTab, deleteTab: async (_id: number) => {}, getAllTabs: async () => [],
    putEdge: async (_e: EdgeData) => {}, deleteEdge: async (_id: number) => {},
    getAllEdges: async () => [], getEdgesForTab: async (_t: number) => [],
    saveViewport: async (_t: number, _s: ViewportState) => {}, loadViewport: async (_t: number) => null,
    deleteViewport: async (_t: number) => {}, saveActiveTab: async (_t: number) => {}, loadActiveTab: async () => null,
    saveTabLayout: async (_l: TabLayout) => {}, loadTabLayout: async () => null,
  } as StorageAdapter;
  const ctx = {
    adapter,
    tabs: [
      { id: 1, name: 'A', order: 0 },
      { id: 2, name: 'B', order: 1 },
      { id: 3, name: 'C', order: 2 },
    ],
  } as unknown as Ctx;
  return { ctx, putTab };
}

describe('moveTab', () => {
  it('moves the first tab to the end and reassigns order', () => {
    const { ctx, putTab } = makeCtx();

    moveTab(ctx, 0, 2);

    expect(ctx.tabs.map(t => t.id)).toEqual([2, 3, 1]);
    expect(ctx.tabs.map(t => t.order)).toEqual([0, 1, 2]);
    expect(putTab).toHaveBeenCalledTimes(3);
    expect(putTab.mock.calls.map(c => (c[0] as TabData).id).sort()).toEqual([1, 2, 3]);
  });

  it('moves a middle tab to the front', () => {
    const { ctx } = makeCtx();

    moveTab(ctx, 1, 0);

    expect(ctx.tabs.map(t => t.id)).toEqual([2, 1, 3]);
    expect(ctx.tabs.map(t => t.order)).toEqual([0, 1, 2]);
  });

  it('is a no-op when from === to', () => {
    const { ctx, putTab } = makeCtx();

    moveTab(ctx, 1, 1);

    expect(ctx.tabs.map(t => t.id)).toEqual([1, 2, 3]);
    expect(putTab).not.toHaveBeenCalled();
  });
});

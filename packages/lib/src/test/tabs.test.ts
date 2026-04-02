import { describe, expect, it, vi } from 'vitest';
import type { Ctx, StorageAdapter, TabData, ViewportState, ItemData, EdgeData } from '../types.js';

vi.mock('../canvas.js', () => ({
  applyTransform: vi.fn(),
  saveViewport: vi.fn(),
  updateCulling: vi.fn(),
  invalidateOverviewCache: vi.fn(),
  toast: vi.fn(),
  showConfirm: vi.fn(),
}));

vi.mock('../edges.js', () => ({
  renderEdge: vi.fn(),
}));

vi.mock('../items.js', () => ({
  createItem: vi.fn(),
}));

vi.mock('../history.js', () => ({
  saveTabHistory: vi.fn(),
  restoreTabHistory: vi.fn(),
}));

import { deleteTab, loadTab } from '../tabs.js';

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
    ...overrides,
  };
}

function makeCtx(adapter: StorageAdapter): Ctx {
  return {
    surface: {} as HTMLDivElement,
    viewport: {} as HTMLDivElement,
    edgeLayer: {} as SVGSVGElement,
    overviewCanvas: {} as HTMLCanvasElement,
    marqueeEl: {} as HTMLDivElement,
    zoomLabel: {} as HTMLSpanElement,
    coordsLabel: {} as HTMLSpanElement,
    tabBar: {} as HTMLDivElement,
    toastEl: {} as HTMLDivElement,
    scale: 1,
    panX: 0,
    panY: 0,
    items: [],
    selectedItems: new Set(),
    itemCounter: 0,
    zCounter: 0,
    itemsById: new Map(),
    tabs: [],
    currentTabId: 1,
    tabCounter: 1,
    placeOffset: 0,
    edges: [],
    selectedEdges: new Set(),
    edgeCounter: 0,
    nodeEdgeMap: new Map(),
    draggingEdge: false,
    undoStack: [],
    redoStack: [],
    tabHistory: new Map(),
    toastTimer: null,
    vpSaveTimer: null,
    arrowheadId: 'arrow',
    signal: new AbortController().signal,
    adapter,
    itemPlugins: new Map(),
    canvasPlugins: [],
    edgeDropType: 'note',
  };
}

describe('loadTab', () => {
  it('uses tab-scoped item and edge reads', async () => {
    const getAllItems = vi.fn<() => Promise<ItemData[]>>().mockResolvedValue([]);
    const getItemsForTab = vi.fn<(tabId: number) => Promise<ItemData[]>>().mockResolvedValue([]);
    const getAllEdges = vi.fn<() => Promise<EdgeData[]>>().mockResolvedValue([]);
    const getEdgesForTab = vi.fn<(tabId: number) => Promise<EdgeData[]>>().mockResolvedValue([]);
    const adapter = makeAdapter({
      getAllItems,
      getItemsForTab,
      getAllEdges,
      getEdgesForTab,
    });

    await loadTab(makeCtx(adapter), 2);

    expect(getItemsForTab).toHaveBeenCalledWith(2);
    expect(getEdgesForTab).toHaveBeenCalledWith(2);
    expect(getAllItems).not.toHaveBeenCalled();
    expect(getAllEdges).not.toHaveBeenCalled();
  });
});

describe('deleteTab', () => {
  it('uses tab-scoped item and edge reads', async () => {
    const makeEl = () => ({
      style: {},
      appendChild: () => {},
      addEventListener: () => {},
      remove: () => {},
    });
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      if (tag === 'div' || tag === 'span' || tag === 'button') {
        return makeEl() as unknown as HTMLElement;
      }
      return originalCreateElement(tag, options);
    }) as typeof document.createElement);

    const getAllItems = vi.fn<() => Promise<ItemData[]>>().mockResolvedValue([]);
    const getItemsForTab = vi.fn<(tabId: number) => Promise<ItemData[]>>().mockResolvedValue([
      { id: 9, type: 'img', tabId: 2, x: 0, y: 0, w: 10, h: 10, zIndex: 1 },
    ]);
    const getAllEdges = vi.fn<() => Promise<EdgeData[]>>().mockResolvedValue([]);
    const getEdgesForTab = vi.fn<(tabId: number) => Promise<EdgeData[]>>().mockResolvedValue([
      { id: 4, tabId: 2, fromNode: 9, fromSide: 'left', toNode: 9, toSide: 'right' },
    ]);
    const deleteItem = vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
    const deleteEdge = vi.fn<(id: number) => Promise<void>>().mockResolvedValue(undefined);
    const adapter = makeAdapter({
      getAllItems,
      getItemsForTab,
      deleteItem,
      getAllEdges,
      getEdgesForTab,
      deleteEdge,
    });
    const ctx = makeCtx(adapter);
    ctx.tabs = [
      { id: 1, name: 'A', order: 0 },
      { id: 2, name: 'B', order: 1 },
    ];
    ctx.currentTabId = 1;
    const addBtn = {} as HTMLButtonElement;
    ctx.tabBar = {
      querySelectorAll: () => [] as Element[],
      querySelector: () => addBtn,
      insertBefore: () => addBtn,
    } as unknown as HTMLDivElement;

    try {
      await deleteTab(ctx, 2);

      expect(getItemsForTab).toHaveBeenCalledWith(2);
      expect(getEdgesForTab).toHaveBeenCalledWith(2);
      expect(getAllItems).not.toHaveBeenCalled();
      expect(getAllEdges).not.toHaveBeenCalled();
      expect(deleteItem).toHaveBeenCalledWith(9);
      expect(deleteEdge).toHaveBeenCalledWith(4);
    } finally {
      createElementSpy.mockRestore();
    }
  });
});

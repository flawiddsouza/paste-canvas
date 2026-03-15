// ── Serialisable data types (persisted via StorageAdapter) ─────────────────

import type { BoundView, ItemPlugin } from './plugin.js';

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface ItemData {
  id: number;
  type: string;                               // was: 'note' | 'img' | 'group'
  tabId: number;
  x: number; y: number; w: number; h: number;
  zIndex: number;
  groupId?: number;
  pluginData?: unknown;
  binaryData?: Record<string, ArrayBuffer>;
  binaryKeys?: string[];
  // Legacy fields — kept for migration shim; fall away naturally after write-through
  text?: string; color?: string; width?: number; height?: number;
  imageData?: ArrayBuffer; imageType?: string; label?: string;
}

export interface TabData {
  id: number;
  name: string;
  order: number;
}

export interface EdgeData {
  id: number;
  tabId: number;
  fromNode: number;
  fromSide: Side;
  toNode: number;
  toSide: Side;
  label?: string;
}

export interface ViewportState {
  panX: number;
  panY: number;
  scale: number;
}

// ── Runtime records (hold live DOM references) ──────────────────────────────

export interface ItemRecord {
  id: number;
  el: HTMLDivElement;
  type: string;          // was: 'note' | 'img' | 'group'
  x: number; y: number; w: number; h: number;
  bound: BoundView;      // replaces contentEl, labelEl, _autoGrowLabel, color
  mounted: boolean;
  groupId?: number;
}

export interface EdgeRecord {
  id: number;
  tabId: number;
  fromNode: number;
  fromSide: Side;
  toNode: number;
  toSide: Side;
  label?: string;
  pathEl: SVGPathElement;
  hitEl: SVGPathElement;
  svgEl: SVGSVGElement;
  labelTextEl?: SVGTextElement;
  inputEl?: HTMLInputElement;
}

// ── Snapshots (used by undo/redo commands) ──────────────────────────────────

export interface SnapItem {
  id: number; type: string;
  x: number; y: number; w?: number; h?: number;
  zIndex: number; groupId?: number;
  pluginSnap:    unknown;
  snapResources: string[];
}

export interface SnapEdge {
  id: number;
  tabId: number;
  fromNode: number;
  fromSide: Side;
  toNode: number;
  toSide: Side;
  label?: string;
}

export interface UndoCmd {
  label?: string;
  protectedResources?: string[];   // was: _blobUrl?: string
  undo(): number[];
  redo(): number[];
  dispose?(): void;
}

// ── Storage adapter interface ───────────────────────────────────────────────

export interface StorageAdapter {
  // Items
  putItem(item: ItemData): Promise<void>;
  deleteItem(id: number): Promise<void>;
  getAllItems(): Promise<ItemData[]>;

  // Tabs
  putTab(tab: TabData): Promise<void>;
  deleteTab(id: number): Promise<void>;
  getAllTabs(): Promise<TabData[]>;

  // Edges
  putEdge(edge: EdgeData): Promise<void>;
  deleteEdge(id: number): Promise<void>;
  getAllEdges(): Promise<EdgeData[]>;

  // Viewport & active tab
  saveViewport(tabId: number, state: ViewportState): Promise<void>;
  loadViewport(tabId: number): Promise<ViewportState | null>;
  saveActiveTab(tabId: number): Promise<void>;
  loadActiveTab(): Promise<number | null>;
}

// ── Shared context (owned by PasteCanvas, passed to all sub-module fns) ─────

export interface Ctx {
  // DOM
  surface: HTMLDivElement;
  viewport: HTMLDivElement;
  edgeLayer: SVGSVGElement;
  overviewCanvas: HTMLCanvasElement;
  marqueeEl: HTMLDivElement;
  zoomLabel: HTMLSpanElement;
  coordsLabel: HTMLSpanElement;
  tabBar: HTMLDivElement;
  toastEl: HTMLDivElement;

  // Transform state
  scale: number;
  panX: number;
  panY: number;

  // Items
  items: ItemRecord[];
  selectedItems: Set<ItemRecord>;
  itemCounter: number;
  zCounter: number;
  itemsById: Map<number, ItemRecord>;

  // Tabs
  tabs: TabData[];
  currentTabId: number | null;
  tabCounter: number;
  placeOffset: number;

  // Edges
  edges: EdgeRecord[];
  selectedEdges: Set<EdgeRecord>;
  edgeCounter: number;
  nodeEdgeMap: Map<number, Set<EdgeRecord>>;
  editingEdge?: EdgeRecord;
  draggingEdge: boolean;

  // History
  undoStack: UndoCmd[];
  redoStack: UndoCmd[];
  tabHistory: Map<number, { undoStack: UndoCmd[]; redoStack: UndoCmd[] }>;

  // Internal timers
  toastTimer: ReturnType<typeof setTimeout> | null;
  vpSaveTimer: ReturnType<typeof setTimeout> | null;

  // Instance
  arrowheadId: string;
  signal: AbortSignal;

  // Adapter
  adapter: StorageAdapter;
  itemPlugins: Map<string, ItemPlugin>;

  // Config
  edgeDropType: string;
}

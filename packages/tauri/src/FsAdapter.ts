import type { StorageAdapter, ItemData, TabData, EdgeData, ViewportState } from '@paste-canvas/lib';
import {
  readTextFile, writeTextFile,
  readFile, writeFile,
  mkdir, exists, remove,
} from '@tauri-apps/plugin-fs';

// ── On-disk formats ───────────────────────────────────────────────────────

interface WorkspaceFile {
  version: 1;
  tabs: TabData[];
  activeTabId: number | null;
}

type ItemRecord = Omit<ItemData, 'imageData'>;

interface BoardFile {
  items: ItemRecord[];
  edges: EdgeData[];
}

type ViewportFile = Record<string, ViewportState>;

// ── FsAdapter ─────────────────────────────────────────────────────────────

export class FsAdapter implements StorageAdapter {
  // In-memory caches — loaded from disk at open(), kept in sync on writes
  private tabs      = new Map<number, TabData>();
  private edges     = new Map<number, EdgeData>();
  private items     = new Map<number, ItemRecord>();
  private viewports: ViewportFile = {};
  private activeTabId: number | null = null;

  private constructor(
    private readonly folder: string,
    private readonly onDirty: () => void,
    private readonly onWrite: () => void,
    private readonly onNavSave: () => void,
  ) {}

  // ── Paths ─────────────────────────────────────────────────────────────

  private wsPath()               { return `${this.folder}/workspace.json`; }
  private vpPath()               { return `${this.folder}/viewport.json`; }
  private boardPath(tabId: number) { return `${this.folder}/board-${tabId}.json`; }
  private imgPath(itemId: number)  { return `${this.folder}/images/${itemId}.bin`; }

  // ── Static factory ────────────────────────────────────────────────────

  static async open(folder: string, onDirty: () => void, onWrite: () => void, onNavSave: () => void): Promise<FsAdapter> {
    const a = new FsAdapter(folder, onDirty, onWrite, onNavSave);

    const imagesDir = `${folder}/images`;
    if (!(await exists(imagesDir))) await mkdir(imagesDir, { recursive: true });

    const wsPath = a.wsPath();
    if (await exists(wsPath)) {
      const ws: WorkspaceFile = JSON.parse(await readTextFile(wsPath));
      a.activeTabId = ws.activeTabId;
      for (const tab of ws.tabs) a.tabs.set(tab.id, tab);
    } else {
      await writeTextFile(wsPath, JSON.stringify({ version: 1, tabs: [], activeTabId: null }, null, 2));
    }

    const vpPath = a.vpPath();
    if (await exists(vpPath)) {
      a.viewports = JSON.parse(await readTextFile(vpPath));
    }

    for (const tab of a.tabs.values()) {
      const bp = a.boardPath(tab.id);
      if (await exists(bp)) {
        const board: BoardFile = JSON.parse(await readTextFile(bp));
        for (const item of board.items) a.items.set(item.id, item);
        for (const edge of board.edges) a.edges.set(edge.id, edge);
      }
    }

    return a;
  }

  // ── Flush helpers ─────────────────────────────────────────────────────

  private async flushWorkspace(): Promise<void> {
    this.onWrite();
    const ws: WorkspaceFile = {
      version: 1,
      tabs: [...this.tabs.values()],
      activeTabId: this.activeTabId,
    };
    await writeTextFile(this.wsPath(), JSON.stringify(ws, null, 2));
  }

  private async flushBoard(tabId: number): Promise<void> {
    this.onWrite();
    const items = [...this.items.values()].filter(i => i.tabId === tabId);
    const edges = [...this.edges.values()].filter(e => e.tabId === tabId);
    await writeTextFile(this.boardPath(tabId), JSON.stringify({ items, edges } satisfies BoardFile, null, 2));
  }

  private async flushViewports(): Promise<void> {
    this.onWrite();
    await writeTextFile(this.vpPath(), JSON.stringify(this.viewports, null, 2));
  }

  async flushAll(): Promise<void> {
    await this.flushWorkspace();
    await this.flushViewports();
    const tabIds = new Set([...this.items.values()].map(i => i.tabId));
    for (const tab of this.tabs.values()) tabIds.add(tab.id);
    for (const tabId of tabIds) await this.flushBoard(tabId);
  }

  // ── StorageAdapter — Items ────────────────────────────────────────────

  async putItem(item: ItemData): Promise<void> {
    const { imageData, ...rest } = item;
    if (item.type === 'img' && imageData) {
      this.onWrite();
      await writeFile(this.imgPath(item.id), new Uint8Array(imageData));
    }
    this.items.set(item.id, rest);
    await this.flushBoard(item.tabId);
    this.onDirty();
  }

  async deleteItem(id: number): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    this.onWrite();
    const ip = this.imgPath(id);
    if (await exists(ip)) await remove(ip);
    await this.flushBoard(item.tabId);
    this.onDirty();
  }

  async getAllItems(): Promise<ItemData[]> {
    const results: ItemData[] = [];
    for (const item of this.items.values()) {
      if (item.type === 'img') {
        const ip = this.imgPath(item.id);
        if (await exists(ip)) {
          const bytes = await readFile(ip);
          const imageData = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          results.push({ ...item, imageData });
        } else {
          results.push({ ...item });
        }
      } else {
        results.push({ ...item });
      }
    }
    return results;
  }

  // ── StorageAdapter — Tabs ─────────────────────────────────────────────

  async putTab(tab: TabData): Promise<void> {
    this.tabs.set(tab.id, tab);
    await this.flushWorkspace();
    this.onDirty();
  }

  async deleteTab(id: number): Promise<void> {
    this.tabs.delete(id);
    this.onWrite();
    const bp = this.boardPath(id);
    if (await exists(bp)) await remove(bp);
    await this.flushWorkspace();
    this.onDirty();
  }

  async getAllTabs(): Promise<TabData[]> {
    return [...this.tabs.values()];
  }

  // ── StorageAdapter — Edges ────────────────────────────────────────────

  async putEdge(edge: EdgeData): Promise<void> {
    this.edges.set(edge.id, edge);
    await this.flushBoard(edge.tabId);
    this.onDirty();
  }

  async deleteEdge(id: number): Promise<void> {
    const edge = this.edges.get(id);
    if (!edge) return;
    this.edges.delete(id);
    await this.flushBoard(edge.tabId);
    this.onDirty();
  }

  async getAllEdges(): Promise<EdgeData[]> {
    return [...this.edges.values()];
  }

  // ── StorageAdapter — Viewport & active tab ────────────────────────────

  async saveViewport(tabId: number, state: ViewportState): Promise<void> {
    this.viewports[String(tabId)] = state;
    await this.flushViewports();
    this.onNavSave();
  }

  async loadViewport(tabId: number): Promise<ViewportState | null> {
    return this.viewports[String(tabId)] ?? null;
  }

  async saveActiveTab(tabId: number): Promise<void> {
    this.activeTabId = tabId;
    await this.flushWorkspace();
    this.onNavSave();
  }

  async loadActiveTab(): Promise<number | null> {
    return this.activeTabId;
  }
}

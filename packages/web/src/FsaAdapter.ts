// packages/web/src/FsaAdapter.ts
import type { StorageAdapter, ItemData, TabData, EdgeData, ViewportState } from '@paste-canvas/lib';

// ── On-disk formats ───────────────────────────────────────────────────────

interface WorkspaceFile {
  version: 1;
  tabs: TabData[];
  activeTabId: number | null;
}

type ItemRecord = Omit<ItemData, 'binaryData'>;

interface BoardFile {
  items: ItemRecord[];
  edges: EdgeData[];
}

type ViewportFile = Record<string, ViewportState>;

// ── File operation helpers ────────────────────────────────────────────────

async function readText(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<string | null> {
  try {
    const fh = await dir.getFileHandle(name);
    return await (await fh.getFile()).text();
  } catch (e) {
    if ((e as DOMException).name === 'NotFoundError') return null;
    throw e;
  }
}

async function writeText(
  dir: FileSystemDirectoryHandle,
  name: string,
  content: string,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable({ keepExistingData: false });
  await w.write(content);
  await w.close();
}

async function readBinary(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<ArrayBuffer | null> {
  try {
    const fh = await dir.getFileHandle(name);
    return await (await fh.getFile()).arrayBuffer();
  } catch (e) {
    if ((e as DOMException).name === 'NotFoundError') return null;
    throw e;
  }
}

async function writeBinary(
  dir: FileSystemDirectoryHandle,
  name: string,
  buf: ArrayBuffer,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable({ keepExistingData: false });
  await w.write(buf);
  await w.close();
}

async function removeEntry(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch (e) {
    if ((e as DOMException).name === 'NotFoundError') return;
    throw e;
  }
}

// ── FsaAdapter ────────────────────────────────────────────────────────────

export class FsaAdapter implements StorageAdapter {
  // In-memory caches — loaded at open(), kept in sync on every write.
  // Item/edge IDs are globally unique across the workspace (invariant enforced by lib).
  private tabs      = new Map<number, TabData>();
  private edges     = new Map<number, EdgeData>();
  private items     = new Map<number, ItemRecord>();
  private viewports: ViewportFile = {};
  private activeTabId: number | null = null;

  private constructor(
    private readonly rootDirHandle: FileSystemDirectoryHandle,
    private readonly imagesDirHandle: FileSystemDirectoryHandle,
    private readonly onDirty: () => void,
    private readonly onWrite: () => void,
    private readonly onNavSave: () => void,
  ) {}

  // ── Name helpers ────────────────────────────────────────────────────────

  private binName(itemId: number, key: string): string {
    return key === 'image' ? `${itemId}.bin` : `${itemId}-${key}.bin`;
  }

  private boardName(tabId: number): string {
    return `board-${tabId}.json`;
  }

  // ── Static factory ──────────────────────────────────────────────────────

  static async open(
    dirHandle: FileSystemDirectoryHandle,
    onDirty: () => void,
    onWrite: () => void,
    onNavSave: () => void,
  ): Promise<FsaAdapter> {
    const imagesDirHandle = await dirHandle.getDirectoryHandle('images', { create: true });
    const a = new FsaAdapter(dirHandle, imagesDirHandle, onDirty, onWrite, onNavSave);

    // workspace.json — note: no onWrite() here (no lock context yet)
    const wsText = await readText(dirHandle, 'workspace.json');
    if (wsText) {
      const ws: WorkspaceFile = JSON.parse(wsText);
      a.activeTabId = ws.activeTabId;
      for (const tab of ws.tabs) a.tabs.set(tab.id, tab);
    } else {
      await writeText(
        dirHandle,
        'workspace.json',
        JSON.stringify({ version: 1, tabs: [], activeTabId: null } satisfies WorkspaceFile, null, 2),
      );
    }

    // viewport.json
    const vpText = await readText(dirHandle, 'viewport.json');
    if (vpText) a.viewports = JSON.parse(vpText);

    // board files
    for (const tab of a.tabs.values()) {
      const boardText = await readText(dirHandle, a.boardName(tab.id));
      if (boardText) {
        const board: BoardFile = JSON.parse(boardText);
        for (const item of board.items) a.items.set(item.id, item);
        for (const edge of board.edges) a.edges.set(edge.id, edge);
      }
    }

    return a;
  }

  // ── Flush helpers ────────────────────────────────────────────────────────

  private async flushWorkspace(): Promise<void> {
    this.onWrite();
    const ws: WorkspaceFile = {
      version: 1,
      tabs: [...this.tabs.values()],
      activeTabId: this.activeTabId,
    };
    await writeText(this.rootDirHandle, 'workspace.json', JSON.stringify(ws, null, 2));
  }

  private async flushBoard(tabId: number): Promise<void> {
    this.onWrite();
    const items = [...this.items.values()].filter(i => i.tabId === tabId);
    const edges = [...this.edges.values()].filter(e => e.tabId === tabId);
    await writeText(
      this.rootDirHandle,
      this.boardName(tabId),
      JSON.stringify({ items, edges } satisfies BoardFile, null, 2),
    );
  }

  private async flushViewports(): Promise<void> {
    this.onWrite();
    await writeText(this.rootDirHandle, 'viewport.json', JSON.stringify(this.viewports, null, 2));
  }

  private async materializeItems(items: Iterable<ItemRecord>): Promise<ItemData[]> {
    const results: ItemData[] = [];
    for (const item of items) {
      if (item.binaryKeys?.length) {
        const binaryData: Record<string, ArrayBuffer> = {};
        for (const key of item.binaryKeys) {
          const buf = await readBinary(this.imagesDirHandle, this.binName(item.id, key));
          if (buf) binaryData[key] = buf;
        }
        results.push({ ...item, binaryData });
      } else {
        results.push({ ...item });
      }
    }
    return results;
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
    const { binaryData, ...rest } = item;
    if (binaryData) {
      for (const [key, buf] of Object.entries(binaryData)) {
        this.onWrite();
        await writeBinary(this.imagesDirHandle, this.binName(item.id, key), buf);
      }
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
    const keys = item.binaryKeys ?? [];
    for (const key of keys) {
      await removeEntry(this.imagesDirHandle, this.binName(id, key));
    }
    await this.flushBoard(item.tabId);
    this.onDirty();
  }

  async getAllItems(): Promise<ItemData[]> {
    return this.materializeItems(this.items.values());
  }

  async getItemsForTab(tabId: number): Promise<ItemData[]> {
    return this.materializeItems(
      [...this.items.values()].filter(item => item.tabId === tabId)
    );
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
    await removeEntry(this.rootDirHandle, this.boardName(id));
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

  async getEdgesForTab(tabId: number): Promise<EdgeData[]> {
    return [...this.edges.values()].filter(edge => edge.tabId === tabId);
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

  async deleteViewport(tabId: number): Promise<void> {
    delete this.viewports[String(tabId)];
    await this.flushViewports();
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

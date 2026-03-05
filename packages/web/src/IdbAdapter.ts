import type { StorageAdapter, ItemData, TabData, EdgeData, ViewportState } from '@paste-canvas/lib';

const DB_NAME    = 'paste-canvas';
const DB_VERSION = 3;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = (e.target as IDBOpenDBRequest).result;
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta'))  d.createObjectStore('meta',  { keyPath: 'key' });
      if (!d.objectStoreNames.contains('tabs'))  d.createObjectStore('tabs',  { keyPath: 'id' });
      if (!d.objectStoreNames.contains('edges')) d.createObjectStore('edges', { keyPath: 'id' });
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror   = (e) => reject((e.target as IDBOpenDBRequest).error);
  });
}

function put(db: IDBDatabase, store: string, value: unknown): void {
  db.transaction(store, 'readwrite').objectStore(store).put(value);
}

function del(db: IDBDatabase, store: string, key: IDBValidKey): void {
  db.transaction(store, 'readwrite').objectStore(store).delete(key);
}

function getAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = (e) => resolve((e.target as IDBRequest<T[]>).result);
    req.onerror   = () => resolve([]);
  });
}

function get<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | null> {
  return new Promise((resolve) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = (e) => resolve(((e.target as IDBRequest<T>).result) ?? null);
    req.onerror   = () => resolve(null);
  });
}

export class IdbAdapter implements StorageAdapter {
  private readonly db = openDB();

  async putItem(item: ItemData): Promise<void> {
    put(await this.db, 'items', item);
  }

  async deleteItem(id: number): Promise<void> {
    del(await this.db, 'items', id);
  }

  async getAllItems(): Promise<ItemData[]> {
    return getAll<ItemData>(await this.db, 'items');
  }

  async putTab(tab: TabData): Promise<void> {
    put(await this.db, 'tabs', tab);
  }

  async deleteTab(id: number): Promise<void> {
    del(await this.db, 'tabs', id);
  }

  async getAllTabs(): Promise<TabData[]> {
    return getAll<TabData>(await this.db, 'tabs');
  }

  async putEdge(edge: EdgeData): Promise<void> {
    put(await this.db, 'edges', edge);
  }

  async deleteEdge(id: number): Promise<void> {
    del(await this.db, 'edges', id);
  }

  async getAllEdges(): Promise<EdgeData[]> {
    return getAll<EdgeData>(await this.db, 'edges');
  }

  async saveViewport(tabId: number, state: ViewportState): Promise<void> {
    put(await this.db, 'meta', { key: `viewport-${tabId}`, ...state });
  }

  async loadViewport(tabId: number): Promise<ViewportState | null> {
    const row = await get<{ key: string } & ViewportState>(await this.db, 'meta', `viewport-${tabId}`);
    if (!row) return null;
    return { panX: row.panX, panY: row.panY, scale: row.scale };
  }

  async saveActiveTab(tabId: number): Promise<void> {
    put(await this.db, 'meta', { key: 'activeTab', tabId });
  }

  async loadActiveTab(): Promise<number | null> {
    const row = await get<{ key: string; tabId: number }>(await this.db, 'meta', 'activeTab');
    return row?.tabId ?? null;
  }
}

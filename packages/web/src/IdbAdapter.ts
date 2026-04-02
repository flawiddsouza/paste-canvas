import type { StorageAdapter, ItemData, TabData, EdgeData, ViewportState } from '@paste-canvas/lib';

const DB_NAME    = 'paste-canvas';
const DB_VERSION = 5;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d  = (e.target as IDBOpenDBRequest).result;
      const tx = (e.target as IDBOpenDBRequest).transaction!;

      // Store creation (no-ops if already exist — required for fresh installs at any old version)
      if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta'))  d.createObjectStore('meta',  { keyPath: 'key' });
      if (!d.objectStoreNames.contains('tabs'))  d.createObjectStore('tabs',  { keyPath: 'id' });
      if (!d.objectStoreNames.contains('edges')) d.createObjectStore('edges', { keyPath: 'id' });
      const itemsStore = tx.objectStore('items');
      const edgesStore = tx.objectStore('edges');
      if (!itemsStore.indexNames.contains('tabId')) itemsStore.createIndex('tabId', 'tabId');
      if (!edgesStore.indexNames.contains('tabId')) edgesStore.createIndex('tabId', 'tabId');

      // v3 → v4: migrate items from legacy per-field format to pluginData/binaryData
      if (e.oldVersion < 4 && e.oldVersion > 0) {
        const cursorReq = itemsStore.openCursor();
        cursorReq.onsuccess = (ev) => {
          const cursor = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const item = cursor.value as Record<string, unknown>;
          if (item.pluginData === undefined) {
            if (item.type === 'note' || item.type === 'group') {
              item.pluginData = { text: item.text, color: item.color, width: item.width };
              // Note: height is intentionally omitted — NotePlugin.hydrate() does not read it
            } else if (item.type === 'img') {
              item.pluginData = { label: item.label, displayW: item.width };
              if (item.imageData) {
                item.binaryData = { image: item.imageData };
                item.binaryKeys = ['image'];
              }
            }
          }
          delete item.text; delete item.color; delete item.width; delete item.height;
          delete item.imageData; delete item.imageType; delete item.label;
          cursor.update(item);
          cursor.continue();
        };

        // Migrate legacy viewport stored at key `viewport-0` (old single-tab format)
        // Re-key it to `viewport-{firstTabId}` if a first tab exists
        const vpReq = tx.objectStore('meta').get('viewport-0');
        vpReq.onsuccess = (ev) => {
          const vp = (ev.target as IDBRequest).result;
          if (!vp) return;
          const tabReq = tx.objectStore('tabs').getAll();
          tabReq.onsuccess = (ev2) => {
            const tabs = ((ev2.target as IDBRequest).result as TabData[])
              .sort((a, b) => a.order - b.order);
            if (tabs.length > 0) {
              tx.objectStore('meta').put({ key: `viewport-${tabs[0].id}`, panX: vp.panX, panY: vp.panY, scale: vp.scale });
            }
            tx.objectStore('meta').delete('viewport-0');
          };
        };
      }
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

function getAllByIndex<T>(
  db: IDBDatabase,
  store: string,
  index: string,
  key: IDBValidKey,
): Promise<T[]> {
  return new Promise((resolve) => {
    const req = db.transaction(store).objectStore(store).index(index).getAll(key);
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

  async getItemsForTab(tabId: number): Promise<ItemData[]> {
    return getAllByIndex<ItemData>(await this.db, 'items', 'tabId', tabId);
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

  async getEdgesForTab(tabId: number): Promise<EdgeData[]> {
    return getAllByIndex<EdgeData>(await this.db, 'edges', 'tabId', tabId);
  }

  async saveViewport(tabId: number, state: ViewportState): Promise<void> {
    put(await this.db, 'meta', { key: `viewport-${tabId}`, ...state });
  }

  async loadViewport(tabId: number): Promise<ViewportState | null> {
    const row = await get<{ key: string } & ViewportState>(await this.db, 'meta', `viewport-${tabId}`);
    if (!row) return null;
    return { panX: row.panX, panY: row.panY, scale: row.scale };
  }

  async deleteViewport(tabId: number): Promise<void> {
    del(await this.db, 'meta', `viewport-${tabId}`);
  }

  async saveActiveTab(tabId: number): Promise<void> {
    put(await this.db, 'meta', { key: 'activeTab', tabId });
  }

  async loadActiveTab(): Promise<number | null> {
    const row = await get<{ key: string; tabId: number }>(await this.db, 'meta', 'activeTab');
    return row?.tabId ?? null;
  }
}

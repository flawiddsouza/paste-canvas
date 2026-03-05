import type { StorageAdapter, ItemData, TabData, EdgeData, ViewportState } from '@paste-canvas/lib';

export class MemoryAdapter implements StorageAdapter {
  private items     = new Map<number, ItemData>();
  private tabs      = new Map<number, TabData>();
  private edges     = new Map<number, EdgeData>();
  private viewports = new Map<number, ViewportState>();
  private activeTab: number | null = null;

  async putItem(item: ItemData): Promise<void>         { this.items.set(item.id, item); }
  async deleteItem(id: number): Promise<void>          { this.items.delete(id); }
  async getAllItems(): Promise<ItemData[]>              { return [...this.items.values()]; }

  async putTab(tab: TabData): Promise<void>            { this.tabs.set(tab.id, tab); }
  async deleteTab(id: number): Promise<void>           { this.tabs.delete(id); }
  async getAllTabs(): Promise<TabData[]>                { return [...this.tabs.values()]; }

  async putEdge(edge: EdgeData): Promise<void>         { this.edges.set(edge.id, edge); }
  async deleteEdge(id: number): Promise<void>          { this.edges.delete(id); }
  async getAllEdges(): Promise<EdgeData[]>              { return [...this.edges.values()]; }

  async saveViewport(tabId: number, state: ViewportState): Promise<void> { this.viewports.set(tabId, state); }
  async loadViewport(tabId: number): Promise<ViewportState | null>       { return this.viewports.get(tabId) ?? null; }

  async saveActiveTab(tabId: number): Promise<void>    { this.activeTab = tabId; }
  async loadActiveTab(): Promise<number | null>        { return this.activeTab; }
}

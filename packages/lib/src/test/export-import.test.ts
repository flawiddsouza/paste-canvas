import { describe, it, expect } from 'vitest';
import { encodePcvs, decodePcvs, PcvsFormatError, exportCanvas, importCanvas } from '../export-import.js';
import type { StorageAdapter, ItemData, TabData, EdgeData, ViewportState } from '../types.js';

// ── Mock adapter ──────────────────────────────────────────────────────────────

function makeMockAdapter(initial?: {
  tabs?: TabData[];
  items?: ItemData[];
  edges?: EdgeData[];
  viewports?: Record<number, ViewportState>;
}): StorageAdapter & { _tabs: TabData[]; _items: ItemData[]; _edges: EdgeData[] } {
  const tabs:  TabData[]  = [...(initial?.tabs  ?? [])];
  const items: ItemData[] = [...(initial?.items ?? [])];
  const edges: EdgeData[] = [...(initial?.edges ?? [])];
  const viewports = new Map<number, ViewportState>(
    Object.entries(initial?.viewports ?? {}).map(([k, v]) => [Number(k), v])
  );
  return {
    _tabs: tabs, _items: items, _edges: edges,
    putTab:        async (t) => { const i = tabs.findIndex(x => x.id === t.id); i >= 0 ? tabs[i] = t : tabs.push(t); },
    deleteTab:     async (id) => { const i = tabs.findIndex(t => t.id === id); if (i >= 0) tabs.splice(i, 1); },
    getAllTabs:     async () => [...tabs],
    putItem:       async (item) => { const i = items.findIndex(x => x.id === item.id); i >= 0 ? items[i] = item : items.push(item); },
    deleteItem:    async (id) => { const i = items.findIndex(x => x.id === id); if (i >= 0) items.splice(i, 1); },
    getAllItems:    async () => [...items],
    putEdge:       async (e) => { const i = edges.findIndex(x => x.id === e.id); i >= 0 ? edges[i] = e : edges.push(e); },
    deleteEdge:    async (id) => { const i = edges.findIndex(x => x.id === id); if (i >= 0) edges.splice(i, 1); },
    getAllEdges:    async () => [...edges],
    saveViewport:  async (tabId, state) => { viewports.set(tabId, state); },
    loadViewport:  async (tabId) => viewports.get(tabId) ?? null,
    deleteViewport: async (tabId) => { viewports.delete(tabId); },
    saveActiveTab: async () => {},
    loadActiveTab: async () => null,
  };
}

describe('encodePcvs / decodePcvs', () => {
  it('round-trips JSON with no blobs', () => {
    const json = '{"version":1,"tabs":[],"items":[],"edges":[],"viewports":{}}';
    const buf = encodePcvs(json, new Map());
    const result = decodePcvs(buf);
    expect(result.json).toBe(json);
    expect(result.blobs.size).toBe(0);
  });

  it('round-trips a single binary blob', () => {
    const data = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]).buffer;
    const blobs = new Map<string, ArrayBuffer>([['42:image', data]]);
    const buf = encodePcvs('{}', blobs);
    const result = decodePcvs(buf);
    expect(result.blobs.size).toBe(1);
    expect(new Uint8Array(result.blobs.get('42:image')!)).toEqual(
      new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])
    );
  });

  it('round-trips multiple blobs', () => {
    const blobs = new Map<string, ArrayBuffer>([
      ['1:image', new Uint8Array([1, 2]).buffer],
      ['2:thumb', new Uint8Array([3, 4, 5]).buffer],
    ]);
    const buf = encodePcvs('{}', blobs);
    const result = decodePcvs(buf);
    expect(result.blobs.size).toBe(2);
    expect(new Uint8Array(result.blobs.get('2:thumb')!)).toEqual(new Uint8Array([3, 4, 5]));
  });

  it('writes little-endian uint32 for JSON length', () => {
    const json = 'ab'; // 2 bytes
    const buf = encodePcvs(json, new Map());
    const view = new DataView(buf);
    expect(view.getUint32(6, true)).toBe(2);  // offset 6 = after magic(4) + version(2)
  });

  it('throws PcvsFormatError on empty buffer', () => {
    expect(() => decodePcvs(new ArrayBuffer(0))).toThrow(PcvsFormatError);
  });

  it('throws PcvsFormatError on wrong magic', () => {
    const buf = new ArrayBuffer(20);
    new Uint8Array(buf).set([0x00, 0x00, 0x00, 0x00]);
    expect(() => decodePcvs(buf)).toThrow(PcvsFormatError);
  });

  it('throws PcvsFormatError on unsupported version', () => {
    const json = '{}';
    const valid = encodePcvs(json, new Map());
    // Patch version to 999
    const view = new DataView(valid);
    view.setUint16(4, 999, true);
    expect(() => decodePcvs(valid)).toThrow(PcvsFormatError);
  });

  it('throws PcvsFormatError on truncated file', () => {
    const json = '{"version":1}';
    const full = encodePcvs(json, new Map());
    const truncated = full.slice(0, 8); // cut off mid-JSON
    expect(() => decodePcvs(truncated)).toThrow(PcvsFormatError);
  });
});

// ── exportCanvas / importCanvas tests ────────────────────────────────────────

describe('exportCanvas / importCanvas round-trip', () => {
  it('exports and re-imports a tab with a note', async () => {
    const src = makeMockAdapter({
      tabs:  [{ id: 1, name: 'Board 1', order: 1 }],
      items: [{ id: 1, type: 'note', tabId: 1, x: 10, y: 20, w: 180, h: 80, zIndex: 1,
                pluginData: { text: 'hello', color: 'yellow' } }],
      edges: [],
      viewports: { 1: { panX: 100, panY: 200, scale: 1.5 } },
    });

    const blob = await exportCanvas(src);
    expect(blob.size).toBeGreaterThan(0);

    const dst = makeMockAdapter();
    const { tabIds } = await importCanvas(dst, blob);
    expect(tabIds).toHaveLength(1);

    const tabs  = await dst.getAllTabs();
    const items = await dst.getAllItems();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].name).toBe('Board 1');
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('note');
    expect((items[0].pluginData as Record<string, unknown>)?.text).toBe('hello');
    expect(items[0].tabId).toBe(tabIds[0]);

    const vp = await dst.loadViewport(tabIds[0]);
    expect(vp?.scale).toBe(1.5);
  });

  it('remaps IDs to avoid collision with existing canvas data', async () => {
    const src = makeMockAdapter({
      tabs:  [{ id: 1, name: 'Tab', order: 1 }],
      items: [{ id: 1, type: 'note', tabId: 1, x: 0, y: 0, w: 100, h: 100, zIndex: 1,
                pluginData: { text: 'a' } }],
      edges: [],
    });

    const blob = await exportCanvas(src);

    const dst = makeMockAdapter({
      tabs:  [{ id: 1, name: 'Existing', order: 1 }],
      items: [{ id: 1, type: 'note', tabId: 1, x: 0, y: 0, w: 100, h: 100, zIndex: 1,
                pluginData: { text: 'existing' } }],
    });

    const { tabIds } = await importCanvas(dst, blob);
    const tabs  = await dst.getAllTabs();
    const items = await dst.getAllItems();

    expect(tabs).toHaveLength(2);
    expect(items).toHaveLength(2);
    expect(tabIds[0]).not.toBe(1);
    expect(items[1].tabId).toBe(tabIds[0]);
    expect(items[0].pluginData).toMatchObject({ text: 'existing' });
  });

  it('preserves groupId references after remapping', async () => {
    const src = makeMockAdapter({
      tabs:  [{ id: 1, name: 'T', order: 1 }],
      items: [
        { id: 1, type: 'group', tabId: 1, x: 0, y: 0, w: 200, h: 200, zIndex: 1 },
        { id: 2, type: 'note',  tabId: 1, x: 10, y: 10, w: 100, h: 100, zIndex: 2, groupId: 1 },
      ],
      edges: [],
    });

    const blob = await exportCanvas(src);
    const dst  = makeMockAdapter();
    await importCanvas(dst, blob);

    const items = await dst.getAllItems();
    const group  = items.find(i => i.type === 'group')!;
    const member = items.find(i => i.type === 'note')!;
    expect(member.groupId).toBe(group.id);
  });

  it('exports only the specified tab when tabId is given', async () => {
    const src = makeMockAdapter({
      tabs: [
        { id: 1, name: 'A', order: 1 },
        { id: 2, name: 'B', order: 2 },
      ],
      items: [
        { id: 1, type: 'note', tabId: 1, x: 0, y: 0, w: 100, h: 100, zIndex: 1, pluginData: {} },
        { id: 2, type: 'note', tabId: 2, x: 0, y: 0, w: 100, h: 100, zIndex: 1, pluginData: {} },
      ],
      edges: [],
    });

    const blob = await exportCanvas(src, 1);
    const dst  = makeMockAdapter();
    await importCanvas(dst, blob);

    const tabs  = await dst.getAllTabs();
    const items = await dst.getAllItems();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].name).toBe('A');
    expect(items).toHaveLength(1);
  });

  it('exports and re-imports binary data (image)', async () => {
    const imageData = new Uint8Array([137, 80, 78, 71]).buffer;
    const src = makeMockAdapter({
      tabs:  [{ id: 1, name: 'T', order: 1 }],
      items: [{
        id: 1, type: 'img', tabId: 1, x: 0, y: 0, w: 200, h: 150, zIndex: 1,
        pluginData: { label: 'test', displayW: 200 },
        binaryData: { image: imageData },
        binaryKeys: ['image'],
      }],
      edges: [],
    });

    const blob = await exportCanvas(src);
    const dst  = makeMockAdapter();
    await importCanvas(dst, blob);

    const items = await dst.getAllItems();
    expect(items[0].binaryData?.image).toBeDefined();
    expect(new Uint8Array(items[0].binaryData!.image)).toEqual(new Uint8Array(imageData));
  });

  it('returns empty tabIds for a file with no tabs', async () => {
    const src = makeMockAdapter({ tabs: [], items: [], edges: [] });
    const blob = await exportCanvas(src);
    const dst  = makeMockAdapter();
    const result = await importCanvas(dst, blob);
    expect(result.tabIds).toHaveLength(0);
  });

  it('throws PcvsFormatError for a corrupt file', async () => {
    const dst = makeMockAdapter();
    await expect(importCanvas(dst, new Blob([new ArrayBuffer(10)]))).rejects.toThrow(PcvsFormatError);
  });
});

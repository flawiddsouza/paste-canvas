import type { StorageAdapter, ItemData, TabData, EdgeData, ViewportState } from './types.js';

// ── Error ──────────────────────────────────────────────────────────────────────

export class PcvsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PcvsFormatError';
  }
}

// ── Binary format ─────────────────────────────────────────────────────────────
// Layout:
//   MAGIC(4) VERSION(2LE) JSON_LEN(4LE) JSON(N)
//   BLOB_COUNT(2LE) [ KEY_LEN(2LE) KEY(N) DATA_LEN(4LE) DATA(N) ]*

const MAGIC = [0x50, 0x43, 0x56, 0x53]; // "PCVS"
const VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodePcvs(json: string, blobs: Map<string, ArrayBuffer>): ArrayBuffer {
  const jsonBytes = encoder.encode(json);

  let blobsSize = 0;
  for (const [key, data] of blobs) {
    blobsSize += 2 + encoder.encode(key).length + 4 + data.byteLength;
  }

  const buf = new ArrayBuffer(4 + 2 + 4 + jsonBytes.length + 2 + blobsSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;

  bytes.set(MAGIC, offset);                           offset += 4;
  view.setUint16(offset, VERSION, true);              offset += 2;
  view.setUint32(offset, jsonBytes.length, true);     offset += 4;
  bytes.set(jsonBytes, offset);                       offset += jsonBytes.length;
  view.setUint16(offset, blobs.size, true);           offset += 2;

  for (const [key, data] of blobs) {
    const keyBytes = encoder.encode(key);
    view.setUint16(offset, keyBytes.length, true);    offset += 2;
    bytes.set(keyBytes, offset);                      offset += keyBytes.length;
    view.setUint32(offset, data.byteLength, true);    offset += 4;
    bytes.set(new Uint8Array(data), offset);          offset += data.byteLength;
  }

  return buf;
}

export function decodePcvs(buf: ArrayBuffer): { json: string; blobs: Map<string, ArrayBuffer> } {
  if (buf.byteLength < 10) throw new PcvsFormatError('File too short');

  const view  = new DataView(buf);
  const bytes = new Uint8Array(buf);

  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] ||
      bytes[2] !== MAGIC[2] || bytes[3] !== MAGIC[3]) {
    throw new PcvsFormatError('Invalid file format — not a .pcvs file');
  }

  const version = view.getUint16(4, true);
  if (version > VERSION) throw new PcvsFormatError(`Unsupported version: ${version}`);

  const jsonLen = view.getUint32(6, true);
  let offset = 10;

  if (offset + jsonLen > buf.byteLength) throw new PcvsFormatError('Truncated JSON section');
  const json = decoder.decode(bytes.slice(offset, offset + jsonLen));
  offset += jsonLen;

  if (offset + 2 > buf.byteLength) throw new PcvsFormatError('Truncated blob count');
  const blobCount = view.getUint16(offset, true);
  offset += 2;

  const blobs = new Map<string, ArrayBuffer>();
  for (let i = 0; i < blobCount; i++) {
    if (offset + 2 > buf.byteLength) throw new PcvsFormatError('Truncated blob key length');
    const keyLen = view.getUint16(offset, true); offset += 2;

    if (offset + keyLen > buf.byteLength) throw new PcvsFormatError('Truncated blob key');
    const key = decoder.decode(bytes.slice(offset, offset + keyLen)); offset += keyLen;

    if (offset + 4 > buf.byteLength) throw new PcvsFormatError('Truncated blob data length');
    const dataLen = view.getUint32(offset, true); offset += 4;

    if (offset + dataLen > buf.byteLength) throw new PcvsFormatError('Truncated blob data');
    blobs.set(key, buf.slice(offset, offset + dataLen)); offset += dataLen;
  }

  return { json, blobs };
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PcvsPayload {
  version: number;
  tabs: TabData[];
  items: ItemData[];
  edges: EdgeData[];
  viewports?: Record<string, ViewportState>;
}

// ── Export ────────────────────────────────────────────────────────────────────

export async function exportCanvas(adapter: StorageAdapter, tabId?: number): Promise<Blob> {
  const [allTabs, allItems, allEdges] = await Promise.all([
    adapter.getAllTabs(),
    adapter.getAllItems(),
    adapter.getAllEdges(),
  ]);

  const tabs  = tabId !== undefined ? allTabs.filter(t => t.id === tabId) : allTabs;
  const tabIds = new Set(tabs.map(t => t.id));
  const items = allItems.filter(i => tabIds.has(i.tabId));
  const edges = allEdges.filter(e => tabIds.has(e.tabId));

  const viewports: Record<string, ViewportState> = {};
  await Promise.all(tabs.map(async t => {
    const vp = await adapter.loadViewport(t.id);
    if (vp) viewports[String(t.id)] = vp;
  }));

  // Separate binary assets and strip binaryData from JSON items
  const blobs = new Map<string, ArrayBuffer>();
  const jsonItems = items.map(item => {
    const { binaryData, ...rest } = item;
    if (binaryData) {
      for (const key of item.binaryKeys ?? []) {
        const buf = binaryData[key];
        if (buf) blobs.set(`${item.id}:${key}`, buf);
      }
    }
    return rest;
  });

  const json = JSON.stringify({ version: 1, tabs, items: jsonItems, edges, viewports });
  const buf  = encodePcvs(json, blobs);
  return new Blob([buf], { type: 'application/octet-stream' });
}

// ── Import ────────────────────────────────────────────────────────────────────

export async function importCanvas(
  adapter: StorageAdapter,
  blob: Blob,
): Promise<{ tabIds: number[] }> {
  const { json, blobs } = decodePcvs(await blob.arrayBuffer());

  let payload: PcvsPayload;
  try {
    payload = JSON.parse(json) as PcvsPayload;
  } catch {
    throw new PcvsFormatError('Invalid JSON payload');
  }

  if (!payload.tabs?.length) return { tabIds: [] };

  const [existingTabs, existingItems, existingEdges] = await Promise.all([
    adapter.getAllTabs(),
    adapter.getAllItems(),
    adapter.getAllEdges(),
  ]);

  const maxTabId  = Math.max(0, ...existingTabs.map(t => t.id));
  const maxItemId = Math.max(0, ...existingItems.map(i => i.id));
  const maxEdgeId = Math.max(0, ...existingEdges.map(e => e.id));
  const maxOrder  = Math.max(0, ...existingTabs.map(t => t.order));

  const tabIdMap  = new Map<number, number>(payload.tabs.map( (t, i) => [t.id,  maxTabId  + 1 + i]));
  const itemIdMap = new Map<number, number>(payload.items.map((x, i) => [x.id,  maxItemId + 1 + i]));
  const edgeIdMap = new Map<number, number>(payload.edges.map((e, i) => [e.id,  maxEdgeId + 1 + i]));

  const newTabIds: number[] = [];

  for (const [i, tab] of payload.tabs.entries()) {
    const newId = tabIdMap.get(tab.id)!;
    newTabIds.push(newId);
    await adapter.putTab({ ...tab, id: newId, order: maxOrder + 1 + i });
  }

  for (const item of payload.items) {
    const newId      = itemIdMap.get(item.id)!;
    const newTabId   = tabIdMap.get(item.tabId)!;
    const newGroupId = item.groupId !== undefined ? itemIdMap.get(item.groupId) : undefined;

    const binaryData: Record<string, ArrayBuffer> = {};
    for (const key of item.binaryKeys ?? []) {
      const buf = blobs.get(`${item.id}:${key}`);
      if (buf) binaryData[key] = buf;
    }

    await adapter.putItem({
      ...item,
      id:         newId,
      tabId:      newTabId,
      groupId:    newGroupId,
      binaryData: Object.keys(binaryData).length > 0 ? binaryData : undefined,
    });
  }

  for (const edge of payload.edges) {
    await adapter.putEdge({
      ...edge,
      id:       edgeIdMap.get(edge.id)!,
      tabId:    tabIdMap.get(edge.tabId)!,
      fromNode: itemIdMap.get(edge.fromNode)!,
      toNode:   itemIdMap.get(edge.toNode)!,
    });
  }

  for (const [oldTabIdStr, vp] of Object.entries(payload.viewports ?? {})) {
    const newTabId = tabIdMap.get(Number(oldTabIdStr));
    if (newTabId && vp) await adapter.saveViewport(newTabId, vp);
  }

  return { tabIds: newTabIds };
}

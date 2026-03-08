import { createCanvas } from '@paste-canvas/lib';
import type { StorageAdapter, ItemData, TabData, EdgeData, ViewportState } from '@paste-canvas/lib';

// ── In-memory adapter ────────────────────────────────────────────────────────

class MemoryAdapter implements StorageAdapter {
  private items     = new Map<number, ItemData>();
  private tabs      = new Map<number, TabData>();
  private edges     = new Map<number, EdgeData>();
  private viewports = new Map<string, ViewportState>();
  private activeTab: number | null = null;

  async putItem(item: ItemData)    { this.items.set(item.id, item); }
  async deleteItem(id: number)     { this.items.delete(id); }
  async getAllItems()               { return [...this.items.values()]; }

  async putTab(tab: TabData)       { this.tabs.set(tab.id, tab); }
  async deleteTab(id: number)      { this.tabs.delete(id); }
  async getAllTabs()                { return [...this.tabs.values()]; }

  async putEdge(edge: EdgeData)    { this.edges.set(edge.id, edge); }
  async deleteEdge(id: number)     { this.edges.delete(id); }
  async getAllEdges()               { return [...this.edges.values()]; }

  async saveViewport(tabId: number, state: ViewportState) {
    this.viewports.set(`vp-${tabId}`, state);
  }
  async loadViewport(tabId: number) {
    return this.viewports.get(`vp-${tabId}`) ?? null;
  }
  async saveActiveTab(tabId: number) { this.activeTab = tabId; }
  async loadActiveTab()              { return this.activeTab; }
}

// ── Image generation ─────────────────────────────────────────────────────────

function makeColorBlob(index: number): Promise<Blob> {
  return new Promise(resolve => {
    const cvs = document.createElement('canvas');
    cvs.width = 200; cvs.height = 150;
    const c = cvs.getContext('2d')!;
    const hue = (index * 137) % 360;
    c.fillStyle = `hsl(${hue}, 65%, 55%)`;
    c.fillRect(0, 0, 200, 150);
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.font = 'bold 22px sans-serif';
    c.textAlign = 'center';
    c.fillText(`#${index}`, 100, 82);
    cvs.toBlob(b => resolve(b!), 'image/png');
  });
}

// ── Layouts ───────────────────────────────────────────────────────────────────

type Layout = 'grid' | 'scatter';

function computePositions(count: number, layout: Layout): { x: number; y: number }[] {
  if (layout === 'grid') {
    const COLS  = Math.ceil(Math.sqrt(count));
    const GAP_X = 230, GAP_Y = 180;
    return Array.from({ length: count }, (_, i) => ({
      x: (i % COLS) * GAP_X,
      y: Math.floor(i / COLS) * GAP_Y,
    }));
  }
  // scatter: seeded pseudo-random, deterministic per count
  const spread = Math.ceil(Math.sqrt(count)) * 260;
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };
  return Array.from({ length: count }, () => ({
    x: rand() * spread - spread / 2,
    y: rand() * spread - spread / 2,
  }));
}

// ── Seed adapter ─────────────────────────────────────────────────────────────

async function seedAdapter(adapter: MemoryAdapter, count: number): Promise<void> {
  await adapter.putTab({ id: 1, name: 'Stress Test', order: 0 });
  await adapter.saveActiveTab(1);

  const positions = computePositions(count, currentLayout);

  // Generate all blobs in parallel, then store
  const blobs = await Promise.all(
    Array.from({ length: count }, (_, i) => makeColorBlob(i + 1))
  );
  await Promise.all(blobs.map(async (blob, i) => {
    const buffer = await blob.arrayBuffer();
    await adapter.putItem({
      id: i + 1, type: 'img', tabId: 1,
      x: positions[i].x, y: positions[i].y,
      w: 200, h: 150, zIndex: i + 1,
      imageData: buffer, imageType: 'image/png',
      width: 200, label: `#${i + 1}`,
    });
  }));
}

// ── Stats ─────────────────────────────────────────────────────────────────────

const elFps     = document.getElementById('stat-fps')!;
const elTotal   = document.getElementById('stat-total')!;
const elMounted = document.getElementById('stat-mounted')!;
const elLoad    = document.getElementById('stat-load')!;
const container = document.getElementById('canvas-root')!;

let currentTotal = 0;

function refreshStats() {
  elTotal.textContent   = String(currentTotal);
  elMounted.textContent = String(container.querySelectorAll('.item').length);
}

// FPS loop
const frameTimes: number[] = [];
let lastRafTime = performance.now();

function fpsLoop(now: number) {
  const delta = now - lastRafTime;
  lastRafTime = now;
  frameTimes.push(delta);
  if (frameTimes.length > 60) frameTimes.shift();
  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  elFps.textContent = (1000 / avg).toFixed(1);
  refreshStats();
  requestAnimationFrame(fpsLoop);
}
requestAnimationFrame(fpsLoop);

// ── Canvas lifecycle ──────────────────────────────────────────────────────────

let currentLayout: Layout = 'scatter';
let activeCanvas: ReturnType<typeof createCanvas> | null = null;

async function runTest(count: number) {
  elLoad.textContent = '…';
  currentTotal = count;

  if (activeCanvas) {
    const parent = container.parentElement!;
    activeCanvas.destroy(); // removes container from DOM (it's the .paste-canvas-root)
    activeCanvas = null;
    parent.appendChild(container); // re-attach so getBoundingClientRect works
  }

  const adapter = new MemoryAdapter();
  const t0 = performance.now();
  await seedAdapter(adapter, count);

  activeCanvas = createCanvas(container, adapter, { title: `Stress Test (${count} items)` });
  // Use rAF to ensure container is laid out before mount triggers updateCulling
  requestAnimationFrame(() => {
    activeCanvas!.mount();
    requestAnimationFrame(() => {
      elLoad.textContent = (performance.now() - t0).toFixed(0) + ' ms';
      refreshStats();
    });
  });
}

// ── Wire controls ─────────────────────────────────────────────────────────────

let lastCount = 500;

document.querySelectorAll<HTMLButtonElement>('#controls button[data-count]').forEach(btn => {
  btn.addEventListener('click', () => { lastCount = Number(btn.dataset.count); void runTest(lastCount); });
});

const layoutToggle = document.getElementById('layout-toggle') as HTMLButtonElement;
layoutToggle.addEventListener('click', () => {
  currentLayout = currentLayout === 'scatter' ? 'grid' : 'scatter';
  layoutToggle.textContent = `Layout: ${currentLayout === 'scatter' ? 'Scatter' : 'Grid'}`;
  void runTest(lastCount);
});

void runTest(lastCount);

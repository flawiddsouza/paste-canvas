# paste-canvas

An infinite canvas for pasting and organizing images and notes.

## Packages

| Package | Description |
|---|---|
| `@paste-canvas/lib` | Core canvas library — framework-agnostic, storage-agnostic |
| `@paste-canvas/web` | Static web app using IndexedDB for persistence |
| `@paste-canvas/tauri` | Desktop app *(planned)* — folder-based workspace |

## Getting started

```bash
bun install
bun run dev:web      # http://localhost:3000
```

## Building

```bash
bun run build        # builds lib then web
```

## How it works

The library exposes a `PasteCanvas` class that mounts into any container element. Storage is handled by a `StorageAdapter` interface — swap implementations to change where data lives.

```ts
import { createCanvas } from '@paste-canvas/lib';

// Create and mount — data loads in the background:
createCanvas(document.body, myAdapter, { title: 'My Board' }).mount();

// Or keep a reference to destroy later:
const canvas = createCanvas(document.body, myAdapter).mount();
canvas.destroy(); // removes DOM and all event listeners
```

### Writing an adapter

Implement the `StorageAdapter` interface from `@paste-canvas/lib`:

```ts
import type { StorageAdapter, ItemData, TabData, EdgeData, ViewportState } from '@paste-canvas/lib';

class MyAdapter implements StorageAdapter {
  // Use a static factory if async setup is needed:
  // static async open(): Promise<MyAdapter> { ... }
  async putItem(item: ItemData): Promise<void> { ... }
  async deleteItem(id: number): Promise<void> { ... }
  async getAllItems(): Promise<ItemData[]> { ... }

  async putTab(tab: TabData): Promise<void> { ... }
  async deleteTab(id: number): Promise<void> { ... }
  async getAllTabs(): Promise<TabData[]> { ... }

  async putEdge(edge: EdgeData): Promise<void> { ... }
  async deleteEdge(id: number): Promise<void> { ... }
  async getAllEdges(): Promise<EdgeData[]> { ... }

  async saveViewport(tabId: number, state: ViewportState): Promise<void> { ... }
  async loadViewport(tabId: number): Promise<ViewportState | null> { ... }
  async saveActiveTab(tabId: number): Promise<void> { ... }
  async loadActiveTab(): Promise<number | null> { ... }
}
```

Images are stored as `ArrayBuffer` in `ItemData.imageData`. Your adapter receives already-encoded binary — no extra conversion needed.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+V` | Paste image or text |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+A` | Select all |
| `Ctrl+D` | Duplicate selected |
| `Ctrl+C` | Copy selected item |
| `Delete` / `Backspace` | Delete selected |
| `Escape` | Deselect |
| Scroll | Zoom |
| Drag (canvas) | Pan |
| Shift/Ctrl + drag | Marquee select |

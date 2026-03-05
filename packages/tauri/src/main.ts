import { createCanvas, PasteCanvas } from '@paste-canvas/lib';
import type { StorageAdapter } from '@paste-canvas/lib';
import { FsAdapter } from './FsAdapter.js';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

// ── State ─────────────────────────────────────────────────────────────────

const appWindow = getCurrentWindow();
let canvas: PasteCanvas | null = null;
let canvasContainer: HTMLDivElement | null = null;
let fsAdapter: FsAdapter | null = null;
let folderName: string | null = null;
let isDirty = false;
let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

// ── Dirty / title management ──────────────────────────────────────────────

function markDirty(): void {
  isDirty = true;
  updateTitle();
  if (dirtyTimer !== null) clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => { dirtyTimer = null; void flush(); }, DEBOUNCE_MS);
}

function markClean(): void {
  isDirty = false;
  updateTitle();
}

function updateTitle(): void {
  const base = folderName ? `${folderName} — Paste Canvas` : 'Paste Canvas';
  void appWindow.setTitle(isDirty ? `• ${base}` : base);
}

async function flush(): Promise<void> {
  if (!fsAdapter) return;
  await fsAdapter.flushAll();
  markClean();
}

// ── Canvas lifecycle ──────────────────────────────────────────────────────

function mountCanvas(adapter: StorageAdapter): void {
  canvas?.destroy();
  canvasContainer = document.createElement('div');
  canvasContainer.style.cssText = 'position:absolute;inset:0';
  document.body.appendChild(canvasContainer);
  canvas = createCanvas(canvasContainer, adapter).mount();
  injectToolbarButtons();
}

// ── Landing screen ────────────────────────────────────────────────────────

function showLanding(): void {
  const el = document.createElement('div');
  el.id = 'pc-landing';
  el.innerHTML = `
    <div id="pc-landing-card">
      <h1>Paste Canvas</h1>
      <p>Open a folder to start your workspace.<br>A new folder creates a fresh workspace.</p>
      <button class="btn" id="pc-landing-open">Open Folder</button>
      <button class="btn" id="pc-landing-new-window">New Window</button>
    </div>
  `;
  el.querySelector('#pc-landing-open')!.addEventListener('click', () => void handleOpenFolder());
  el.querySelector('#pc-landing-new-window')!.addEventListener('click', openNewWindow);
  document.body.appendChild(el);
}

// ── Toolbar injection ─────────────────────────────────────────────────────

function injectToolbarButtons(): void {
  const toolbar = canvasContainer!.querySelector<HTMLElement>('.pc-toolbar');
  if (!toolbar) return;

  const sep = document.createElement('div');
  sep.className = 'sep';

  const openBtn = document.createElement('button');
  openBtn.className = 'btn';
  openBtn.textContent = 'Open Folder';
  openBtn.addEventListener('click', () => void handleOpenFolder());

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => void handleCloseFolder());

  const newWinBtn = document.createElement('button');
  newWinBtn.className = 'btn';
  newWinBtn.textContent = 'New Window';
  newWinBtn.addEventListener('click', openNewWindow);

  toolbar.append(sep, openBtn, closeBtn, newWinBtn);
}

// ── Open folder ───────────────────────────────────────────────────────────

async function handleOpenFolder(): Promise<void> {
  const selected = await dialogOpen({ directory: true, multiple: false, title: 'Open Workspace Folder' });
  if (!selected || typeof selected !== 'string') return;

  if (fsAdapter) {
    if (dirtyTimer !== null) { clearTimeout(dirtyTimer); dirtyTimer = null; }
    await fsAdapter.flushAll();
  }

  fsAdapter  = await FsAdapter.open(selected, markDirty);
  folderName = selected.split(/[\\/]/).pop() ?? selected;
  isDirty    = false;

  document.getElementById('pc-landing')?.remove();
  mountCanvas(fsAdapter);
  updateTitle();
}

// ── Close folder ──────────────────────────────────────────────────────────

async function handleCloseFolder(): Promise<void> {
  if (dirtyTimer !== null) { clearTimeout(dirtyTimer); dirtyTimer = null; }
  await flush();
  fsAdapter  = null;
  folderName = null;
  canvas?.destroy();
  canvas = null;
  canvasContainer = null;
  void appWindow.setTitle('Paste Canvas');
  showLanding();
}

// ── New window ────────────────────────────────────────────────────────────

function openNewWindow(): void {
  new WebviewWindow(`window-${Date.now()}`, {
    url: '/',
    title: 'Paste Canvas',
    width: 1280,
    height: 800,
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────

showLanding();

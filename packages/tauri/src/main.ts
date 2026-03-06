import { createCanvas, PasteCanvas } from '@paste-canvas/lib';
import type { StorageAdapter } from '@paste-canvas/lib';
import { FsAdapter } from './FsAdapter.js';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { watch, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { load as loadStore } from '@tauri-apps/plugin-store';
import { restoreStateCurrent, saveWindowState, StateFlags } from '@tauri-apps/plugin-window-state';

// ── State ─────────────────────────────────────────────────────────────────

const appWindow = getCurrentWindow();
let canvas: PasteCanvas | null = null;
let canvasContainer: HTMLDivElement | null = null;
let fsAdapter: FsAdapter | null = null;
let folderPath: string | null = null;   // full path
let folderName: string | null = null;   // display name (last segment)
let isDirty = false;
let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
let navSaveTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

// ── Folder watcher ────────────────────────────────────────────────────────

let unwatchFn: UnwatchFn | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let writeLockUntil = 0;  // suppress watcher events during our own writes

async function startWatching(folder: string): Promise<void> {
  await stopWatching();
  unwatchFn = await watch(folder, () => {
    if (Date.now() < writeLockUntil) return;
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (Date.now() < writeLockUntil) return; // re-check: lock may have been set since event fired
      void reloadFolder();
    }, 400);
  }, { recursive: true, delayMs: 0 });
}

async function stopWatching(): Promise<void> {
  if (unwatchFn) { await unwatchFn(); unwatchFn = null; }
  if (reloadTimer !== null) { clearTimeout(reloadTimer); reloadTimer = null; }
}

async function reloadFolder(): Promise<void> {
  if (!folderPath) return;
  const path = folderPath;
  fsAdapter = await FsAdapter.open(path, markDirty, () => { writeLockUntil = Date.now() + 1500; }, flashSaveIndicator);
  isDirty   = false;
  mountCanvas(fsAdapter);
  updateTitle();
  await startWatching(path);
  writeLockUntil = Date.now() + 1000; // suppress buffered OS events after watcher restart
}

// ── Dirty / title management ──────────────────────────────────────────────

function markDirty(): void {
  isDirty = true;
  writeLockUntil = Date.now() + 3000; // suppress watcher during pending + in-progress write
  updateTitle();
  if (dirtyTimer !== null) clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => { dirtyTimer = null; void flush(); }, DEBOUNCE_MS);
}

function markClean(): void {
  isDirty = false;
  updateTitle();
}

function flashSaveIndicator(): void {
  if (isDirty) return; // content indicator already showing, don't interfere
  if (navSaveTimer !== null) clearTimeout(navSaveTimer);
  isDirty = true;
  updateTitle();
  navSaveTimer = setTimeout(() => {
    navSaveTimer = null;
    if (dirtyTimer === null) { isDirty = false; updateTitle(); }
  }, 800);
}

function updateTitle(): void {
  const base = folderName ? `${folderName} — Paste Canvas` : 'Paste Canvas';
  void appWindow.setTitle(isDirty ? `${base} •` : base);
}

async function flush(): Promise<void> {
  if (!fsAdapter) return;
  writeLockUntil = Date.now() + 3000;
  await fsAdapter.flushAll();
  writeLockUntil = Date.now() + 1000; // 1s cooldown after write completes
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

// ── Persistence ───────────────────────────────────────────────────────────

const STORE_FILE = 'settings.json';
const LAST_FOLDER_KEY = 'lastFolder';

async function saveLastFolder(path: string): Promise<void> {
  const store = await loadStore(STORE_FILE);
  await store.set(LAST_FOLDER_KEY, path);
  await store.save();
}

async function clearLastFolder(): Promise<void> {
  const store = await loadStore(STORE_FILE);
  await store.delete(LAST_FOLDER_KEY);
  await store.save();
}

async function getLastFolder(): Promise<string | null> {
  const store = await loadStore(STORE_FILE);
  return (await store.get<string>(LAST_FOLDER_KEY)) ?? null;
}

// ── Open folder ───────────────────────────────────────────────────────────

async function openFolder(path: string): Promise<void> {
  if (fsAdapter) {
    if (dirtyTimer !== null) { clearTimeout(dirtyTimer); dirtyTimer = null; }
    await fsAdapter.flushAll();
  }

  fsAdapter  = await FsAdapter.open(path, markDirty, () => { writeLockUntil = Date.now() + 1500; }, flashSaveIndicator);
  folderPath = path;
  folderName = path.split(/[\\/]/).pop() ?? path;
  isDirty    = false;

  void saveLastFolder(path);
  document.getElementById('pc-landing')?.remove();
  mountCanvas(fsAdapter);
  updateTitle();
  await startWatching(path);
}

async function handleOpenFolder(): Promise<void> {
  const selected = await dialogOpen({ directory: true, multiple: false, title: 'Open Workspace Folder' });
  if (!selected || typeof selected !== 'string') return;
  await openFolder(selected);
}

// ── Close folder ──────────────────────────────────────────────────────────

async function handleCloseFolder(): Promise<void> {
  await stopWatching();
  if (dirtyTimer !== null) { clearTimeout(dirtyTimer); dirtyTimer = null; }
  await flush();
  fsAdapter  = null;
  folderPath = null;
  folderName = null;
  canvas?.destroy();
  canvas = null;
  canvasContainer = null;
  await clearLastFolder();
  void appWindow.setTitle('Paste Canvas');
  showLanding();
}

// ── New window ────────────────────────────────────────────────────────────

function openNewWindow(): void {
  new WebviewWindow(`window-${Date.now()}`, {
    url: '/?new=1',
    title: 'Paste Canvas',
    width: 1280,
    height: 800,
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────

const isNewWindow = new URLSearchParams(window.location.search).has('new');

if (!isNewWindow) {
  void restoreStateCurrent(StateFlags.ALL);
}

if (isNewWindow) {
  showLanding();
} else {
  getLastFolder().then(lastFolder => {
    if (lastFolder) {
      return openFolder(lastFolder).catch(() => {
        // Folder no longer accessible; fall back to landing
        void clearLastFolder();
        showLanding();
      });
    } else {
      showLanding();
    }
  }).catch(() => showLanding());
}

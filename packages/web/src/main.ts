// packages/web/src/main.ts
import { createCanvas, PasteCanvas, defaultPlugins, ExportImportPlugin } from '@paste-canvas/lib';
import { WebControlsPlugin } from './WebControlsPlugin.js';
import type { StorageAdapter } from '@paste-canvas/lib';
import { IdbAdapter } from './IdbAdapter.js';
import { FsaAdapter } from './FsaAdapter.js';

// ── Feature detection ─────────────────────────────────────────────────────

const fsaSupported =
  'showDirectoryPicker' in window && typeof FileSystemObserver !== 'undefined';

// ── State ─────────────────────────────────────────────────────────────────

let canvas: PasteCanvas | null = null;
let canvasContainer: HTMLDivElement | null = null;
let fsaAdapter: FsaAdapter | null = null;
let currentFolderName: string | null = null;
let isDirty = false;
let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
let navSaveTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

// ── Watcher ───────────────────────────────────────────────────────────────

let observer: FileSystemObserver | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let writeLockUntil = 0;

async function startWatching(dirHandle: FileSystemDirectoryHandle): Promise<void> {
  stopWatching();
  observer = new FileSystemObserver((records) => {
    if (Date.now() < writeLockUntil) return;
    for (const record of records) {
      if (record.type === 'errored') {
        void handleObserverError(dirHandle);
        return;
      }
    }
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (Date.now() < writeLockUntil) return;
      void reloadFolder(dirHandle);
    }, 400);
  });
  await observer.observe(dirHandle, { recursive: true });
}

function stopWatching(): void {
  if (observer) { observer.disconnect(); observer = null; }
  if (reloadTimer !== null) { clearTimeout(reloadTimer); reloadTimer = null; }
}

async function handleObserverError(dirHandle: FileSystemDirectoryHandle): Promise<void> {
  if (observer) { observer.disconnect(); observer = null; }
  try {
    observer = new FileSystemObserver((records) => {
      if (Date.now() < writeLockUntil) return;
      for (const record of records) {
        if (record.type === 'errored') {
          if (observer) { observer.disconnect(); observer = null; }
          showToast('Folder watch lost — changes may not sync');
          return;
        }
      }
      if (reloadTimer !== null) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        if (Date.now() < writeLockUntil) return;
        void reloadFolder(dirHandle);
      }, 400);
    });
    await observer.observe(dirHandle, { recursive: true });
  } catch {
    if (observer) { observer.disconnect(); observer = null; }
    showToast('Folder watch lost — changes may not sync');
  }
}

// ── Dirty / save indicator ────────────────────────────────────────────────

function markDirty(): void {
  isDirty = true;
  writeLockUntil = Date.now() + 3000;
  updateTitle();
  if (dirtyTimer !== null) clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => { dirtyTimer = null; void flush(); }, DEBOUNCE_MS);
}

function markClean(): void {
  isDirty = false;
  updateTitle();
}

function flashSaveIndicator(): void {
  if (isDirty) return;
  if (navSaveTimer !== null) clearTimeout(navSaveTimer);
  isDirty = true;
  updateTitle();
  navSaveTimer = setTimeout(() => {
    navSaveTimer = null;
    if (dirtyTimer === null) { isDirty = false; updateTitle(); }
  }, 800);
}

function updateTitle(): void {
  const base = currentFolderName
    ? `${currentFolderName} — Paste Canvas`
    : 'Paste Canvas';
  document.title = isDirty ? `${base} •` : base;
}

// ── Flush ─────────────────────────────────────────────────────────────────

async function flush(): Promise<void> {
  if (!fsaAdapter) return;
  writeLockUntil = Date.now() + 3000;
  await fsaAdapter.flushAll();
  writeLockUntil = Date.now() + 1000;
  markClean();
}

// ── Toast ─────────────────────────────────────────────────────────────────

function showToast(msg: string): void {
  const existing = document.getElementById('pc-ext-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'pc-ext-toast';
  el.textContent = msg;
  el.style.cssText =
    'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);' +
    'background:#333;color:#fff;padding:8px 16px;border-radius:6px;' +
    'z-index:9999;font-size:14px;pointer-events:none;';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Canvas lifecycle ──────────────────────────────────────────────────────

function mountCanvas(adapter: StorageAdapter): void {
  document.getElementById('pc-landing')?.remove();
  canvasContainer?.remove();
  canvas?.destroy();
  canvasContainer = document.createElement('div');
  canvasContainer.style.cssText = 'position:absolute;inset:0';
  document.body.appendChild(canvasContainer);
  canvas = createCanvas(canvasContainer, adapter, {
    plugins: [
      ...defaultPlugins,
      ExportImportPlugin(),
      WebControlsPlugin({
        onOpenFolder: fsaSupported ? () => void handleOpenFolder() : undefined,
        onClose: () => void (fsaAdapter ? handleCloseFolder() : handleCloseBrowser()),
      }),
    ],
  }).mount();
}

// ── Landing screen ────────────────────────────────────────────────────────

function showLanding(
  stored?: { handle: FileSystemDirectoryHandle; name: string } | null,
): void {
  document.getElementById('pc-landing')?.remove();
  const reopenHtml = stored
    ? `<button class="btn" id="pc-landing-reopen">Reopen "${stored.name}"</button>`
    : '';
  const openFolderHtml = fsaSupported
    ? `<button class="btn" id="pc-landing-open">Open Folder</button>`
    : `<button class="btn" id="pc-landing-open" disabled>Open Folder</button>
       <p style="font-size:12px;color:#888;margin:4px 0 0">Requires Chrome 133+</p>`;

  const el = document.createElement('div');
  el.id = 'pc-landing';
  el.innerHTML = `
    <div id="pc-landing-card">
      <h1>Paste Canvas</h1>
      ${reopenHtml}
      <button class="btn" id="pc-landing-browser">Browser Storage</button>
      ${openFolderHtml}
    </div>
  `;

  if (stored) {
    el.querySelector('#pc-landing-reopen')!.addEventListener(
      'click', () => void handleReopen(stored),
    );
  }
  el.querySelector('#pc-landing-browser')!.addEventListener('click', () => void handleBrowserStorage());
  if (fsaSupported) {
    el.querySelector('#pc-landing-open')!.addEventListener(
      'click', () => void handleOpenFolder(),
    );
  }

  document.body.appendChild(el);
}

// ── Settings IndexedDB ────────────────────────────────────────────────────

const SETTINGS_DB    = 'paste-canvas-settings';
const SETTINGS_STORE = 'settings';
const HANDLE_KEY     = 'lastDirHandle';
const BROWSER_MODE_KEY = 'browserMode';

let settingsDbPromise: Promise<IDBDatabase> | null = null;

function openSettingsDb(): Promise<IDBDatabase> {
  if (!settingsDbPromise) {
    settingsDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(SETTINGS_DB, 1);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
          db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
      req.onerror  = (e) => { settingsDbPromise = null; reject((e.target as IDBOpenDBRequest).error); };
    });
  }
  return settingsDbPromise;
}

async function saveHandleToSettings(
  handle: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const db = await openSettingsDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, 'readwrite');
    tx.objectStore(SETTINGS_STORE).put({ key: HANDLE_KEY, handle, name });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function clearHandleFromSettings(): Promise<void> {
  const db = await openSettingsDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, 'readwrite');
    tx.objectStore(SETTINGS_STORE).delete(HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function getStoredHandle(): Promise<{
  handle: FileSystemDirectoryHandle;
  name: string;
} | null> {
  const db = await openSettingsDb();
  return new Promise((resolve) => {
    const req = db
      .transaction(SETTINGS_STORE)
      .objectStore(SETTINGS_STORE)
      .get(HANDLE_KEY);
    req.onsuccess = (e) => resolve((e.target as IDBRequest).result ?? null);
    req.onerror   = () => resolve(null);
  });
}

async function saveBrowserModeToSettings(): Promise<void> {
  const db = await openSettingsDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, 'readwrite');
    tx.objectStore(SETTINGS_STORE).put({ key: BROWSER_MODE_KEY });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function clearBrowserModeFromSettings(): Promise<void> {
  const db = await openSettingsDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, 'readwrite');
    tx.objectStore(SETTINGS_STORE).delete(BROWSER_MODE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function getBrowserModeStored(): Promise<boolean> {
  const db = await openSettingsDb();
  return new Promise((resolve) => {
    const req = db
      .transaction(SETTINGS_STORE)
      .objectStore(SETTINGS_STORE)
      .get(BROWSER_MODE_KEY);
    req.onsuccess = (e) => resolve((e.target as IDBRequest).result != null);
    req.onerror   = () => resolve(false);
  });
}

// ── Open folder ───────────────────────────────────────────────────────────

async function openFolder(
  dirHandle: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  if (dirtyTimer !== null) { clearTimeout(dirtyTimer); dirtyTimer = null; }
  if (fsaAdapter) await fsaAdapter.flushAll();
  stopWatching();

  fsaAdapter = await FsaAdapter.open(
    dirHandle, markDirty, () => { writeLockUntil = Date.now() + 1500; }, flashSaveIndicator,
  );
  currentFolderName = name;
  isDirty = false;

  await clearBrowserModeFromSettings();
  await saveHandleToSettings(dirHandle, name);
  mountCanvas(fsaAdapter);
  updateTitle();
  await startWatching(dirHandle);
}

async function reloadFolder(dirHandle: FileSystemDirectoryHandle): Promise<void> {
  stopWatching();
  if (dirtyTimer !== null) { clearTimeout(dirtyTimer); dirtyTimer = null; }

  let newAdapter: FsaAdapter;
  try {
    newAdapter = await FsaAdapter.open(
      dirHandle, markDirty, () => { writeLockUntil = Date.now() + 1500; }, flashSaveIndicator,
    );
  } catch (e) {
    // Full teardown — do not leave a live canvas with a broken adapter
    canvas?.destroy();
    canvas = null;
    canvasContainer?.remove();
    canvasContainer = null;
    fsaAdapter = null;
    currentFolderName = null;
    await clearHandleFromSettings();
    showLanding();
    showToast(
      (e as DOMException).name === 'NotAllowedError'
        ? 'Permission was revoked — please reopen the folder'
        : 'Failed to reload folder',
    );
    return;
  }

  fsaAdapter = newAdapter;
  isDirty = false;
  mountCanvas(fsaAdapter);
  updateTitle();
  await startWatching(dirHandle);
  writeLockUntil = Date.now() + 1000;
}

async function handleOpenFolder(): Promise<void> {
  let dirHandle: FileSystemDirectoryHandle;
  try {
    dirHandle = await (window as Window & typeof globalThis & {
      showDirectoryPicker(opts?: { mode?: string }): Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return;
    throw e;
  }
  await openFolder(dirHandle, dirHandle.name);
}

async function handleReopen(stored: {
  handle: FileSystemDirectoryHandle;
  name: string;
}): Promise<void> {
  const perm = await stored.handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    await clearHandleFromSettings();
    showLanding(); // re-render without Reopen button
    return;
  }
  await openFolder(stored.handle, stored.name);
}

// ── Browser storage ───────────────────────────────────────────────────────

async function handleBrowserStorage(): Promise<void> {
  await clearHandleFromSettings();
  await saveBrowserModeToSettings();
  fsaAdapter = null;
  currentFolderName = null;
  mountCanvas(new IdbAdapter());
  updateTitle();
}

// ── Close folder ──────────────────────────────────────────────────────────

async function handleCloseFolder(): Promise<void> {
  stopWatching();
  const needsFlush = isDirty || dirtyTimer !== null;
  if (dirtyTimer !== null) { clearTimeout(dirtyTimer); dirtyTimer = null; }
  if (needsFlush) await flush();
  fsaAdapter = null;
  currentFolderName = null;
  canvas?.destroy();
  canvas = null;
  canvasContainer?.remove();
  canvasContainer = null;
  isDirty = false;
  updateTitle();
  await clearHandleFromSettings();
  showLanding();
}

async function handleCloseBrowser(): Promise<void> {
  canvas?.destroy();
  canvas = null;
  canvasContainer?.remove();
  canvasContainer = null;
  isDirty = false;
  updateTitle();
  await clearBrowserModeFromSettings();
  showLanding();
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  if (fsaSupported) {
    const stored = await getStoredHandle().catch(() => null);
    if (stored) {
      const perm = await stored.handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        try {
          await openFolder(stored.handle, stored.name);
        } catch (e) {
          await clearHandleFromSettings();
          showLanding();
          if ((e as DOMException).name === 'NotAllowedError') {
            showToast('Permission was revoked — please reopen the folder');
          }
        }
        return;
      } else if (perm === 'prompt') {
        showLanding(stored);
        return;
      } else {
        // 'denied'
        await clearHandleFromSettings();
      }
    }
  }

  const browserMode = await getBrowserModeStored().catch(() => false);
  if (browserMode) {
    fsaAdapter = null;
    currentFolderName = null;
    mountCanvas(new IdbAdapter());
    updateTitle();
    return;
  }

  showLanding();
}

void boot();

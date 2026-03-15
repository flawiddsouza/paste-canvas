import type { Ctx, UndoCmd } from './types.js';
import { pushUndo } from './history.js';
import { updateEdgesForItems } from './edges.js';
import { toast, showConfirm } from './canvas.js';
// saveItem imported from './items.js' — circular reference resolves at runtime in ES modules
import { saveItem } from './items.js';

// ── Paste priority ──────────────────────────────────────────────────────────

export const PastePriority = {
  highest:  4,   // always wins — grab specific MIME types (e.g. image/*)
  high:     3,   // strong claim — rich content (HTML, SVG)
  normal:   2,   // default — most plugins live here
  low:      1,   // weak claim — broad content (text/plain)
  fallback: 0,   // last resort — only if nobody else matched
} as const;

// ── StoredPlugin ────────────────────────────────────────────────────────────

export interface StoredPlugin {
  data?:   unknown;                     // JSON-serialisable content
  binary?: Record<string, ArrayBuffer>; // blobs — cached in view, not re-fetched on save
}

// ── PluginAPI ───────────────────────────────────────────────────────────────

export interface PluginAPI {
  readonly itemId:  number;
  readonly itemEl:  HTMLElement;         // outer .item element wrapping the plugin's el
  readonly signal:  AbortSignal;         // aborted on item destroy / canvas teardown
  readonly scale:   number;              // current zoom level (getter — always reads live value)

  /** Is this item currently in the selection set? */
  isSelected(): boolean;

  pushUndo(cmd: UndoCmd): void;
  save():          void;                 // immediate persist; plugins debounce themselves
  notifyResized(): void;                 // for content-driven size changes only (e.g. textarea auto-grow)
                                         // user-drag resize is handled entirely by the core
                                         // implementation: reads rec.el dimensions, updates rec.w/h,
                                         // recalculates connected edges via nodeEdgeMap
  toast(msg: string): void;
  confirm(msg: string, confirmLabel?: string): Promise<boolean>;
}

// ── ItemPlugin ──────────────────────────────────────────────────────────────

export interface ItemPlugin<
  TView extends { el: HTMLElement } = { el: HTMLElement },
  TSnap = unknown,
> {
  type:  string;
  label: string;   // e.g. "Note", "Image", "Group" — used in delete labels and tab counts

  // ── Required ────────────────────────────────────────────────────────────────

  /** Build DOM, wire event listeners, return a blank view. Never called with stored data. */
  create(api: PluginAPI): TView;

  /** Snapshot for undo — may include session-only values such as blob URLs. */
  snapshot(view: TView): TSnap;
  /** Restore an undo snapshot. */
  restore(view: TView, snap: TSnap): void;

  /**
   * Serialise for storage — must be JSON + binary only.
   * May return a Promise for plugins with large binary data that should not
   * be cached in memory. The core always awaits the result.
   * Sync return is the common case and works unchanged.
   */
  serialize(view: TView): StoredPlugin | Promise<StoredPlugin>;
  /** Hydrate from stored data (called after create() on load). */
  hydrate(view: TView, stored: StoredPlugin): void;

  // ── Optional ────────────────────────────────────────────────────────────────

  /** Revoke blob URLs, cancel timers, etc. Called on delete and tab unload. */
  dispose?(view: TView): void;

  /**
   * Write item to clipboard. Fire-and-forget; use api.toast() for errors.
   * api is passed explicitly because this is a method on the singleton plugin
   * object and cannot close over the per-item api from create().
   */
  copy?(view: TView, api: PluginAPI): void;

  /**
   * Handle a paste event.
   * Grab everything needed from DataTransfer synchronously before the first
   * await, then return StoredPlugin (+ optional dimensions) or null.
   * The core creates the item at viewport centre at the given dimensions
   * (or a default size), calls hydrate(), and pushes the undo command.
   * The plugin does not create the item itself.
   */
  paste?(dt: DataTransfer): Promise<{
    stored: StoredPlugin;
    width?:  number;   // suggested item width  — core uses default if omitted
    height?: number;   // suggested item height — core uses default if omitted
  } | null>;

  /**
   * Handle a paste from the toolbar Paste button.
   * Called with items from navigator.clipboard.read(), giving access to
   * custom MIME types not available via DataTransfer (e.g. raw image blobs).
   * Same return shape as paste(). Return null to pass to the next plugin.
   */
  pasteFromClipboard?(items: ClipboardItem[]): Promise<{
    stored: StoredPlugin;
    width?:  number;
    height?: number;
  } | null>;

  /**
   * Return extra toolbar buttons to insert before the core-owned buttons
   * (ungroup + delete). Called once after create(). api is passed explicitly
   * because this is a singleton method (same reason as copy).
   */
  toolbarButtons?(view: TView, api: PluginAPI): HTMLElement[];

  /**
   * Called after the item element is appended to the DOM.
   * `isNew` is true only for freshly created items (not loaded from storage).
   * Use for auto-focus or other post-mount setup that requires the element to be in the document.
   */
  afterMount?(view: TView, isNew: boolean): void;

  /**
   * Called when the item's selection state changes.
   * Useful for showing/hiding selection-dependent UI (e.g. color swatches
   * that only respond to keyboard shortcuts when the item is selected).
   */
  onSelectionChange?(view: TView, selected: boolean): void;

  /**
   * If true, the core treats this item as a group container.
   * See "Container behaviour" section.
   * Default: false.
   */
  container?: boolean;

  ports?:    boolean;            // default true  — show edge connection dots
  resize?:   'none' | 'width' | 'height' | 'both';  // default 'both'
  minWidth?: number;
  minHeight?: number;

  /**
   * Paste priority — higher values win when multiple plugins match.
   * Use PastePriority constants. Default: PastePriority.normal (2).
   */
  pastePriority?: number;

  /**
   * Called after the core commits a user-drag resize with the final dimensions.
   * Use to sync internal element sizes (e.g. set textarea width/height,
   * or image inner-div width).
   * The core has already updated rec.w / rec.h before this is called.
   */
  onResize?(view: TView, w: number, h: number): void;
}

// ── BoundView ───────────────────────────────────────────────────────────────

/** The core's handle to an item's plugin state. Framework-internal. */
export interface BoundView {
  readonly el: HTMLElement;

  // ── Always present ────────────────────────────────────────────────────────
  snapshot():              unknown;
  restore(snap: unknown):  void;
  serialize():             StoredPlugin | Promise<StoredPlugin>;
  hydrate(stored: StoredPlugin): void;
  destroy():               void;    // aborts signal + calls dispose()

  /**
   * Run fn with save/pushUndo/notifyResized suppressed.
   * Used by the core during the create → hydrate sequence to prevent
   * event listeners (attached in create) from triggering side effects
   * when hydrate sets DOM values.
   */
  suppressDuring(fn: () => void): void;

  // ── Optional — present only if the plugin implements them ─────────────────
  copy?():                        void;
  toolbarButtons?():              HTMLElement[];
  afterMount?(isNew: boolean):    void;
  onResize?(w: number, h: number): void;
  onSelectionChange?(selected: boolean): void;
}

// ── bindPlugin() — the single type boundary ─────────────────────────────────

/**
 * Create a BoundView that closes over the typed view and api.
 * This is the ONE place in the framework where the type parameter
 * is erased. Safety invariant: view was produced by the same plugin's
 * create().
 */
export function bindPlugin<V extends { el: HTMLElement }, S>(
  plugin:   ItemPlugin<V, S>,
  view:     V,
  api:      PluginAPI,
  abort:    AbortController,
  suppress: (v: boolean) => void,   // toggles suppression on the api
): BoundView {
  return {
    el: view.el,

    snapshot:        ()     => plugin.snapshot(view),
    // Safety: view was produced by the same plugin's create() or clone() — type is guaranteed
    restore:         (snap) => plugin.restore(view, snap as S),
    serialize:       ()     => plugin.serialize(view),
    hydrate:         (s)    => plugin.hydrate(view, s),
    destroy()               { abort.abort(); plugin.dispose?.(view); },

    suppressDuring(fn) {
      suppress(true);
      try { fn(); } finally { suppress(false); }
    },

    copy:             plugin.copy             ? () => plugin.copy!(view, api)             : undefined,
    toolbarButtons:   plugin.toolbarButtons   ? () => plugin.toolbarButtons!(view, api)   : undefined,
    afterMount:       plugin.afterMount       ? (isNew) => plugin.afterMount!(view, isNew) : undefined,
    onResize:         plugin.onResize         ? (w, h) => plugin.onResize!(view, w, h)   : undefined,
    onSelectionChange: plugin.onSelectionChange ? (s) => plugin.onSelectionChange!(view, s) : undefined,
  };
}

// ── makePluginAPI() — factory returns api + internals ───────────────────────

export function makePluginAPI(
  ctx:    Ctx,
  id:     number,
  itemEl: HTMLElement,
): { api: PluginAPI; abort: AbortController; suppress: (v: boolean) => void } {
  const abort = new AbortController();
  let suppressed = false;

  const api: PluginAPI = {
    itemId:  id,
    itemEl,
    signal: abort.signal,
    get scale() { return ctx.scale; },

    isSelected()  { const rec = ctx.itemsById.get(id); return rec ? ctx.selectedItems.has(rec) : false; },
    pushUndo(cmd) { if (!suppressed) pushUndo(ctx, cmd); },
    save() {
      if (!suppressed) {
        const rec = ctx.itemsById.get(id);
        if (rec) void saveItem(ctx, id);
      }
    },
    notifyResized() {
      if (suppressed) return;
      const rec = ctx.itemsById.get(id);
      if (!rec || !rec.mounted) return;
      rec.w = rec.el.offsetWidth;
      rec.h = rec.el.offsetHeight;
      updateEdgesForItems(ctx, new Set([rec]));
    },
    toast(msg)          { toast(ctx, msg); },
    confirm(msg, label) { return showConfirm(ctx, msg, label); },
  };

  return { api, abort, suppress: v => { suppressed = v; } };
}

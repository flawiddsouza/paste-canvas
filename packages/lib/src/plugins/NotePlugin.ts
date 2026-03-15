import type { ItemPlugin, PluginAPI } from '../plugin.js';
import { PastePriority } from '../plugin.js';

const PC_MIME_META = 'web application/x-paste-canvas';

// ── Color tables ─────────────────────────────────────────────────────────────

const COLOR_HEX: Record<string, string> = {
  '1': '#ff5252',
  '2': '#ff9040',
  '3': '#ffd433',
  '4': '#44cf6e',
  '5': '#438dff',
  '6': '#a15ef4',
  '7': '#d06090',
};

const HEX_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(COLOR_HEX).map(([k, v]) => [v, k])
);

// ── View / Snap ───────────────────────────────────────────────────────────────

interface NoteView {
  el:       HTMLElement;
  itemEl:   HTMLElement;   // outer .item element — owned by core, used for color CSS vars
  textarea: HTMLTextAreaElement;
  color:    string | undefined;
}

interface NoteSnap {
  text:   string;
  color:  string | undefined;
  width:  number;
  height: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function applyColor(view: NoteView, color: string | undefined): void {
  view.color = color;
  if (!color) {
    view.itemEl.classList.remove('colored');
    view.itemEl.style.removeProperty('--note-color');
  } else {
    view.itemEl.classList.add('colored');
    view.itemEl.style.setProperty('--note-color', color);
  }
}

function activeSwatchKey(color: string | undefined): string {
  return color ? (HEX_TO_KEY[color] ?? color) : 'reset';
}

// ── Copy helper ───────────────────────────────────────────────────────────────

async function copyNoteText(view: NoteView, api: PluginAPI): Promise<void> {
  const text = view.textarea.value;
  if (!text.trim()) { api.toast('Nothing to copy'); return; }
  try {
    const mimeMap: Record<string, Blob> = {
      'text/plain': new Blob([text], { type: 'text/plain' }),
    };
    const w = view.textarea.offsetWidth, h = view.textarea.offsetHeight;
    if (w && h) {
      mimeMap[PC_MIME_META] = new Blob(
        [JSON.stringify({ pc: 1, w: Math.round(w), h: Math.round(h) })],
        { type: 'application/x-paste-canvas' }
      );
    }
    await navigator.clipboard.write([new ClipboardItem(mimeMap)]);
  } catch {
    await navigator.clipboard.writeText(text);
  }
  api.toast('Text copied to clipboard!');
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const NotePlugin: ItemPlugin<NoteView, NoteSnap> = {
  type:          'note',
  label:         'Note',
  resize:        'both',
  pastePriority: PastePriority.low,

  create(api: PluginAPI) {
    const el       = document.createElement('div');
    el.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0';
    const handle   = document.createElement('div');
    handle.className = 'note-handle';
    handle.textContent = '\u28ff\u28ff\u28ff';

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Type a note\u2026';
    textarea.rows        = 3;
    textarea.spellcheck  = false;
    el.append(handle, textarea);

    const view: NoteView = { el, itemEl: api.itemEl, textarea, color: undefined };

    // Debounced save on input
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    textarea.addEventListener('input', () => {
      clearTimeout(saveTimer ?? undefined);
      saveTimer = setTimeout(() => api.save(), 600);
      api.notifyResized();
    }, { signal: api.signal });

    // Color keyboard shortcuts — only when item is selected
    document.addEventListener('keydown', (e) => {
      if (!api.isSelected()) return;
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      const hex = COLOR_HEX[e.key];
      if (!hex) return;
      const newColor = activeSwatchKey(view.color) === e.key ? undefined : hex;
      const prevColor = view.color;
      applyColor(view, newColor);
      // Sync swatch active state
      view.itemEl.querySelectorAll<HTMLButtonElement>('.item-color-swatch').forEach(sw =>
        sw.classList.toggle('active', sw.dataset.color === activeSwatchKey(view.color))
      );
      api.save();
      api.pushUndo({
        label: 'color',
        undo() {
          applyColor(view, prevColor);
          view.itemEl.querySelectorAll<HTMLButtonElement>('.item-color-swatch').forEach(sw =>
            sw.classList.toggle('active', sw.dataset.color === activeSwatchKey(view.color))
          );
          api.save();
          return [api.itemId];
        },
        redo() {
          applyColor(view, newColor);
          view.itemEl.querySelectorAll<HTMLButtonElement>('.item-color-swatch').forEach(sw =>
            sw.classList.toggle('active', sw.dataset.color === activeSwatchKey(view.color))
          );
          api.save();
          return [api.itemId];
        },
      });
    }, { signal: api.signal });

    return view;
  },

  toolbarButtons(view, api) {
    const btns: HTMLButtonElement[] = [];

    // Copy Text
    const copyBtn = document.createElement('button');
    copyBtn.className   = 'item-btn';
    copyBtn.textContent = 'Copy Text';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void copyNoteText(view, api);
    });
    btns.push(copyBtn);

    // Color separator
    const sep = document.createElement('span');
    sep.style.cssText = 'width:1px;height:12px;background:#555;margin:0 2px;flex-shrink:0;align-self:center';
    btns.push(sep as unknown as HTMLButtonElement);

    // Reset swatch
    const resetSwatch = document.createElement('button');
    resetSwatch.className      = 'item-color-swatch active';
    resetSwatch.dataset.color  = 'reset';
    resetSwatch.title          = 'Default color';
    btns.push(resetSwatch);

    // Color swatches
    const swatchEls: HTMLButtonElement[] = [resetSwatch];
    for (const key of ['1','2','3','4','5','6','7'] as const) {
      const sw = document.createElement('button');
      sw.className      = 'item-color-swatch';
      sw.dataset.color  = key;
      sw.title          = `Color ${key}`;
      btns.push(sw);
      swatchEls.push(sw);
    }

    const syncSwatches = () => {
      const k = activeSwatchKey(view.color);
      for (const sw of swatchEls) sw.classList.toggle('active', sw.dataset.color === k);
    };

    const setColor = (newKey: string | undefined) => {
      const hex = newKey ? (COLOR_HEX[newKey] ?? newKey) : undefined;
      if (view.color === hex) return;
      const prev = view.color;
      applyColor(view, hex);
      syncSwatches();
      api.save();
      api.pushUndo({
        label: 'color',
        undo() {
          applyColor(view, prev);
          syncSwatches();
          api.save();
          return [api.itemId];
        },
        redo() {
          applyColor(view, hex);
          syncSwatches();
          api.save();
          return [api.itemId];
        },
      });
    };

    resetSwatch.addEventListener('click', (e) => { e.stopPropagation(); setColor(undefined); });
    for (const sw of swatchEls) {
      if (sw.dataset.color === 'reset') continue;
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = sw.dataset.color!;
        setColor(activeSwatchKey(view.color) === c ? undefined : c);
      });
    }

    return btns;
  },

  onResize(view, w, _h) {
    view.textarea.style.width = w + 'px';
  },

  snapshot: v => ({
    text:   v.textarea.value,
    color:  v.color,
    width:  v.textarea.offsetWidth,
    height: v.textarea.offsetHeight,
  }),

  restore(v, s) {
    v.textarea.value = s.text;
    if (s.width)  v.textarea.style.width  = s.width  + 'px';
    if (s.height) v.textarea.style.height = s.height + 'px';
    else          v.textarea.style.height = '';
    applyColor(v, s.color);
  },

  serialize: v => ({
    data: {
      text:  v.textarea.value,
      color: v.color,
      width: v.textarea.offsetWidth,
    },
  }),

  hydrate(v, s) {
    const d = s.data as { text?: string; color?: string; width?: number } | null;
    v.textarea.value = d?.text ?? '';
    if (d?.width) v.textarea.style.width = d.width + 'px';
    v.textarea.style.height = '';
    v.color = d?.color ?? undefined; // applied in afterMount once .item is in the DOM
  },

  afterMount(v, isNew) {
    applyColor(v, v.color);
    const k = activeSwatchKey(v.color);
    v.itemEl.querySelectorAll<HTMLButtonElement>('.item-color-swatch')
      .forEach(sw => sw.classList.toggle('active', sw.dataset.color === k));
    if (isNew && !v.textarea.value) v.textarea.focus({ preventScroll: true });
  },

  copy: (v, api) => { void copyNoteText(v, api); },

  async paste(dt) {
    const text = dt.getData('text/plain');
    if (!text.trim()) return null;

    let width: number | undefined, height: number | undefined;
    try {
      const clipItems = await navigator.clipboard.read();
      for (const ci of clipItems) {
        if (ci.types.includes(PC_MIME_META)) {
          const meta = JSON.parse(await (await ci.getType(PC_MIME_META)).text());
          if (meta?.pc === 1) {
            if (meta.w > 0) width  = meta.w;
            if (meta.h > 0) height = meta.h;
          }
        }
      }
    } catch { /* clipboard API not available or permission denied */ }

    return { stored: { data: { text, width, height } }, width, height };
  },
};

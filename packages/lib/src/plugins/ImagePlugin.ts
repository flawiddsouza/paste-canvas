import type { ItemPlugin, PluginAPI } from '../plugin.js';
import { PastePriority } from '../plugin.js';

export const PC_MIME_META  = 'web application/x-paste-canvas';
export const PC_MIME_IMAGE = 'web application/x-paste-canvas-image';

// ── View / Snap ───────────────────────────────────────────────────────────────

interface ImageView {
  el:        HTMLElement;  // inner wrapper div (appended to .item-inner by core)
  img:       HTMLImageElement;
  labelEl:   HTMLTextAreaElement;
  imageData: ArrayBuffer;
  imageType: string;
  displayW:  number;
  copyLabelBtn?: HTMLButtonElement;
  _autoGrow?: () => void;
  _onCachedLoad: () => void;
}

interface ImageSnap {
  imageData: ArrayBuffer;
  imageType: string;
  label:     string;
  displayW:  number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function syncCopyLabelBtn(v: ImageView): void {
  if (v.copyLabelBtn) v.copyLabelBtn.style.display = v.labelEl.value ? '' : 'none';
}

function wrapText(ctx2d: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ');
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (ctx2d.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    lines.push(current);
  }
  return lines;
}

function buildDom(api: PluginAPI): ImageView {
  const el      = document.createElement('div');
  el.className  = 'image-inner';
  const img     = document.createElement('img');
  const labelEl = document.createElement('textarea');
  labelEl.className   = 'img-label';
  labelEl.placeholder = 'Label\u2026';
  labelEl.rows        = 1;
  labelEl.spellcheck  = false;
  el.append(img, labelEl);

  const view: ImageView = {
    el, img, labelEl,
    imageData: new ArrayBuffer(0),
    imageType: 'image/png',
    displayW:  0,
    _onCachedLoad: () => { api.notifyResized(); },
  };

  // After image decodes, update rec.h so ports/edges reflect real dimensions
  img.addEventListener('load', () => {
    api.notifyResized();
    api.save();
  }, { signal: api.signal });

  // Label auto-grow + debounced save
  const autoGrow = () => {
    if (!labelEl.value) {
      labelEl.style.height = '';
    } else {
      labelEl.style.height = 'auto';
      labelEl.style.height = labelEl.scrollHeight + 'px';
    }
  };
  let labelTimer: ReturnType<typeof setTimeout> | null = null;
  labelEl.addEventListener('input', () => {
    autoGrow();
    syncCopyLabelBtn(view);
    clearTimeout(labelTimer ?? undefined);
    labelTimer = setTimeout(() => api.save(), 600);
  }, { signal: api.signal });

  // Expose autoGrow for afterMount / hydrate
  view._autoGrow = autoGrow;

  return view;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const ImagePlugin: ItemPlugin<ImageView, ImageSnap> = {
  type:          'img',
  label:         'Image',
  resize:        'width',
  pastePriority: PastePriority.highest,

  create(api) {
    return buildDom(api);
  },

  toolbarButtons(view, api) {
    const btns: HTMLButtonElement[] = [];

    // Copy Image
    const copyBtn = document.createElement('button');
    copyBtn.className   = 'item-btn';
    copyBtn.textContent = 'Copy Image';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await copyImageFn(view, api);
    });
    btns.push(copyBtn);

    // Copy with Label
    const copyLabelBtn = document.createElement('button');
    copyLabelBtn.className   = 'item-btn pc-btn-copy-label';
    copyLabelBtn.textContent = 'Copy with Label';
    copyLabelBtn.style.display = 'none';
    copyLabelBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await copyImageWithLabelFn(view, api);
    });
    view.copyLabelBtn = copyLabelBtn;
    btns.push(copyLabelBtn);

    // Label focus
    const labelBtn = document.createElement('button');
    labelBtn.className   = 'item-btn';
    labelBtn.textContent = 'Label';
    labelBtn.addEventListener('click', (e) => { e.stopPropagation(); view.labelEl.focus(); });
    btns.push(labelBtn);

    return btns;
  },

  afterMount(v, _isNew) {
    // Apply auto-grow now that we're in the DOM
    v._autoGrow?.();
    // Show Copy with Label button if label is pre-populated
    syncCopyLabelBtn(v);
    // If image decoded from cache before this mount, the load event already fired
    // while the element was detached — update dimensions now (no save needed,
    // the item is already persisted from storage or from the paste handler).
    if (v.img.complete && v.img.naturalWidth) {
      v._onCachedLoad();
    }
  },

  onResize(v, w) {
    v.displayW = w;
    v.el.style.width = w + 'px';
  },

  snapshot: v => ({
    imageData: v.imageData,
    imageType: v.imageType,
    label:     v.labelEl.value,
    displayW:  v.displayW,
  }),

  restore(v, s) {
    if (v.img.src.startsWith('blob:')) URL.revokeObjectURL(v.img.src);
    if (s.imageData.byteLength > 0) {
      const url = URL.createObjectURL(new Blob([s.imageData], { type: s.imageType }));
      v.img.src = url;
    }
    v.imageData      = s.imageData;
    v.imageType      = s.imageType;
    v.labelEl.value  = s.label;
    v.displayW       = s.displayW;
    if (s.displayW) v.el.style.width = s.displayW + 'px';
    v._autoGrow?.();
    syncCopyLabelBtn(v);
  },

  dispose(v) {
    if (v.img.src.startsWith('blob:')) URL.revokeObjectURL(v.img.src);
  },

  serialize: v => ({
    data:   { label: v.labelEl.value, displayW: v.displayW },
    binary: v.imageData.byteLength > 0 ? { image: v.imageData } : undefined,
  }),

  hydrate(v, s) {
    const d = s.data as { label?: string; displayW?: number } | null;
    v.labelEl.value = d?.label ?? '';
    v.displayW      = d?.displayW ?? 0;

    const buf = s.binary?.image;
    if (buf) {
      v.imageData = buf;
      const url = URL.createObjectURL(new Blob([buf], { type: v.imageType }));
      v.img.onload = () => {
        if (!v.displayW) {
          v.displayW = v.img.naturalWidth;
          v.el.style.width = v.displayW + 'px';
        }
      };
      v.img.src = url;
    }
    if (v.displayW) v.el.style.width = v.displayW + 'px';
    v._autoGrow?.();
    syncCopyLabelBtn(v);
  },

  copy: (v, api) => { void copyImageFn(v, api); },

  async pasteFromClipboard(items) {
    let imageBlob: Blob | undefined;
    let label = '', metaW = 0, metaH = 0;

    for (const ci of items) {
      if (ci.types.includes(PC_MIME_META)) {
        try {
          const meta = JSON.parse(await (await ci.getType(PC_MIME_META)).text());
          if (meta?.label) label = meta.label;
          if (meta?.w > 0) metaW = meta.w;
          if (meta?.h > 0) metaH = meta.h;
        } catch { /* ignore */ }
      }
      // Prefer PC_MIME_IMAGE (raw original from "Copy with Label") over composited image/png
      if (!imageBlob && ci.types.includes(PC_MIME_IMAGE)) {
        imageBlob = await ci.getType(PC_MIME_IMAGE);
      }
      if (!imageBlob) {
        const imgType = ci.types.find(t => t.startsWith('image/'));
        if (imgType) imageBlob = await ci.getType(imgType);
      }
    }

    if (!imageBlob) return null;

    const [imageData, bitmap] = await Promise.all([
      imageBlob.arrayBuffer(),
      createImageBitmap(imageBlob),
    ]);
    const displayW = metaW || bitmap.width;
    const displayH = metaH || bitmap.height;
    bitmap.close();

    return {
      stored: {
        data:   { label, displayW },
        binary: { image: imageData },
      },
      width:  displayW,
      height: displayH,
    };
  },

  async paste(dt) {
    // Grab file synchronously before any await
    const file = [...dt.items]
      .find(i => i.kind === 'file' && i.type.startsWith('image/'))
      ?.getAsFile();
    if (!file) return null;

    const [imageData, bitmap] = await Promise.all([
      file.arrayBuffer(),
      createImageBitmap(file),
    ]);
    const displayW = bitmap.width;
    const displayH = bitmap.height;
    bitmap.close();

    let label = '';
    let metaW = 0, metaH = 0;
    try {
      const clipItems = await navigator.clipboard.read();
      for (const ci of clipItems) {
        if (ci.types.includes(PC_MIME_META)) {
          const meta = JSON.parse(await (await ci.getType(PC_MIME_META)).text());
          if (meta.label) label  = meta.label;
          if (meta.w > 0) metaW  = meta.w;
          if (meta.h > 0) metaH  = meta.h;
        }
      }
    } catch { /* permission denied or unsupported — fine */ }

    return {
      stored: {
        data:   { label, displayW: metaW || displayW },
        binary: { image: imageData },
      },
      width:  metaW  || displayW,
      height: metaH  || displayH,
    };
  },

};

// ── Copy helpers (private to this module) ─────────────────────────────────────

async function copyImageFn(v: ImageView, api: PluginAPI): Promise<void> {
  if (!v.img.naturalWidth) { api.toast('No image to copy'); return; }
  try {
    const bmp = await createImageBitmap(v.img);
    const cvs  = document.createElement('canvas');
    cvs.width = bmp.width; cvs.height = bmp.height;
    cvs.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    cvs.toBlob(async (pngBlob) => {
      if (!pngBlob) return;
      const mimeMap: Record<string, Blob> = { 'image/png': pngBlob };
      if (v.displayW) {
        const meta: Record<string, unknown> = { pc: 1, w: Math.round(v.displayW) };
        if (v.labelEl.value) meta.label = v.labelEl.value;
        mimeMap[PC_MIME_META] = new Blob([JSON.stringify(meta)], { type: 'application/x-paste-canvas' });
      }
      await navigator.clipboard.write([new ClipboardItem(mimeMap)]);
      api.toast('Image copied to clipboard!');
    }, 'image/png');
  } catch (err) {
    api.toast('Copy failed: ' + (err as Error).message);
  }
}

async function copyImageWithLabelFn(v: ImageView, api: PluginAPI): Promise<void> {
  const label = v.labelEl.value;
  if (!v.img.naturalWidth) { api.toast('No image to copy'); return; }
  try {
    const bmp  = await createImageBitmap(v.img);

    const displayW = v.displayW || v.img.offsetWidth || bmp.width;
    const displayH = v.img.offsetHeight || bmp.height;

    // Raw canvas
    const rawCvs = document.createElement('canvas');
    rawCvs.width = bmp.width; rawCvs.height = bmp.height;
    rawCvs.getContext('2d')!.drawImage(bmp, 0, 0);

    // Composited canvas with label
    const scale  = v.img.offsetWidth ? bmp.width / v.img.offsetWidth : 1;
    const PAD_X  = Math.round(10 * scale), PAD_Y = Math.round(5 * scale);
    const FONT   = Math.round(14 * scale), LINE  = Math.round(21 * scale);
    const tmp    = document.createElement('canvas').getContext('2d')!;
    tmp.font     = `${FONT}px system-ui, sans-serif`;
    const lines  = wrapText(tmp, label, bmp.width - PAD_X * 2);
    const labelH = PAD_Y + lines.length * LINE + PAD_Y;
    const cvs    = document.createElement('canvas');
    cvs.width = bmp.width; cvs.height = bmp.height + labelH;
    const c2d  = cvs.getContext('2d')!;
    const bmpW = bmp.width, bmpH = bmp.height;
    c2d.drawImage(bmp, 0, 0);
    bmp.close();
    c2d.fillStyle = '#3b3b3b';
    c2d.fillRect(0, bmpH, bmpW, labelH);
    c2d.fillStyle = 'rgba(255,255,255,0.12)';
    c2d.fillRect(0, bmpH, bmpW, 1);
    c2d.fillStyle = '#cccccc';
    c2d.font      = `${FONT}px system-ui, sans-serif`;
    for (let i = 0; i < lines.length; i++) {
      c2d.fillText(lines[i], PAD_X, bmpH + PAD_Y + FONT + i * LINE);
    }

    const toBlob = (c: HTMLCanvasElement) => new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png'));
    const [compositedBlob, rawBlob] = await Promise.all([toBlob(cvs), toBlob(rawCvs)]);

    const meta: Record<string, unknown> = { pc: 1 };
    if (displayW) meta.w = Math.round(displayW);
    if (displayH) meta.h = Math.round(displayH);
    if (label)    meta.label = label;

    await navigator.clipboard.write([new ClipboardItem({
      'image/png':      compositedBlob,
      [PC_MIME_META]:   new Blob([JSON.stringify(meta)], { type: 'application/x-paste-canvas' }),
      [PC_MIME_IMAGE]:  new Blob([rawBlob], { type: 'application/x-paste-canvas-image' }),
    })]);
    api.toast('Image with label copied!');
  } catch (err) {
    api.toast('Copy failed: ' + (err as Error).message);
  }
}


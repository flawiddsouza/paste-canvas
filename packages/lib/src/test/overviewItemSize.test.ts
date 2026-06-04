import { describe, expect, it } from 'vitest';
import { overviewItemSize } from '../canvas.js';
import type { ItemRecord } from '../types.js';

// Decode a real image of known dimensions so naturalWidth/naturalHeight are populated.
function loadImage(w: number, h: number): Promise<HTMLImageElement> {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const img = new Image();
  return new Promise((resolve, reject) => {
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = c.toDataURL();
  });
}

function makeItem(opts: { type?: string; w?: number; h?: number; img?: HTMLImageElement }): ItemRecord {
  const el = document.createElement('div');
  if (opts.img) el.appendChild(opts.img);
  return {
    type: opts.type ?? 'img',
    w: opts.w ?? 0,
    h: opts.h ?? 0,
    el,
  } as unknown as ItemRecord;
}

describe('overviewItemSize', () => {
  it('derives a width-resize image height from its decoded aspect ratio when rec.h is 0', async () => {
    // The squish repro: a tall screenshot loaded straight into overview mode has h === 0.
    // 400×1200 source displayed at width 200 → height 600, not the old square-ish 200.
    const img = await loadImage(400, 1200);
    const { w, h } = overviewItemSize(makeItem({ w: 200, h: 0, img }));
    expect(w).toBe(200);
    expect(h).toBeCloseTo(600);
  });

  it('keeps wide images wide via aspect ratio', async () => {
    const img = await loadImage(800, 400);
    const { w, h } = overviewItemSize(makeItem({ w: 400, h: 0, img }));
    expect(w).toBe(400);
    expect(h).toBeCloseTo(200);
  });

  it('uses rec.h when it is known (mounted/measured items), ignoring aspect ratio', async () => {
    const img = await loadImage(400, 1200);
    const { h } = overviewItemSize(makeItem({ w: 200, h: 333, img }));
    expect(h).toBe(333);
  });

  it('falls back to 200 for an image whose bitmap has not decoded yet', () => {
    const img = new Image(); // no src → naturalWidth === 0
    const { w, h } = overviewItemSize(makeItem({ w: 200, h: 0, img }));
    expect(w).toBe(200);
    expect(h).toBe(200);
  });

  it('falls back to 200 for an image item with no <img> element', () => {
    const { h } = overviewItemSize(makeItem({ w: 200, h: 0 }));
    expect(h).toBe(200);
  });

  it('does not derive aspect ratio for non-image items', async () => {
    const img = await loadImage(400, 1200);
    const { h } = overviewItemSize(makeItem({ type: 'note', w: 200, h: 0, img }));
    expect(h).toBe(200);
  });

  it('defaults width to 200 when rec.w is 0, and scales height by aspect from that', async () => {
    const img = await loadImage(800, 400);
    const { w, h } = overviewItemSize(makeItem({ w: 0, h: 0, img }));
    expect(w).toBe(200);
    expect(h).toBeCloseTo(100);
  });
});

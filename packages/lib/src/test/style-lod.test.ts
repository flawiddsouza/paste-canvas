import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { css } from '../style.js';

const display = (el: Element) => getComputedStyle(el).display;

// Verifies the zoomed-out LOD rule (.pc-surface.overview-lod, applied below 50% zoom):
// image + group labels and the resize handle stay visible (the handle keeps
// double-click auto-fit / resize reachable when zoomed out), while the toolbar,
// ports and edge labels are stripped.
describe('overview-lod visibility (below 50% zoom)', () => {
  let styleEl: HTMLStyleElement;
  let root: HTMLDivElement | null = null;

  beforeAll(() => {
    styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  });
  afterAll(() => styleEl.remove());
  afterEach(() => { root?.remove(); root = null; });

  function build(lod: boolean) {
    root = document.createElement('div');
    root.className = 'paste-canvas-root';
    const surface = document.createElement('div');
    surface.className = 'pc-surface' + (lod ? ' overview-lod' : '');

    const mk = (cls: string) => { const d = document.createElement('div'); d.className = cls; return d; };
    const toolbar    = mk('item-toolbar');
    const port       = mk('port');
    const resize     = mk('resize-handle');
    const groupLabel = mk('group-label');
    const imgLabel   = document.createElement('textarea');
    imgLabel.className = 'img-label';
    imgLabel.value = 'A label';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const edgeLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    edgeLabel.setAttribute('class', 'edge-label-text');
    svg.appendChild(edgeLabel);

    surface.append(toolbar, port, resize, groupLabel, imgLabel, svg);
    root.appendChild(surface);
    document.body.appendChild(root);
    return { toolbar, port, resize, groupLabel, imgLabel, edgeLabel };
  }

  it('keeps image and group labels and the resize handle visible', () => {
    const e = build(true);
    expect(display(e.imgLabel)).not.toBe('none');
    expect(display(e.groupLabel)).not.toBe('none');
    expect(display(e.resize)).not.toBe('none');
  });

  it('hides the toolbar, ports and edge labels', () => {
    const e = build(true);
    expect(display(e.toolbar)).toBe('none');
    expect(display(e.port)).toBe('none');
    expect(display(e.edgeLabel)).toBe('none');
  });

  it('is the overview-lod class that strips the chrome — it is display-visible at normal zoom', () => {
    // At normal zoom the chrome is gated by opacity/hover, not display, so the only thing
    // turning it to display:none is the LOD class — this guards against the labels being
    // re-added to that hide rule.
    const e = build(false);
    expect(display(e.toolbar)).not.toBe('none');
    expect(display(e.port)).not.toBe('none');
    expect(display(e.resize)).not.toBe('none');
    expect(display(e.imgLabel)).not.toBe('none');
    expect(display(e.groupLabel)).not.toBe('none');
  });
});

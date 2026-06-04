import { describe, it, expect, afterEach } from 'vitest';
import { css } from '../style.js';

describe('group title + selection toolbar CSS', () => {
  const appended: HTMLElement[] = [];
  afterEach(() => { for (const el of appended.splice(0)) el.remove(); });

  /** Inject the stylesheet and a fresh `.paste-canvas-root` to build into. */
  function root(): HTMLElement {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.className = 'paste-canvas-root';
    document.body.appendChild(el);
    appended.push(style, el);
    return el;
  }

  it('renders the group label as a title above the box', () => {
    const group = document.createElement('div');
    group.className = 'item item-group';
    group.style.cssText = 'position:absolute;left:0;top:200px;width:400px;height:300px';
    const label = document.createElement('textarea');
    label.className = 'group-label';
    label.value = 'Title';
    group.appendChild(label);
    root().appendChild(group);

    // Label is a title above the box: its bottom edge is at or above the box top.
    expect(label.offsetTop + label.offsetHeight).toBeLessThanOrEqual(0);
  });

  it('shows an item toolbar only when the item is selected', () => {
    const item = document.createElement('div');
    item.className = 'item item-image';
    const tb = document.createElement('div');
    tb.className = 'item-toolbar';
    item.appendChild(tb);
    root().appendChild(item);

    expect(getComputedStyle(tb).pointerEvents).toBe('none'); // unselected: hidden

    item.classList.add('selected');
    expect(getComputedStyle(tb).pointerEvents).toBe('auto'); // selected: shown
  });

  it('hides item toolbars while a drag is in progress', () => {
    const item = document.createElement('div');
    item.className = 'item item-image selected';
    const tb = document.createElement('div');
    tb.className = 'item-toolbar';
    item.appendChild(tb);
    root().appendChild(item);

    expect(getComputedStyle(tb).pointerEvents).toBe('auto'); // selected: shown

    document.body.classList.add('paste-canvas-dragging');
    try {
      expect(getComputedStyle(tb).pointerEvents).toBe('none'); // dragging: hidden
    } finally {
      document.body.classList.remove('paste-canvas-dragging');
    }
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { css } from '../style.js';

describe('tab bar layout CSS', () => {
  let styleEl: HTMLStyleElement;
  let root: HTMLDivElement | null = null;

  beforeAll(() => {
    styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  });
  afterAll(() => styleEl.remove());
  afterEach(() => { root?.remove(); root = null; });

  function build(sidebar: boolean) {
    root = document.createElement('div');
    root.className = 'paste-canvas-root' + (sidebar ? ' layout-sidebar' : '');
    const body = document.createElement('div');
    body.className = 'pc-body';
    const tabBar = document.createElement('div');
    tabBar.className = 'pc-tab-bar';
    body.appendChild(tabBar);
    root.appendChild(body);
    document.body.appendChild(root);
    return { body, tabBar };
  }

  function addTab(tabBar: HTMLElement, name: string) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    const tabName = document.createElement('span');
    tabName.className = 'tab-name';
    tabName.textContent = name;
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    tab.append(tabName, close);
    tabBar.appendChild(tab);
    return { tab, tabName };
  }

  it('lays the tab bar out as a row in the default (top-bar) layout', () => {
    const { tabBar } = build(false);
    expect(getComputedStyle(tabBar).flexDirection).toBe('row');
  });

  it('lays the tab bar out as a column in the sidebar layout', () => {
    const { body, tabBar } = build(true);
    expect(getComputedStyle(body).flexDirection).toBe('row');
    expect(getComputedStyle(tabBar).flexDirection).toBe('column');
  });

  it('wraps a long multi-word label to multiple lines in the sidebar', () => {
    const { tabBar } = build(true);
    const short = addTab(tabBar, 'Tab').tab;
    const long = addTab(tabBar, 'Journals New Style 15 March Long Label').tab;
    expect(long.offsetHeight).toBeGreaterThan(short.offsetHeight);
  });

  it('breaks a long unbroken word instead of overflowing the sidebar tab', () => {
    const { tabBar } = build(true);
    const short = addTab(tabBar, 'Tab').tab;
    const wide = addTab(tabBar, 'Supercalifragilisticexpialidociousandthensome').tab;
    expect(wide.offsetHeight).toBeGreaterThan(short.offsetHeight);
  });

  it('keeps top-bar labels on a single line', () => {
    const { tabBar } = build(false);
    const short = addTab(tabBar, 'Tab').tab;
    const long = addTab(tabBar, 'Journals New Style 15 March Long Label').tab;
    expect(long.offsetHeight).toBe(short.offsetHeight);
  });
});

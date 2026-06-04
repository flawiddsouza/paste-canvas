import { describe, expect, it, vi } from 'vitest';
import { ImagePlugin } from '../plugins/ImagePlugin.js';
import type { PluginAPI } from '../plugin.js';

function makeApi(itemEl: HTMLElement, overrides: Partial<PluginAPI> = {}): PluginAPI {
  return {
    itemId: 1,
    itemEl,
    signal: new AbortController().signal,
    scale: 0.2,
    isSelected: () => false,
    pushUndo: () => {},
    save: () => {},
    notifyResized: () => {},
    refreshOverview: () => {},
    toast: () => {},
    confirm: async () => false,
    ...overrides,
  };
}

describe('ImagePlugin overview refresh', () => {
  it('refreshes the zoomed-out overview tile when an image finishes decoding', () => {
    // Repro: a tab opened below OVERVIEW_SCALE draws the overview tile before images
    // decode (grey placeholders). When an image's load event fires, the plugin must
    // ask the core to rebuild the tile so the real image replaces the placeholder.
    const refreshOverview = vi.fn();
    const view = ImagePlugin.create(makeApi(document.createElement('div'), { refreshOverview }));

    view.img.dispatchEvent(new Event('load'));

    expect(refreshOverview).toHaveBeenCalled();
  });
});

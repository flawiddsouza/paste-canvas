import { describe, it, expect, vi } from 'vitest';
import { GroupPlugin } from '../plugins/GroupPlugin.js';
import type { PluginAPI } from '../plugin.js';

function makeApi(overrides: Partial<PluginAPI> = {}): PluginAPI {
  return {
    itemId: 1,
    itemEl: document.createElement('div'),
    signal: new AbortController().signal,
    scale: 1,
    isSelected: () => true,
    deselect: () => {},
    pushUndo: () => {},
    save: () => {},
    notifyResized: () => {},
    refreshOverview: () => {},
    toast: () => {},
    confirm: async () => false,
    ...overrides,
  };
}

describe('GroupPlugin label', () => {
  it('deselects the group when the label gains focus, so the toolbar clears for typing', () => {
    const deselect = vi.fn();
    const view = GroupPlugin.create(makeApi({ deselect }));
    view.labelEl.dispatchEvent(new Event('focus'));
    expect(deselect).toHaveBeenCalled();
  });

  it('deselects again on a fresh click even when the label already holds focus', () => {
    // The group can be re-selected while the label keeps focus (the item drag
    // handler preventDefaults its pointerdown), so `focus` won't fire again — the
    // pointerdown must still clear the selection.
    const deselect = vi.fn();
    const view = GroupPlugin.create(makeApi({ deselect }));
    view.labelEl.dispatchEvent(new Event('pointerdown'));
    expect(deselect).toHaveBeenCalled();
  });
});

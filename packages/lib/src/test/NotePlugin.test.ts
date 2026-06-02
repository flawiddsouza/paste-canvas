import { describe, expect, it } from 'vitest';
import { NotePlugin } from '../plugins/NotePlugin.js';
import type { PluginAPI } from '../plugin.js';

function makeApi(itemEl: HTMLElement): PluginAPI {
  return {
    itemId: 1,
    itemEl,
    signal: new AbortController().signal,
    scale: 1,
    isSelected: () => true,
    pushUndo: () => {},
    save: () => {},
    notifyResized: () => {},
    toast: () => {},
    confirm: async () => false,
  };
}

describe('NotePlugin color shortcuts', () => {
  it('does not recolor a selected note when typing a color digit in a contentEditable field (e.g. tab title)', () => {
    const itemEl = document.createElement('div');
    const api = makeApi(itemEl);
    NotePlugin.create(api); // registers the document keydown listener

    const editable = document.createElement('span');
    editable.contentEditable = 'plaintext-only';
    document.body.append(itemEl, editable);

    try {
      // A color digit typed inside the editable must NOT recolor the note.
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
      expect(itemEl.classList.contains('colored')).toBe(false);

      // Control: the same key on a non-editable target still recolors.
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
      expect(itemEl.classList.contains('colored')).toBe(true);
    } finally {
      itemEl.remove();
      editable.remove();
    }
  });
});

import type { ItemPlugin } from '../plugin.js';

interface GroupView {
  el:      HTMLElement;
  labelEl: HTMLTextAreaElement;
}

interface GroupSnap {
  text: string;
}

export const GroupPlugin: ItemPlugin<GroupView, GroupSnap> = {
  kind:      'item',
  type:      'group',
  label:     'Group',
  container: true,
  ports:     false,
  resize:    'both',

  create(api) {
    const el      = document.createElement('div');
    const labelEl = document.createElement('textarea');
    labelEl.className   = 'group-label';
    labelEl.placeholder = 'Label\u2026';
    labelEl.rows        = 1;
    labelEl.spellcheck  = false;
    el.append(labelEl);

    // Editing the title should not fight the group's selection toolbar: clicking
    // (or tabbing) into the label deselects the group so the toolbar clears out
    // of the way. pointerdown covers re-clicking a label that already holds focus
    // (the group can be re-selected without the label ever blurring, so `focus`
    // alone wouldn't fire again).
    const dropGroupSelection = () => api.deselect();
    labelEl.addEventListener('pointerdown', dropGroupSelection, { signal: api.signal });
    labelEl.addEventListener('focus',       dropGroupSelection, { signal: api.signal });

    let t: ReturnType<typeof setTimeout> | null = null;
    labelEl.addEventListener('input', () => {
      clearTimeout(t ?? undefined);
      t = setTimeout(() => api.save(), 600);
    }, { signal: api.signal });

    return { el, labelEl };
  },

  snapshot:  v     => ({ text: v.labelEl.value }),
  restore:   (v,s) => { v.labelEl.value = s.text; },
  serialize: v     => ({ data: { text: v.labelEl.value } }),
  hydrate:   (v,s) => { v.labelEl.value = (s.data as any)?.text ?? ''; },
};

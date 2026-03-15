import type { ItemPlugin } from '../plugin.js';

interface GroupView {
  el:      HTMLElement;
  labelEl: HTMLTextAreaElement;
}

interface GroupSnap {
  text: string;
}

export const GroupPlugin: ItemPlugin<GroupView, GroupSnap> = {
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

import { describe, it, expect, vi } from 'vitest';
import type { Ctx, ItemRecord } from '../types.js';

vi.mock('../items.js', () => ({ saveItem: vi.fn(), createItem: vi.fn(), removeItem: vi.fn() }));
vi.mock('../history.js', () => ({ pushUndo: vi.fn() }));
vi.mock('../canvas.js', () => ({ toast: vi.fn(), selectItem: vi.fn() }));

import { expandGroupToContain, resolveDropGroup, reparentItems } from '../groups.js';
import { saveItem } from '../items.js';

function rec(
  id: number, type: string,
  x: number, y: number, w: number, h: number, z: number,
  groupId?: number,
): ItemRecord {
  const el = document.createElement('div');
  el.style.left = x + 'px'; el.style.top = y + 'px';
  el.style.width = w + 'px'; el.style.height = h + 'px';
  el.style.zIndex = String(z);
  return { id, el, type, x, y, w, h, groupId, mounted: true, bound: {} as any } as ItemRecord;
}

describe('expandGroupToContain', () => {
  it('grows the group on all sides (with 24px pad) to contain an outside member', () => {
    const g = rec(1, 'group', 100, 100, 200, 200, 1);
    const m = rec(2, 'note', 40, 350, 50, 50, 2); // left of and below the group
    expandGroupToContain(g, m);
    // left edge: 40 - 24 = 16 ; top stays (member top 350 is below group top 100)
    expect(g.x).toBe(16);
    expect(g.y).toBe(100);
    // right edge unchanged (member right 90 < group right 300) -> right stays 300
    // bottom edge: 350 + 50 + 24 = 424
    expect(g.x + g.w).toBe(300);
    expect(g.y + g.h).toBe(424);
    expect(g.el.style.left).toBe('16px');
    expect(g.el.style.height).toBe((424 - 100) + 'px');
  });

  it('does nothing when the member already fits inside', () => {
    const g = rec(1, 'group', 0, 0, 400, 400, 1);
    const m = rec(2, 'note', 100, 100, 50, 50, 2);
    expandGroupToContain(g, m);
    expect(g.x).toBe(0); expect(g.y).toBe(0);
    expect(g.w).toBe(400); expect(g.h).toBe(400);
  });
});

function makeCtx(items: ItemRecord[]): Ctx {
  const itemsById = new Map(items.map(i => [i.id, i]));
  const itemPlugins = new Map<string, any>([
    ['group', { container: true }],
    ['note',  { container: false }],
  ]);
  return { items, itemsById, itemPlugins } as unknown as Ctx;
}

describe('resolveDropGroup', () => {
  it('returns the group whose bounds contain the point', () => {
    const g = rec(1, 'group', 0, 0, 200, 200, 1);
    const ctx = makeCtx([g]);
    expect(resolveDropGroup(ctx, 100, 100, [])).toBe(g);
    expect(resolveDropGroup(ctx, 300, 300, [])).toBeNull();
  });

  it('picks the innermost (highest z-index) group when nested groups overlap', () => {
    const outer = rec(1, 'group', 0, 0, 400, 400, 1);
    const inner = rec(2, 'group', 50, 50, 200, 200, 5, 1); // member of outer
    const ctx = makeCtx([outer, inner]);
    expect(resolveDropGroup(ctx, 100, 100, [])).toBe(inner);
    expect(resolveDropGroup(ctx, 380, 380, [])).toBe(outer); // only outer contains it
  });

  it('excludes the dragged group itself and its descendants', () => {
    const outer = rec(1, 'group', 0, 0, 400, 400, 1);
    const inner = rec(2, 'group', 50, 50, 200, 200, 5, 1);
    const ctx = makeCtx([outer, inner]);
    // Dragging `outer`: cannot drop it into itself (outer) nor into its descendant (inner).
    expect(resolveDropGroup(ctx, 100, 100, [outer])).toBeNull();
  });
});

describe('reparentItems', () => {
  it('joins items to the target group and expands the group to contain them', () => {
    const g = rec(1, 'group', 0, 0, 200, 200, 1);
    const a = rec(2, 'note', 300, 50, 50, 50, 9); // outside the group to the right
    const ctx = makeCtx([g, a]);
    vi.mocked(saveItem).mockClear();

    const data = reparentItems(ctx, [a], g);

    expect(a.groupId).toBe(1);
    expect(data.changed).toBe(true);
    expect(data.itemsBefore.get(2)).toEqual({ groupId: undefined, z: 9 });
    expect(data.itemsAfter.get(2)).toEqual({ groupId: 1, z: 9 });
    // group grew to the right to include a (300 + 50 + 24 = 374)
    expect(g.x + g.w).toBe(374);
    expect(data.groupBefore.get(1)).toEqual({ x: 0, y: 0, w: 200, h: 200 });
    expect(data.groupAfter.get(1)!.w).toBe(374);
    expect(vi.mocked(saveItem)).toHaveBeenCalled();
  });

  it('raises a joined item z-index above the group when it would be hidden behind it', () => {
    const g = rec(1, 'group', 0, 0, 400, 400, 5);
    const a = rec(2, 'note', 100, 100, 50, 50, 2); // z below the group
    const ctx = makeCtx([g, a]);

    const data = reparentItems(ctx, [a], g);

    expect(a.el.style.zIndex).toBe('6'); // group z (5) + 1
    expect(data.itemsAfter.get(2)).toEqual({ groupId: 1, z: 6 });
  });

  it('detaches items when target is null and does not resize anything', () => {
    const g = rec(1, 'group', 0, 0, 400, 400, 1);
    const a = rec(2, 'note', 100, 100, 50, 50, 9, 1); // currently a member of g
    const ctx = makeCtx([g, a]);

    const data = reparentItems(ctx, [a], null);

    expect(a.groupId).toBeUndefined();
    expect(data.changed).toBe(true);
    expect(data.itemsBefore.get(2)).toEqual({ groupId: 1, z: 9 });
    expect(data.itemsAfter.get(2)).toEqual({ groupId: undefined, z: 9 });
    expect(data.groupBefore.size).toBe(0);
    expect(data.groupAfter.size).toBe(0);
  });

  it('is a no-op when an item is already in the target group', () => {
    const g = rec(1, 'group', 0, 0, 400, 400, 1);
    const a = rec(2, 'note', 100, 100, 50, 50, 9, 1);
    const ctx = makeCtx([g, a]);

    const data = reparentItems(ctx, [a], g);

    expect(data.changed).toBe(false);
    expect(data.itemsBefore.size).toBe(0);
    expect(data.groupBefore.size).toBe(0);
  });
});

describe('reparentItems — nesting a group', () => {
  it('nests a group into another group and lifts its members to keep z-order', () => {
    const b = rec(1, 'group', 0, 0, 600, 600, 10);     // target, high z
    const a = rec(2, 'group', 100, 100, 200, 200, 3);   // dragged group, z below B
    const m = rec(3, 'note', 120, 120, 50, 50, 4, 2);   // member of A, above A
    const ctx = makeCtx([b, a, m]);

    const data = reparentItems(ctx, [a], b);

    expect(a.groupId).toBe(1);                  // A is now a member of B
    expect(m.groupId).toBe(2);                  // m still belongs to A
    // A bumped above B (10) -> 11; member lifted by the same delta (8): 4 -> 12
    expect(a.el.style.zIndex).toBe('11');
    expect(m.el.style.zIndex).toBe('12');
    expect(data.itemsAfter.get(2)).toEqual({ groupId: 1, z: 11 });
    expect(data.itemsBefore.get(3)).toEqual({ groupId: 2, z: 4 });
    expect(data.itemsAfter.get(3)).toEqual({ groupId: 2, z: 12 });
  });

  it('does not shift members when the nested group needs no z bump', () => {
    const b = rec(1, 'group', 0, 0, 600, 600, 2);      // target, low z
    const a = rec(2, 'group', 100, 100, 200, 200, 9);   // already above B
    const m = rec(3, 'note', 120, 120, 50, 50, 10, 2);
    const ctx = makeCtx([b, a, m]);

    const data = reparentItems(ctx, [a], b);

    expect(a.el.style.zIndex).toBe('9');        // unchanged
    expect(m.el.style.zIndex).toBe('10');       // unchanged
    expect(data.itemsBefore.has(3)).toBe(false); // member not touched
  });
});

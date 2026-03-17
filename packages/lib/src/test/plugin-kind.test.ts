import { describe, it, expect } from 'vitest';
import { NotePlugin } from '../plugins/NotePlugin.js';
import { ImagePlugin } from '../plugins/ImagePlugin.js';
import { GroupPlugin } from '../plugins/GroupPlugin.js';

describe('built-in plugin kinds', () => {
  it('NotePlugin has kind: item', () => {
    expect(NotePlugin.kind).toBe('item');
  });
  it('ImagePlugin has kind: item', () => {
    expect(ImagePlugin.kind).toBe('item');
  });
  it('GroupPlugin has kind: item', () => {
    expect(GroupPlugin.kind).toBe('item');
  });
});

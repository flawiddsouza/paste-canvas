import type { CanvasPlugin, ToolbarItem } from '@paste-canvas/lib';

export function WebControlsPlugin(opts: {
  onOpenFolder?: () => void;
  onClose: () => void;
}): CanvasPlugin {
  return {
    kind: 'canvas',
    toolbarButtons: (): ToolbarItem[] => {
      const close: ToolbarItem = { kind: 'button', label: 'Close', onClick: opts.onClose };

      if (opts.onOpenFolder) {
        return [
          { kind: 'separator' },
          { kind: 'button', label: 'Open Folder', onClick: opts.onOpenFolder },
          close,
        ];
      }

      return [close];
    },
  };
}

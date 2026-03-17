import type { CanvasPlugin, ToolbarItem } from '@paste-canvas/lib';

export function TauriControlsPlugin(opts: {
  onOpenFolder: () => void;
  onClose: () => void;
  onNewWindow: () => void;
}): CanvasPlugin {
  return {
    kind: 'canvas',
    toolbarButtons: (): ToolbarItem[] => [
      { kind: 'separator' },
      { kind: 'button', label: 'Open Folder', onClick: opts.onOpenFolder },
      { kind: 'button', label: 'Close',       onClick: opts.onClose },
      { kind: 'button', label: 'New Window',  onClick: opts.onNewWindow },
    ],
  };
}

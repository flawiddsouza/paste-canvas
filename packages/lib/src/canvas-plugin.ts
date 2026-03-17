import type { StorageAdapter } from './types.js';

export interface CanvasAPI {
  readonly adapter: StorageAdapter;
  readonly currentTabId: number | null;
  toast(message: string): void;
  refreshTabs(): Promise<void>;
}

export type ToolbarItem =
  | { kind: 'button';   label: string; onClick: () => void }
  | { kind: 'dropdown'; label: string; items: ReadonlyArray<{ label: string; onClick: () => void }> }
  | { kind: 'separator' }

export interface CanvasPlugin {
  kind: 'canvas';
  toolbarButtons?: (api: CanvasAPI) => ToolbarItem[];
  onMount?: (api: CanvasAPI) => void;
  onDestroy?: () => void;
}

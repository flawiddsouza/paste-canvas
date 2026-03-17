import type { CanvasPlugin, CanvasAPI, ToolbarItem } from '../canvas-plugin.js';
import { exportCanvas, importCanvas, PcvsFormatError } from '../export-import.js';

export function ExportImportPlugin(config?: { toolbar?: boolean }): CanvasPlugin {
  const showToolbar = config?.toolbar !== false;

  return {
    kind: 'canvas',

    toolbarButtons: showToolbar ? (api: CanvasAPI): ToolbarItem[] => [
      { kind: 'separator' },
      {
        kind: 'dropdown',
        label: 'Export',
        items: [
          { label: 'Export Tab', onClick: () => void doExport(api, api.currentTabId ?? undefined) },
          { label: 'Export All', onClick: () => void doExport(api, undefined) },
        ],
      },
      { kind: 'button', label: 'Import', onClick: () => openImportPicker(api) },
    ] : undefined,
  };
}

async function doExport(api: CanvasAPI, tabId: number | undefined): Promise<void> {
  try {
    const blob = await exportCanvas(api.adapter, tabId);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
    triggerDownload(blob, `PasteCanvas_${ts}.pcvs`);
  } catch {
    api.toast('Export failed');
  }
}

function openImportPicker(api: CanvasAPI): void {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.pcvs';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await importCanvas(api.adapter, file);
      await api.refreshTabs();
      api.toast('Imported successfully');
    } catch (e) {
      api.toast(e instanceof PcvsFormatError ? `Import failed: ${e.message}` : 'Import failed');
    }
  });
  input.click();
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

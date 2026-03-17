import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../export-import.js', () => {
  class PcvsFormatError extends Error {
    constructor(msg: string) { super(msg); this.name = 'PcvsFormatError'; }
  }
  return {
    exportCanvas: vi.fn(),
    importCanvas: vi.fn(),
    PcvsFormatError,
  };
});

import { ExportImportPlugin } from '../plugins/ExportImportPlugin.js';
import { exportCanvas, importCanvas, PcvsFormatError } from '../export-import.js';
import type { CanvasAPI } from '../canvas-plugin.js';
import type { ToolbarItem } from '../canvas-plugin.js';
import type { StorageAdapter } from '../types.js';

function makeApi() {
  const toast       = vi.fn<(msg: string) => void>();
  const refreshTabs = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const api: CanvasAPI = {
    adapter:      {} as StorageAdapter,
    currentTabId: null,
    toast,
    refreshTabs,
  };
  return { api, toast, refreshTabs };
}

function getItems(api: CanvasAPI): ToolbarItem[] {
  return ExportImportPlugin().toolbarButtons!(api);
}

function getDropdown(items: ToolbarItem[], label: string) {
  return items.find(
    (i): i is Extract<ToolbarItem, { kind: 'dropdown' }> => i.kind === 'dropdown' && i.label === label
  )!;
}

function getButton(items: ToolbarItem[], label: string) {
  return items.find(
    (i): i is Extract<ToolbarItem, { kind: 'button' }> => i.kind === 'button' && i.label === label
  )!;
}

/** Triggers the Import button and injects a file into the hidden file input. */
async function clickImportWithFile(api: CanvasAPI, file: File): Promise<void> {
  const captured = { input: null as HTMLInputElement | null };
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, ...rest: unknown[]) => {
    const el = (origCreate as (...a: unknown[]) => HTMLElement)(tag, ...rest);
    if (tag === 'input') {
      captured.input = el as HTMLInputElement;
      vi.spyOn(captured.input, 'click').mockImplementation(() => {});
    }
    return el;
  }) as typeof document.createElement);

  getButton(getItems(api), 'Import').onClick();
  vi.restoreAllMocks();

  if (!captured.input) throw new Error('file input was not created');
  Object.defineProperty(captured.input, 'files', { value: { 0: file, length: 1 }, configurable: true });
  captured.input.dispatchEvent(new Event('change'));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ExportImportPlugin', () => {
  beforeEach(() => vi.resetAllMocks());

  it('toolbarButtons is undefined when toolbar: false', () => {
    const plugin = ExportImportPlugin({ toolbar: false });
    expect(plugin.toolbarButtons).toBeUndefined();
  });

  it('returns [separator, Export dropdown, Import button]', () => {
    const { api } = makeApi();
    const items = getItems(api);
    expect(items[0].kind).toBe('separator');
    expect(items[1]).toMatchObject({ kind: 'dropdown', label: 'Export' });
    expect(items[2]).toMatchObject({ kind: 'button',   label: 'Import' });
  });

  it('Export dropdown has "Export Tab" and "Export All" items', () => {
    const { api } = makeApi();
    const dropdown = getDropdown(getItems(api), 'Export');
    expect(dropdown.items.map(i => i.label)).toEqual(['Export Tab', 'Export All']);
  });

  it('Export Tab calls exportCanvas with currentTabId', async () => {
    vi.mocked(exportCanvas).mockResolvedValue(new Blob());
    const { api } = makeApi();
    const apiWithTab: CanvasAPI = { ...api, currentTabId: 42 };
    getDropdown(getItems(apiWithTab), 'Export').items[0].onClick();
    await vi.waitFor(() => expect(exportCanvas).toHaveBeenCalledWith(apiWithTab.adapter, 42));
  });

  it('Export All calls exportCanvas without tabId', async () => {
    vi.mocked(exportCanvas).mockResolvedValue(new Blob());
    const { api } = makeApi();
    const apiWithTab: CanvasAPI = { ...api, currentTabId: 42 };
    getDropdown(getItems(apiWithTab), 'Export').items[1].onClick();
    await vi.waitFor(() => expect(exportCanvas).toHaveBeenCalledWith(apiWithTab.adapter, undefined));
  });

  it('toasts "Export failed" when exportCanvas throws', async () => {
    vi.mocked(exportCanvas).mockRejectedValue(new Error('disk full'));
    const { api, toast } = makeApi();
    getDropdown(getItems(api), 'Export').items[0].onClick();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Export failed'));
  });

  it('calls refreshTabs and toasts success after successful import', async () => {
    vi.mocked(importCanvas).mockResolvedValue({ tabIds: [2] });
    const { api, toast, refreshTabs } = makeApi();
    await clickImportWithFile(api, new File([new ArrayBuffer(10)], 'canvas.pcvs'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Imported successfully'));
    expect(refreshTabs).toHaveBeenCalled();
  });

  it('toasts the PcvsFormatError message on a bad file', async () => {
    vi.mocked(importCanvas).mockRejectedValue(new PcvsFormatError('unsupported version'));
    const { api, toast } = makeApi();
    await clickImportWithFile(api, new File([new ArrayBuffer(10)], 'bad.pcvs'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Import failed: unsupported version'));
  });

  it('toasts generic "Import failed" for non-format errors', async () => {
    vi.mocked(importCanvas).mockRejectedValue(new Error('network error'));
    const { api, toast } = makeApi();
    await clickImportWithFile(api, new File([new ArrayBuffer(10)], 'canvas.pcvs'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Import failed'));
  });
});

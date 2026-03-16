// packages/web/src/fsa-types.d.ts

interface FileSystemChangeRecord {
  changedHandle: FileSystemHandle | null;
  type: 'appeared' | 'disappeared' | 'modified' | 'moved' | 'unknown' | 'errored';
}

declare class FileSystemObserver {
  constructor(
    callback: (records: FileSystemChangeRecord[], observer: FileSystemObserver) => void,
  );
  observe(handle: FileSystemHandle, options?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
}

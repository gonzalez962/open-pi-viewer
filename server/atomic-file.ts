import fs from 'node:fs';

/** Replace a staged file without removing the destination, retrying short Windows locks. */
export function replaceStagedFileSync(source: string, destination: string): void {
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(source, destination);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(code || '') || attempt >= 4) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  } catch (error) {
    try { fs.unlinkSync(source); } catch {}
    throw error;
  }
}

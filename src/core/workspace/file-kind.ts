import type { WorkspaceFileKind } from '../types/workspace';

/** Maximum permitted size for workspace text reading (2 MB) */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/** Maximum permitted size for workspace media preview (25 MB) */
export const MAX_MEDIA_FILE_BYTES = 25 * 1024 * 1024;

export interface FileClassification {
  kind: WorkspaceFileKind;
  mimeType: string | null;
  isBinary: boolean;
}

const IMAGE_MIME_MAP: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

const VIDEO_MIME_MAP: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
};

const DETERMINISTIC_BINARY_EXTENSIONS = new Set<string>([
  // Shared libraries & executables
  'so',
  'dll',
  'dylib',
  'exe',
  'bin',
  'hex',
  'obj',
  'o',
  'a',
  'lib',
  'class',
  'pyc',
  'pyo',
  'pyd',
  'wasm',
  // Databases
  'db',
  'sqlite',
  'sqlite3',
  'rdb',
  'db-wal',
  'db-shm',
  // Archives & compressed packages
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'zst',
  'iso',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  // Audio (non-preview binary)
  'mp3',
  'wav',
  'aac',
  'flac',
  'm4a',
  // Fonts
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  // Documents
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
]);

function extractFileExtension(filename: string): string | null {
  const base = filename.trim().split(/[/\\]/).pop() || '';
  const lastDot = base.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === base.length - 1) {
    return null;
  }
  return base.slice(lastDot + 1).toLowerCase();
}

/**
 * Returns allowlisted image MIME type for known raster/vector images, or null.
 */
export function getImageMimeType(filename: string): string | null {
  const ext = extractFileExtension(filename);
  if (!ext) return null;
  return IMAGE_MIME_MAP[ext] ?? null;
}

/**
 * Returns allowlisted video MIME type for known video containers, or null.
 */
export function getVideoMimeType(filename: string): string | null {
  const ext = extractFileExtension(filename);
  if (!ext) return null;
  return VIDEO_MIME_MAP[ext] ?? null;
}

/**
 * Checks if a filename is deterministically a binary or non-code file.
 * Handles explicit .so versions (e.g. libc.so.6, libcrypto.so.1.1) and db-wal/db-shm.
 */
export function isDeterministicBinary(filename: string): boolean {
  const lower = filename.trim().toLowerCase();

  // .so and versioned .so.* (e.g. libssl.so, libssl.so.1, libc.so.6)
  if (lower.endsWith('.so') || /\.so(\.\d+)+$/.test(lower)) {
    return true;
  }

  // SQLite WAL and SHM files (e.g. app.db-wal, app.db-shm)
  if (lower.endsWith('.db-wal') || lower.endsWith('.db-shm')) {
    return true;
  }

  const ext = extractFileExtension(filename);
  if (!ext) return false;

  return DETERMINISTIC_BINARY_EXTENSIONS.has(ext);
}

/**
 * Inspects a byte buffer for binary indicators:
 * - NUL bytes (0x00)
 * - Control characters (excluding \t, \n, \r, \f, ESC)
 * - Malformed UTF-8 byte sequences
 */
export function isBinaryBuffer(buffer: Uint8Array | number[]): boolean {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    // Immediate NUL check
    if (b === 0) {
      return true;
    }
    // Control characters check (ASCII < 32 excluding \t, \n, \r, \f, ESC, plus DEL 0x7F)
    if (
      (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) ||
      b === 0x7f
    ) {
      return true;
    }
  }

  // UTF-8 validation
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(u8);
    return false;
  } catch {
    return true;
  }
}

/**
 * Classifies a workspace file by name, extension, and optional buffer content.
 */
export function classifyWorkspaceFile(
  filename: string,
  buffer?: Uint8Array | number[] | null
): FileClassification {
  const imageMime = getImageMimeType(filename);
  if (imageMime) {
    return { kind: 'image', mimeType: imageMime, isBinary: true };
  }

  const videoMime = getVideoMimeType(filename);
  if (videoMime) {
    return { kind: 'video', mimeType: videoMime, isBinary: true };
  }

  if (isDeterministicBinary(filename)) {
    return { kind: 'binary', mimeType: null, isBinary: true };
  }

  if (buffer) {
    if (isBinaryBuffer(buffer)) {
      return { kind: 'binary', mimeType: null, isBinary: true };
    }
    return { kind: 'text', mimeType: null, isBinary: false };
  }

  return { kind: 'text', mimeType: null, isBinary: false };
}

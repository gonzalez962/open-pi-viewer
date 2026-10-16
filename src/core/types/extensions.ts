export type PiResourceKind = 'extension' | 'package';

export type PiResourceScope = 'global' | 'project';

export interface PiPackageFilters {
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  [key: string]: unknown;
}

export interface PiResourceEntry {
  id: string;
  name: string;
  kind: PiResourceKind;
  source: string;
  scope: PiResourceScope;
  enabled: boolean;
  configPath: string;
  raw?: unknown;
  autoload?: boolean;
  filters?: PiPackageFilters;
  hasProjectOverride?: boolean;
  alwaysActive?: boolean;
  globalEnabled?: boolean;
  sourceScope?: PiResourceScope;
  extensionPath?: string;
  extensionDir?: string;
}

export interface PiResourcesPayload {
  resources: PiResourceEntry[];
}

export interface GetPiResourcesPayload {
  cwd?: string;
}

export interface SavePiResourcePayload {
  kind: PiResourceKind;
  source: string;
  oldSource?: string;
  scope?: PiResourceScope;
  enabled?: boolean;
  raw?: unknown;
  cwd?: string;
  extensionPath?: string;
  extensionDir?: string;
}

export interface SavePiResourceResult {
  success: boolean;
  id: string;
  kind: PiResourceKind;
  source: string;
  scope: PiResourceScope;
  configPath: string;
  requiresReload: true;
}

export interface TogglePiResourcePayload {
  kind: PiResourceKind;
  source: string;
  enabled: boolean;
  scope?: PiResourceScope;
  cwd?: string;
}

export interface TogglePiResourceResult {
  success: boolean;
  id: string;
  kind: PiResourceKind;
  source: string;
  scope: PiResourceScope;
  enabled: boolean;
  configPath: string;
  requiresReload: true;
}

export interface DeletePiResourcePayload {
  kind: PiResourceKind;
  source: string;
  scope?: PiResourceScope;
  cwd?: string;
}

export interface DeletePiResourceResult {
  success: boolean;
  id: string;
  kind: PiResourceKind;
  source: string;
  scope: PiResourceScope;
  configPath: string;
  requiresReload: true;
}

/**
 * Normalizes and validates a target source string for toggle, delete, or existence lookup.
 * Strips leading '!' or '+' markers for extensions and trims whitespace.
 * Throws an error if the source is empty, whitespace-only, or a bare marker without a target path.
 */
export function normalizeTargetSource(
  kind: PiResourceKind,
  source: string
): string {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error(
      `${kind === 'extension' ? 'Extension' : 'Package'} source must not be empty`
    );
  }
  const clean =
    kind === 'extension' && (trimmed.startsWith('!') || trimmed.startsWith('+'))
      ? trimmed.slice(1).trim()
      : trimmed;
  if (!clean) {
    throw new Error(
      `Invalid ${kind} source '${source}': bare marker without target path`
    );
  }
  if (clean.includes('\0')) {
    throw new Error('Source contains invalid characters');
  }
  return clean;
}

/**
 * Normalizes a stable unique identifier for a Pi resource entry across scopes and kinds.
 */
export function normalizeResourceId(
  scope: PiResourceScope,
  kind: PiResourceKind,
  source: string
): string {
  const cleanSource = normalizeTargetSource(kind, source);
  return `${scope.toLowerCase()}:${kind.toLowerCase()}:${cleanSource}`;
}

/**
 * Derives a human-friendly display name for a Pi resource.
 */
export function deriveResourceName(kind: PiResourceKind, source: string): string {
  const trimmed = source.trim();
  if (kind === 'package') {
    const s = trimmed.startsWith('npm:') ? trimmed.slice(4) : trimmed;
    if (s.startsWith('git:')) {
      const gitS = s.slice(4).split('@')[0];
      const segs = gitS.split('/');
      return segs[segs.length - 1] || gitS;
    }
    if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ssh://')) {
      const noProto = s.split('://')[1] || s;
      const noRef = noProto.split('@')[0];
      const cleaned = noRef.replace(/\.git$/, '');
      const segs = cleaned.split('/');
      return segs[segs.length - 1] || cleaned;
    }
    const lastAt = s.lastIndexOf('@');
    if (lastAt > 0) {
      return s.slice(0, lastAt);
    }
    return s;
  }

  // Extension
  const normalized = trimmed.replace(/\\/g, '/');
  const clean = normalized.replace(/^[!+-]/, '').trim();
  const parts = clean.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (
      last === 'index.ts' ||
      last === 'index.js' ||
      last === 'index.mjs' ||
      last === 'index'
    ) {
      const parent = parts[parts.length - 2];
      if (parent !== 'extensions' && parent !== '.') {
        return parent;
      }
    }
  }
  return parts[parts.length - 1] || clean;
}

export const INDEX_ENTRY_NAMES = new Set([
  'index',
  'index.ts',
  'index.js',
  'index.mjs',
]);

/**
 * Checks whether an entry or file name is a generic index file.
 */
export function isIndexEntryName(name?: string): boolean {
  if (!name) return true;
  return INDEX_ENTRY_NAMES.has(name.trim().toLowerCase());
}

/**
 * Derives user-facing display name for a Pi resource.
 * - Preserves declared names for regular extensions and packages.
 * - Defensively falls back to parent folder for unnamed or index/index.ts/js/mjs entries when metadata/source is available.
 * - Avoids changing package names.
 */
export function getResourceDisplayName(resource: PiResourceEntry): string {
  if (resource.kind === 'package') {
    return resource.name?.trim() || deriveResourceName('package', resource.source);
  }

  const declared = resource.name?.trim();
  if (declared && !INDEX_ENTRY_NAMES.has(declared.toLowerCase())) {
    return declared;
  }

  // 1. Check extensionDir
  if (resource.extensionDir) {
    const norm = resource.extensionDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = norm.split('/').filter((p) => p !== '' && p !== '.');
    const folder = parts[parts.length - 1];
    if (folder && folder !== 'extensions' && !INDEX_ENTRY_NAMES.has(folder.toLowerCase())) {
      return folder;
    }
  }

  // 2. Check extensionPath
  if (resource.extensionPath) {
    const norm = resource.extensionPath.replace(/\\/g, '/');
    const parts = norm.split('/').filter((p) => p !== '' && p !== '.');
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      if (INDEX_ENTRY_NAMES.has(last.toLowerCase())) {
        const parent = parts[parts.length - 2];
        if (parent && parent !== 'extensions' && parent !== '.') {
          return parent;
        }
      }
    }
  }

  // 3. Check source
  if (resource.source) {
    const derived = deriveResourceName('extension', resource.source);
    if (derived && !INDEX_ENTRY_NAMES.has(derived.toLowerCase())) {
      return derived;
    }
  }

  return (
    declared ||
    (resource.source ? deriveResourceName('extension', resource.source) : 'Unnamed extension')
  );
}

/**
 * Returns hover title path for an extension or resource:
 * Displays extensionDir (fallback extensionPath, then source, but NEVER configPath).
 */
export function getExtensionHoverPath(resource: PiResourceEntry): string {
  if (resource.kind === 'extension') {
    return resource.extensionDir || resource.extensionPath || resource.source;
  }
  return resource.source;
}

/**
 * Minimal syntax validation for extension and package sources.
 */
export function validateResourceSource(
  kind: PiResourceKind,
  source: string
): { valid: boolean; error?: string } {
  const trimmed = source.trim();
  if (!trimmed) {
    return { valid: false, error: `${kind === 'extension' ? 'Extension' : 'Package'} source must not be empty` };
  }
  if (trimmed.includes('\0')) {
    return { valid: false, error: 'Source contains invalid characters' };
  }

  if (kind === 'extension') {
    const base = trimmed.startsWith('!') || trimmed.startsWith('+') ? trimmed.slice(1).trim() : trimmed;
    if (!base) {
      return { valid: false, error: 'Extension source must not be empty' };
    }
    return { valid: true };
  }

  // Package syntax validation
  const isNpm = trimmed.startsWith('npm:');
  const isGit =
    trimmed.startsWith('git:') ||
    trimmed.startsWith('git@') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('ssh://');
  const isLocal =
    trimmed.startsWith('./') ||
    trimmed.startsWith('.\\') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('..\\') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    trimmed.startsWith('~/') ||
    /^[a-zA-Z]:[/\\]/.test(trimmed);
  const isNpmShorthand = /^[@a-zA-Z0-9_.~/-]+$/.test(trimmed);

  if (!isNpm && !isGit && !isLocal && !isNpmShorthand) {
    return {
      valid: false,
      error: `Invalid package source '${trimmed}'. Expected npm, git, https/ssh, or local path.`,
    };
  }

  return { valid: true };
}

/**
 * Extracts the canonical identity of a package according to Pi specification:
 * - npm: package name without version/tag (e.g. "npm:@scope/pkg@1.2.3" -> "@scope/pkg", "npm:pkg" -> "pkg")
 * - git / http(s) / ssh: repository URL without ref or trailing .git
 * - local / other: normalized path string with forward slashes
 */
export function extractPackageIdentity(source: string): string {
  const trimmed = source.trim();
  const s = trimmed.startsWith('npm:') ? trimmed.slice(4) : trimmed;

  if (s.startsWith('git:')) {
    const gitS = s.slice(4);
    const cleanGit = gitS.split('@')[0] || gitS;
    return cleanGit.replace(/\.git$/, '');
  }

  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ssh://')) {
    const noProto = s.split('://')[1] || s;
    const noRef = noProto.split('@')[0] || noProto;
    return noRef.replace(/\.git$/, '');
  }

  if (s.startsWith('@')) {
    const secondAt = s.indexOf('@', 1);
    if (secondAt > 0) {
      return s.slice(0, secondAt);
    }
    return s;
  } else {
    const atIdx = s.indexOf('@');
    if (atIdx > 0) {
      return s.slice(0, atIdx);
    }
  }

  return s.replace(/\\/g, '/');
}

/**
 * Determines whether two package source strings represent the exact same package identity.
 */
export function packageIdentitiesMatch(sourceA: string, sourceB: string): boolean {
  const a = sourceA.trim();
  const b = sourceB.trim();
  if (a === b) {
    return true;
  }
  const idA = extractPackageIdentity(a);
  const idB = extractPackageIdentity(b);
  return idA !== '' && idA === idB;
}

function normalizeExtForMatching(source: string): string {
  let s = source.trim();
  while (s.startsWith('!') || s.startsWith('+') || s.startsWith('-')) {
    s = s.slice(1).trim();
  }
  const norm = s.replace(/\\/g, '/');
  let cleaned = norm.startsWith('./') ? norm.slice(2) : norm;
  if (cleaned.startsWith('extensions/')) {
    cleaned = cleaned.slice('extensions/'.length);
  }
  return cleaned.replace(/\/+$/, '');
}

/**
 * Determines whether two extension source strings represent the same target extension file/path.
 */
export function extensionSourcesMatch(sourceA: string, sourceB: string): boolean {
  const a = normalizeExtForMatching(sourceA);
  const b = normalizeExtForMatching(sourceB);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (
    a === `${b}/index.ts` ||
    a === `${b}/index.js` ||
    a === `${b}/index.mjs`
  ) {
    return true;
  }
  if (
    b === `${a}/index.ts` ||
    b === `${a}/index.js` ||
    b === `${a}/index.mjs`
  ) {
    return true;
  }
  return false;
}

/**
 * Determines whether two resource source strings refer to the same resource for a given kind.
 */
export function resourceIdentitiesMatch(
  kind: PiResourceKind,
  sourceA: string,
  sourceB: string
): boolean {
  if (kind.toLowerCase() === 'package') {
    return packageIdentitiesMatch(sourceA, sourceB);
  }
  return extensionSourcesMatch(sourceA, sourceB);
}

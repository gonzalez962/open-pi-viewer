import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
const SRC_TAURI_DIR = path.join(REPO_ROOT, 'src-tauri', 'src');

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

interface ImportMatch {
  file: string;
  line: number;
  importPath: string;
  statement: string;
}

function collectFiles(dir: string, extensions: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractImports(filePath: string): ImportMatch[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const imports: ImportMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match static import ... from '...' or dynamic import('...') or import '...'
    const staticFromMatch = line.match(/\bfrom\s+['"]([^'"]+)['"]/);
    if (staticFromMatch) {
      imports.push({
        file: filePath,
        line: i + 1,
        importPath: staticFromMatch[1],
        statement: line.trim(),
      });
      continue;
    }
    const dynamicMatch = line.match(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (dynamicMatch) {
      imports.push({
        file: filePath,
        line: i + 1,
        importPath: dynamicMatch[1],
        statement: line.trim(),
      });
      continue;
    }
    const sideEffectMatch = line.match(/^\s*import\s+['"]([^'"]+)['"]/);
    if (sideEffectMatch) {
      imports.push({
        file: filePath,
        line: i + 1,
        importPath: sideEffectMatch[1],
        statement: line.trim(),
      });
    }
  }

  return imports;
}

test('architecture: src/ has zero root files and contains only designated layers', () => {
  const rootEntries = fs.readdirSync(SRC_DIR, { withFileTypes: true });
  const files = rootEntries.filter((e) => !e.isDirectory()).map((e) => e.name);
  assert.deepEqual(
    files,
    [],
    `src/ root must contain 0 flat files, but found: ${files.join(', ')}`
  );

  const expectedLayers = ['app', 'core', 'features', 'infra', 'shared'];
  const actualDirs = rootEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.deepEqual(actualDirs, expectedLayers.sort());
});

test('architecture: src/ contains zero test files (*.test.ts, *.test.tsx)', () => {
  const allSrcFiles = collectFiles(SRC_DIR, ['.ts', '.tsx']);
  const testFiles = allSrcFiles.filter(
    (f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx')
  );
  assert.deepEqual(
    testFiles,
    [],
    `Tests must reside in tests/, but found in src/: ${testFiles.join(', ')}`
  );
});

test('architecture: core/ layer imports only core/ (zero React, zero Tauri, zero outer layers)', () => {
  const coreDir = path.join(SRC_DIR, 'core');
  const coreFiles = collectFiles(coreDir, CODE_EXTENSIONS);
  const violations: string[] = [];

  for (const file of coreFiles) {
    const relFile = path.relative(REPO_ROOT, file);
    const imports = extractImports(file);
    for (const imp of imports) {
      const p = imp.importPath;
      if (p === 'react' || p.startsWith('react/') || p === 'react-dom') {
        violations.push(`${relFile}:${imp.line} imports React: "${p}"`);
      }
      if (p.startsWith('@tauri-apps/')) {
        violations.push(`${relFile}:${imp.line} imports Tauri: "${p}"`);
      }
      if (
        p.startsWith('@shared/') ||
        p.startsWith('@infra/') ||
        p.startsWith('@features/') ||
        p.startsWith('@app/')
      ) {
        violations.push(`${relFile}:${imp.line} imports outer layer: "${p}"`);
      }
      if (p.startsWith('../') && !path.resolve(path.dirname(file), p).startsWith(coreDir)) {
        violations.push(`${relFile}:${imp.line} relative import escapes core/: "${p}"`);
      }
    }
  }

  assert.deepEqual(violations, [], `Core layer violations:\n${violations.join('\n')}`);
});

test('architecture: shared/ layer does not import outer layers, React, or Tauri', () => {
  const sharedDir = path.join(SRC_DIR, 'shared');
  const sharedFiles = collectFiles(sharedDir, CODE_EXTENSIONS);
  const violations: string[] = [];

  for (const file of sharedFiles) {
    const relFile = path.relative(REPO_ROOT, file);
    const imports = extractImports(file);
    for (const imp of imports) {
      const p = imp.importPath;
      if (p === 'react' || p.startsWith('react/') || p === 'react-dom') {
        violations.push(`${relFile}:${imp.line} imports React: "${p}"`);
      }
      if (p.startsWith('@tauri-apps/')) {
        violations.push(`${relFile}:${imp.line} imports Tauri: "${p}"`);
      }
      if (
        p.startsWith('@infra/') ||
        p.startsWith('@features/') ||
        p.startsWith('@app/')
      ) {
        violations.push(`${relFile}:${imp.line} imports outer layer: "${p}"`);
      }
      if (p.startsWith('../') && !path.resolve(path.dirname(file), p).startsWith(sharedDir)) {
        violations.push(`${relFile}:${imp.line} relative import escapes shared/: "${p}"`);
      }
    }
  }

  assert.deepEqual(violations, [], `Shared layer violations:\n${violations.join('\n')}`);
});

test('architecture: infra/ layer does not import features, app, or React', () => {
  const infraDir = path.join(SRC_DIR, 'infra');
  const infraFiles = collectFiles(infraDir, CODE_EXTENSIONS);
  const violations: string[] = [];

  for (const file of infraFiles) {
    const relFile = path.relative(REPO_ROOT, file);
    const imports = extractImports(file);
    for (const imp of imports) {
      const p = imp.importPath;
      if (p === 'react' || p.startsWith('react/') || p === 'react-dom') {
        violations.push(`${relFile}:${imp.line} imports React: "${p}"`);
      }
      if (p.startsWith('@features/') || p.startsWith('@app/')) {
        violations.push(`${relFile}:${imp.line} imports outer layer: "${p}"`);
      }
      if (p.startsWith('../') && !path.resolve(path.dirname(file), p).startsWith(infraDir)) {
        violations.push(`${relFile}:${imp.line} relative import escapes infra/: "${p}"`);
      }
    }
  }

  assert.deepEqual(violations, [], `Infra layer violations:\n${violations.join('\n')}`);
});

test('architecture: features/ layers never import other features or app', () => {
  const featuresDir = path.join(SRC_DIR, 'features');
  const featureNames = fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const violations: string[] = [];

  for (const feature of featureNames) {
    const featurePath = path.join(featuresDir, feature);
    const files = collectFiles(featurePath, CODE_EXTENSIONS);

    for (const file of files) {
      const relFile = path.relative(REPO_ROOT, file);
      const imports = extractImports(file);

      for (const imp of imports) {
        const p = imp.importPath;
        if (p.startsWith('@app/')) {
          violations.push(`${relFile}:${imp.line} imports app/: "${p}"`);
        }
        if (p.startsWith('@features/')) {
          const targetFeature = p.slice('@features/'.length).split('/')[0];
          if (targetFeature !== feature) {
            violations.push(
              `${relFile}:${imp.line} cross-feature import from "${feature}" to "${targetFeature}": "${p}"`
            );
          }
        }
        if (p.startsWith('../')) {
          const resolved = path.resolve(path.dirname(file), p);
          if (!resolved.startsWith(featurePath)) {
            violations.push(
              `${relFile}:${imp.line} relative import escapes feature "${feature}": "${p}"`
            );
          }
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Feature layer boundary violations:\n${violations.join('\n')}`
  );
});

test('architecture: retired @/* alias and deep relative ../../ imports are absent', () => {
  const allTsFiles = [
    ...collectFiles(SRC_DIR, CODE_EXTENSIONS),
    ...collectFiles(TESTS_DIR, CODE_EXTENSIONS),
  ];
  const violations: string[] = [];

  for (const file of allTsFiles) {
    const relFile = path.relative(REPO_ROOT, file);
    const imports = extractImports(file);

    for (const imp of imports) {
      const p = imp.importPath;
      if (p === '@' || p.startsWith('@/')) {
        violations.push(`${relFile}:${imp.line} uses retired @/ alias: "${p}"`);
      }
      if (p.includes('../../')) {
        violations.push(`${relFile}:${imp.line} uses deep relative import: "${p}"`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Alias and relative path violations:\n${violations.join('\n')}`
  );
});

test('architecture: backend commands monolith eliminated into modular domain tree', () => {
  const monolithPath = path.join(SRC_TAURI_DIR, 'commands.rs');
  assert.equal(
    fs.existsSync(monolithPath),
    false,
    `commands.rs monolith must not exist`
  );

  const commandsDir = path.join(SRC_TAURI_DIR, 'commands');
  assert.equal(
    fs.existsSync(commandsDir),
    true,
    `src-tauri/src/commands/ directory must exist`
  );

  const expectedSubmodules = [
    'config_files.rs',
    'connection.rs',
    'conversation_export.rs',
    'discovery.rs',
    'external.rs',
    'mod.rs',
    'models.rs',
    'oauth.rs',
    'sessions.rs',
    'workspace.rs',
  ];

  const actualEntries = fs.readdirSync(commandsDir).sort();
  assert.deepEqual(actualEntries, expectedSubmodules);
});

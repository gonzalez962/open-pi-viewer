import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FileViewerModal } from '@features/workspace/FileViewerModal';
import type { WorkspaceFileContent } from '@core/types/workspace';

const WORKSPACE_CSS_PATH = join(process.cwd(), 'src/features/workspace/workspace.css');

function loadWorkspaceCss(): string {
  return readFileSync(WORKSPACE_CSS_PATH, 'utf8');
}

/**
 * Extracts a CSS rule block by selector within a media query block.
 */
function extractMediaRule(css: string, mediaQuery: string, selector: string): string {
  const mediaIdx = css.indexOf(mediaQuery);
  assert.ok(mediaIdx !== -1, `Media query "${mediaQuery}" not found in CSS`);

  // Find the opening brace of media query
  const openBraceIdx = css.indexOf('{', mediaIdx);
  assert.ok(openBraceIdx !== -1, `Opening brace for media query not found`);

  // Find matching closing brace for media query
  let depth = 1;
  let closeBraceIdx = openBraceIdx + 1;
  while (depth > 0 && closeBraceIdx < css.length) {
    if (css[closeBraceIdx] === '{') depth++;
    else if (css[closeBraceIdx] === '}') depth--;
    closeBraceIdx++;
  }

  const mediaBlock = css.slice(openBraceIdx + 1, closeBraceIdx - 1);
  const selectorIdx = mediaBlock.indexOf(selector);
  assert.ok(selectorIdx !== -1, `Selector "${selector}" not found in media query`);

  const ruleOpenIdx = mediaBlock.indexOf('{', selectorIdx);
  const ruleCloseIdx = mediaBlock.indexOf('}', ruleOpenIdx);
  assert.ok(ruleOpenIdx !== -1 && ruleCloseIdx !== -1, `Rule block for "${selector}" not found`);

  return mediaBlock.slice(ruleOpenIdx + 1, ruleCloseIdx);
}

/**
 * Extracts the desktop (outside media query) CSS rule block by selector.
 */
function extractDesktopRule(css: string, selector: string): string {
  // Take content before the mobile media query
  const mediaIdx = css.indexOf('@media (max-width: 768px)');
  const beforeMedia = mediaIdx !== -1 ? css.slice(0, mediaIdx) : css;
  const selectorIdx = beforeMedia.indexOf(selector);
  assert.ok(selectorIdx !== -1, `Selector "${selector}" not found in desktop CSS`);

  const ruleOpenIdx = beforeMedia.indexOf('{', selectorIdx);
  const ruleCloseIdx = beforeMedia.indexOf('}', ruleOpenIdx);
  return beforeMedia.slice(ruleOpenIdx + 1, ruleCloseIdx);
}

test('file viewer: all modal buttons share sizing and have comfortable spacing', () => {
  const css = loadWorkspaceCss();
  const shared = extractDesktopRule(css, '.file-viewer-container button {');
  assert.match(shared, /height:\s*30px;/);
  assert.match(shared, /box-sizing:\s*border-box;/);
  assert.match(shared, /font-size:\s*12px;/);
  assert.match(shared, /line-height:\s*1;/);
  assert.match(shared, /border-radius:\s*var\(--radius-sm\);/);
  assert.match(extractDesktopRule(css, '.file-viewer-actions {'), /gap:\s*10px;/);
  assert.match(extractDesktopRule(css, '.file-viewer-actions {'), /flex-wrap:\s*wrap;/);
  const header = extractDesktopRule(css, '.file-viewer-header {');
  assert.match(header, /flex-wrap:\s*wrap;/);
  assert.match(header, /gap:\s*12px;/);
  assert.doesNotMatch(css, /\.btn-file-close\s*\{[^}]*min-(?:width|height):\s*32px;/);
  assert.match(extractDesktopRule(css, '.file-viewer-container .btn-file-editor:focus-visible'), /outline:\s*2px solid var\(--editor-action-fg\)/);
  assert.match(extractDesktopRule(css, '.file-viewer-tabs {'), /gap:\s*6px;/);
  const icons = extractDesktopRule(css, '.file-viewer-container :is(.btn-file-toggle-wrap, .btn-file-close) {');
  assert.match(icons, /width:\s*30px;/);
  assert.match(icons, /padding:\s*0;/);
});

test('file editor: action buttons share aligned dimensions and semantic colors', () => {
  const css = loadWorkspaceCss();
  const button = extractDesktopRule(css, '.file-viewer-container button {');
  assert.match(button, /display:\s*inline-flex;/);
  assert.match(button, /align-items:\s*center;/);
  assert.match(button, /justify-content:\s*center;/);
  assert.match(button, /height:\s*30px;/);
  assert.match(button, /box-sizing:\s*border-box;/);
  assert.match(button, /line-height:\s*1;/);
  for (const [action, token] of [['edit', '--accent-primary'], ['save', '--status-green'], ['cancel', '--status-red']]) {
    const variant = extractDesktopRule(css, `.btn-file-editor-${action} {`);
    assert.ok(variant.includes(`var(${token})`), `${action} uses its semantic theme color`);
  }
  assert.match(extractDesktopRule(css, '.file-viewer-container .btn-file-editor:focus-visible'), /outline:/);
  assert.match(extractDesktopRule(css, '.btn-file-editor:disabled'), /cursor:\s*not-allowed;/);
  const source = readFileSync(join(process.cwd(), 'src/features/workspace/FileViewerModal.tsx'), 'utf8');
  for (const action of ['edit', 'save', 'cancel']) {
    assert.ok(source.includes(`className="btn-file-editor btn-file-editor-${action}"`));
  }
});

test('mobile file viewer: preserves desktop overlay and container layout', () => {
  const css = loadWorkspaceCss();
  const desktopOverlay = extractDesktopRule(css, '.file-viewer-overlay');
  const desktopContainer = extractDesktopRule(css, '.file-viewer-container');

  // Desktop overlay must be vertically centered with generous padding
  assert.match(desktopOverlay, /align-items:\s*center;/);
  assert.match(desktopOverlay, /justify-content:\s*center;/);
  assert.match(desktopOverlay, /padding:\s*24px;/);

  // Desktop container has standard desktop bounds
  assert.match(desktopContainer, /height:\s*82vh;/);
  assert.match(desktopContainer, /max-height:\s*720px;/);
  assert.match(desktopContainer, /max-width:\s*880px;/);
});

test('mobile file viewer: overlay is top-aligned and includes safe-area padding', () => {
  const css = loadWorkspaceCss();
  const mobileOverlay = extractMediaRule(css, '@media (max-width: 768px)', '.file-viewer-overlay');

  // Top-aligned: must NOT inherit desktop align-items: center (which clips headers on mobile)
  assert.match(
    mobileOverlay,
    /align-items:\s*flex-start;/,
    'Mobile overlay must use align-items: flex-start to prevent vertical centering clipping'
  );

  // Fallback base padding
  assert.match(mobileOverlay, /padding:\s*8px;/, 'Must include 8px base fallback padding');

  // Safe-area aware padding for mobile notches and home indicators
  assert.match(
    mobileOverlay,
    /padding-top:\s*max\(\s*8px\s*,\s*env\(\s*safe-area-inset-top\s*,\s*0px\s*\)\s*\);/,
    'Must include safe-area-inset-top aware padding-top'
  );
  assert.match(
    mobileOverlay,
    /padding-bottom:\s*max\(\s*8px\s*,\s*env\(\s*safe-area-inset-bottom\s*,\s*0px\s*\)\s*\);/,
    'Must include safe-area-inset-bottom aware padding-bottom'
  );
  assert.match(
    mobileOverlay,
    /padding-left:\s*max\(\s*8px\s*,\s*env\(\s*safe-area-inset-left\s*,\s*0px\s*\)\s*\);/,
    'Must include safe-area-inset-left aware padding-left'
  );
  assert.match(
    mobileOverlay,
    /padding-right:\s*max\(\s*8px\s*,\s*env\(\s*safe-area-inset-right\s*,\s*0px\s*\)\s*\);/,
    'Must include safe-area-inset-right aware padding-right'
  );
});

test('mobile file viewer: container ordering places 100vh fallback before 100dvh dynamic viewport', () => {
  const css = loadWorkspaceCss();
  const mobileContainer = extractMediaRule(css, '@media (max-width: 768px)', '.file-viewer-container');

  const vhMatch = mobileContainer.search(/height:\s*calc\([^)]*100vh[^)]*\);/);
  const dvhMatch = mobileContainer.search(/height:\s*calc\([^)]*100dvh[^)]*\);/);

  assert.ok(vhMatch !== -1, 'Must include 100vh fallback height');
  assert.ok(dvhMatch !== -1, 'Must include 100dvh dynamic viewport height');

  // Crucial bug fix: 100vh must come BEFORE 100dvh so later 100vh does not override 100dvh
  assert.ok(
    vhMatch < dvhMatch,
    `Fallback 100vh (index ${vhMatch}) must appear BEFORE dynamic 100dvh (index ${dvhMatch})`
  );
});

test('mobile file viewer: container height and max-height include safe-area aware dynamic bounds', () => {
  const css = loadWorkspaceCss();
  const mobileContainer = extractMediaRule(css, '@media (max-width: 768px)', '.file-viewer-container');

  // Must include safe-area aware height subtraction
  assert.match(
    mobileContainer,
    /height:\s*calc\(\s*100dvh\s*-\s*max\(\s*8px\s*,\s*env\(\s*safe-area-inset-top\s*,\s*0px\s*\)\s*\)\s*-\s*max\(\s*8px\s*,\s*env\(\s*safe-area-inset-bottom\s*,\s*0px\s*\)\s*\)\s*\);/,
    'Container height must account for safe-area-inset-top and safe-area-inset-bottom'
  );

  // Must also bound max-height safely
  assert.match(
    mobileContainer,
    /max-height:\s*calc\(\s*100dvh\s*-\s*max\(\s*8px\s*,\s*env\(\s*safe-area-inset-top\s*,\s*0px\s*\)\s*\)\s*-\s*max\(\s*8px\s*,\s*env\(\s*safe-area-inset-bottom\s*,\s*0px\s*\)\s*\)\s*\);/,
    'Container max-height must account for safe-area-inset-top and safe-area-inset-bottom'
  );
});

test('mobile file viewer: mobile header prevents shrinking to protect header and close button visibility', () => {
  const css = loadWorkspaceCss();
  const mobileHeader = extractMediaRule(css, '@media (max-width: 768px)', '.file-viewer-header');

  assert.match(
    mobileHeader,
    /flex-shrink:\s*0;/,
    'Mobile header must have flex-shrink: 0 to prevent header and controls from being clipped'
  );
});

test('mobile file viewer: FileViewerModal renders accessible structure with top header and close control', () => {
  const sampleTextFile: WorkspaceFileContent = {
    name: 'sample.ts',
    relativePath: 'src/sample.ts',
    content: 'export const hello = "world";',
    size: 29,
    isBinary: false,
    extension: 'ts',
  };

  const html = renderToStaticMarkup(
    React.createElement(FileViewerModal, {
      file: sampleTextFile,
      workingDirectory: '/test/workspace',
      onClose: () => {},
      locale: 'en',
    })
  );

  // Check required class names
  assert.ok(html.includes('class="file-viewer-overlay"'), 'Renders file-viewer-overlay');
  assert.ok(html.includes('class="file-viewer-container"'), 'Renders file-viewer-container');
  assert.ok(html.includes('class="file-viewer-header"'), 'Renders file-viewer-header');
  assert.ok(html.includes('class="file-viewer-info"'), 'Renders file-viewer-info');
  assert.ok(html.includes('class="file-viewer-actions"'), 'Renders file-viewer-actions');
  assert.ok(html.includes('class="btn-file-close"'), 'Renders btn-file-close');

  // Verify close button accessibility
  assert.match(html, /<button[^>]*class="[^"]*btn-file-close[^"]*"[^>]*title="Close"[^>]*>/);
  assert.match(html, /<button[^>]*class="[^"]*btn-file-close[^"]*"[^>]*aria-label="Close"[^>]*>/);
});

test('mobile file viewer: FileViewerModal renders binary file without tabs but keeps header and close control intact', () => {
  const sampleBinaryFile: WorkspaceFileContent = {
    name: 'binary.bin',
    relativePath: 'bin/binary.bin',
    content: '',
    size: 512,
    isBinary: true,
    extension: 'bin',
  };

  const html = renderToStaticMarkup(
    React.createElement(FileViewerModal, {
      file: sampleBinaryFile,
      workingDirectory: '/test/workspace',
      onClose: () => {},
      locale: 'en',
    })
  );

  assert.ok(html.includes('class="file-viewer-header"'), 'Renders file-viewer-header for binary file');
  assert.ok(html.includes('class="btn-file-close"'), 'Renders btn-file-close for binary file');
  assert.ok(!html.includes('class="file-viewer-tabs"'), 'Binary file does not render tabs');
});

test('mobile file viewer: triangulation - negative checks and balanced math expressions', () => {
  const css = loadWorkspaceCss();
  const mobileOverlay = extractMediaRule(css, '@media (max-width: 768px)', '.file-viewer-overlay');
  const mobileContainer = extractMediaRule(css, '@media (max-width: 768px)', '.file-viewer-container');

  // Negative check: mobile overlay must NOT specify or fall back to align-items: center
  assert.doesNotMatch(
    mobileOverlay,
    /align-items:\s*center;/,
    'Mobile overlay must explicitly NOT be centered'
  );

  // Negative check: container height must NOT terminate with 100vh overriding 100dvh
  const heightLines = mobileContainer
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('height:'));

  assert.ok(heightLines.length >= 2, 'Should have multiple height declarations for fallback cascade');
  const lastHeight = heightLines[heightLines.length - 1];
  assert.ok(
    !lastHeight.includes('100vh') || lastHeight.includes('100dvh'),
    `Final height rule must be dynamic viewport (100dvh), not static 100vh: ${lastHeight}`
  );

  // Math expression syntax validation: all parentheses must be strictly balanced
  for (const block of [mobileOverlay, mobileContainer]) {
    let openCount = 0;
    for (const char of block) {
      if (char === '(') openCount++;
      if (char === ')') openCount--;
      assert.ok(openCount >= 0, 'Found unmatched closing parenthesis in CSS rule');
    }
    assert.strictEqual(openCount, 0, 'Found unclosed opening parenthesis in CSS rule');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PromptControls, type PromptControlsProps } from '@features/chat/PromptControls';
import type { PiResourceEntry } from '@core/types/extensions';

function renderControls(props: Partial<PromptControlsProps> = {}): string {
  const defaultProps: PromptControlsProps = {
    modelInfo: null,
    availableModels: [],
    isChangingModel: false,
    thinkingLevel: null,
    availableThinkingLevels: [],
    sessionStats: null,
    isConnected: true,
    isBusy: false,
    onSelectModel: async () => {},
    onSelectThinkingLevel: async () => {},
    t: (key: any) => String(key),
    defaultExtPopoverOpen: true,
    ...props,
  };
  return renderToStaticMarkup(React.createElement(PromptControls, defaultProps));
}

test('PromptControls popover: displays extensionDir on hover title for extensions', () => {
  const extWithDir: PiResourceEntry = {
    id: 'global:extension:./plugins/git-tools/index.ts',
    name: 'git-tools',
    kind: 'extension',
    source: './plugins/git-tools/index.ts',
    scope: 'project',
    enabled: true,
    configPath: '/workspace/project/.pi/settings.json',
    extensionPath: '/workspace/project/plugins/git-tools/index.ts',
    extensionDir: '/workspace/project/plugins/git-tools',
  };

  const html = renderControls({
    piResources: [extWithDir],
    piTotalCount: 1,
    piActiveCount: 1,
  });

  // Must display extensionDir in title attribute
  assert.ok(
    html.includes('title="/workspace/project/plugins/git-tools"'),
    'Should display extensionDir in hover title'
  );
  // Must NEVER display configPath in title attribute
  assert.ok(
    !html.includes('title="/workspace/project/.pi/settings.json"'),
    'Must NEVER display configPath in hover title'
  );
});

test('PromptControls popover: falls back to extensionPath, then source, but NEVER configPath', () => {
  const extFallbackPath: PiResourceEntry = {
    id: 'global:extension:./tools/runner.ts',
    name: 'runner',
    kind: 'extension',
    source: './tools/runner.ts',
    scope: 'project',
    enabled: true,
    configPath: '/workspace/project/.pi/settings.json',
    extensionPath: '/workspace/project/tools/runner.ts',
  };

  const htmlPath = renderControls({
    piResources: [extFallbackPath],
  });
  assert.ok(
    htmlPath.includes('title="/workspace/project/tools/runner.ts"'),
    'Should fall back to extensionPath when extensionDir is absent'
  );
  assert.ok(
    !htmlPath.includes('title="/workspace/project/.pi/settings.json"'),
    'Must NEVER use configPath as hover title'
  );

  const extFallbackSource: PiResourceEntry = {
    id: 'global:extension:./simple-ext.ts',
    name: 'simple-ext',
    kind: 'extension',
    source: './simple-ext.ts',
    scope: 'project',
    enabled: true,
    configPath: '/workspace/project/.pi/settings.json',
  };

  const htmlSource = renderControls({
    piResources: [extFallbackSource],
  });
  assert.ok(
    htmlSource.includes('title="./simple-ext.ts"'),
    'Should fall back to source when extensionDir and extensionPath are absent'
  );
  assert.ok(
    !htmlSource.includes('title="/workspace/project/.pi/settings.json"'),
    'Must NEVER use configPath as hover title'
  );
});

test('PromptControls popover: name fallback for index.ts/js/mjs trio to parent folder', () => {
  const extIndexTs: PiResourceEntry = {
    id: 'global:extension:./extensions/linter/index.ts',
    name: 'index.ts',
    kind: 'extension',
    source: './extensions/linter/index.ts',
    scope: 'global',
    enabled: true,
    configPath: '~/.pi/agent/settings.json',
    extensionDir: '/home/user/.pi/extensions/linter',
  };

  const extIndexJs: PiResourceEntry = {
    id: 'global:extension:./extensions/formatter/index.js',
    name: 'index.js',
    kind: 'extension',
    source: './extensions/formatter/index.js',
    scope: 'global',
    enabled: true,
    configPath: '~/.pi/agent/settings.json',
    extensionDir: '/home/user/.pi/extensions/formatter',
  };

  const extIndexMjs: PiResourceEntry = {
    id: 'global:extension:./extensions/bundler/index.mjs',
    name: 'index.mjs',
    kind: 'extension',
    source: './extensions/bundler/index.mjs',
    scope: 'global',
    enabled: true,
    configPath: '~/.pi/agent/settings.json',
    extensionDir: '/home/user/.pi/extensions/bundler',
  };

  const html = renderControls({
    piResources: [extIndexTs, extIndexJs, extIndexMjs],
  });

  // Visible names should be folder names, not index.ts / index.js / index.mjs
  assert.ok(html.includes('linter'), 'index.ts should display parent folder name "linter"');
  assert.ok(html.includes('formatter'), 'index.js should display parent folder name "formatter"');
  assert.ok(html.includes('bundler'), 'index.mjs should display parent folder name "bundler"');
});

test('PromptControls popover: regular declared names and package names preserved unchanged', () => {
  const regularExt: PiResourceEntry = {
    id: 'global:extension:./extensions/custom-helper.ts',
    name: 'custom-helper.ts',
    kind: 'extension',
    source: './extensions/custom-helper.ts',
    scope: 'global',
    enabled: true,
    configPath: '~/.pi/agent/settings.json',
  };

  const pkg: PiResourceEntry = {
    id: 'global:package:npm:@scope/analytics@1.0.0',
    name: '@scope/analytics',
    kind: 'package',
    source: 'npm:@scope/analytics@1.0.0',
    scope: 'global',
    enabled: true,
    configPath: '~/.pi/agent/settings.json',
  };

  const html = renderControls({
    piResources: [regularExt, pkg],
  });

  assert.ok(html.includes('custom-helper.ts'), 'Regular extension name should be preserved');
  assert.ok(html.includes('@scope/analytics'), 'Package name must be preserved unchanged');
});

test('PromptControls popover: model list truncates names longer than 20 characters and provides full name in title', () => {
  const longModel = {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet (20241022)',
    provider: 'anthropic',
  };
  const shortModel = {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
  };

  const html = renderControls({
    availableModels: [longModel, shortModel],
    defaultModelPopoverOpen: true,
  });

  assert.ok(html.includes('Claude 3.5 Sonnet (2...'), 'Model name longer than 20 chars must be truncated');
  assert.ok(
    html.includes('title="Claude 3.5 Sonnet (20241022)"'),
    'Full model name must be provided in title attribute'
  );
  assert.ok(html.includes('>GPT-4o<'), 'Short model name must be displayed completely');
  assert.ok(html.includes('title="GPT-4o"'), 'Short model name also has title attribute');
});

test('PromptControls action buttons: renders send button when idle', () => {
  const htmlDisabled = renderControls({
    isBusy: false,
    canSend: false,
  });
  assert.ok(htmlDisabled.includes('prompt-action-btn btn-send'), 'Should render send button');
  assert.match(htmlDisabled, /<button[^>]*class="prompt-action-btn btn-send"[^>]*disabled/, 'Send button should be disabled when canSend is false');
  assert.ok(htmlDisabled.includes('action.send'), 'Should display localized send label');

  const htmlEnabled = renderControls({
    isBusy: false,
    canSend: true,
  });
  assert.ok(htmlEnabled.includes('prompt-action-btn btn-send'), 'Should render send button');
  assert.match(htmlEnabled, /<button[^>]*class="prompt-action-btn btn-send"[^>]*aria-disabled="false"/, 'Send button should have aria-disabled false when canSend is true');
  assert.doesNotMatch(htmlEnabled, /<button[^>]*class="prompt-action-btn btn-send"[^>]*disabled=""/, 'Send button should NOT have disabled attribute when canSend is true');
});

test('PromptControls action buttons: renders cancel button when busy, and queue button when draft exists', () => {
  const htmlBusyNoDraft = renderControls({
    isBusy: true,
    canSend: false,
  });
  assert.ok(htmlBusyNoDraft.includes('prompt-action-btn btn-cancel'), 'Should render cancel button when busy');
  assert.ok(htmlBusyNoDraft.includes('action.stop'), 'Should display stop label');
  assert.ok(!htmlBusyNoDraft.includes('action.queue'), 'Should not render queue button when no draft canSend');

  const htmlBusyWithDraft = renderControls({
    isBusy: true,
    canSend: true,
  });
  assert.ok(htmlBusyWithDraft.includes('prompt-action-btn btn-cancel'), 'Should render cancel button');
  assert.ok(htmlBusyWithDraft.includes('prompt-action-btn btn-send'), 'Should render queue button when draft canSend is true');
  assert.ok(htmlBusyWithDraft.includes('action.queue'), 'Should display queue label');
});


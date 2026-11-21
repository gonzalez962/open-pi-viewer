import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { translate } from '@shared/i18n';
import type { ModelInfo, ThinkingLevel, SessionStats } from '@core/types/models';
import type { ProfileSummary } from '@core/types/profiles';
import type { McpServerConfig } from '@core/types/mcp';
import type { PiResourceEntry } from '@core/types/extensions';
import { PromptControls, type PromptControlsProps } from '@features/chat/PromptControls';
import { PendingAttachments } from '@features/chat/components/PendingAttachments';
import type { AttachedFile } from '@features/chat/types';

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params);

const sampleModel: ModelInfo = {
  id: 'claude-3-5-sonnet-20241022',
  name: 'Claude 3.5 Sonnet',
  provider: 'anthropic',
  reasoning: true,
  input_modalities: ['image', 'text'],
};

const sampleAvailableModels: ModelInfo[] = [
  sampleModel,
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    reasoning: false,
    input_modalities: ['image', 'text'],
  },
];

const sampleStats: SessionStats = {
  tokens: {
    total: 14200,
    input: 12000,
    output: 2200,
  },
  cost: 0.042,
  contextUsage: {
    tokens: 14200,
    contextWindow: 200000,
    percent: 7.1,
  },
};

const sampleProfiles: ProfileSummary[] = [
  {
    name: 'coding',
    scope: 'project',
    agent_count: 3,
    is_active: true,
    default_model: 'claude-3-5-sonnet-20241022',
  },
];

const sampleMcpServers: McpServerConfig[] = [
  {
    name: 'sqlite',
    command: 'mcp-sqlite',
    args: [],
    enabled: true,
    disabled: false,
    scope: 'project',
    serverType: 'stdio',
    envKeys: [],
    configPath: '/mock/config.json',
  },
];

const samplePiResources: PiResourceEntry[] = [
  {
    id: 'ext-1',
    name: 'git-tools',
    kind: 'extension',
    source: '/path/to/ext',
    scope: 'project',
    enabled: true,
    configPath: '/mock/config.json',
  },
];

function createDefaultProps(overrides: Partial<PromptControlsProps> = {}): PromptControlsProps {
  return {
    modelInfo: sampleModel,
    availableModels: sampleAvailableModels,
    isChangingModel: false,
    thinkingLevel: 'medium' as ThinkingLevel,
    defaultThinkingLevel: 'medium' as ThinkingLevel,
    availableThinkingLevels: ['off', 'low', 'medium', 'high'] as ThinkingLevel[],
    sessionStats: sampleStats,
    isHighContext: false,
    isConnected: true,
    isBusy: false,
    canSend: true,
    onSend: () => {},
    onAbort: () => {},
    onSelectModel: async () => {},
    onSelectThinkingLevel: async () => {},
    profiles: sampleProfiles,
    activeProfileName: 'coding',
    effectiveScope: 'project',
    mcpServers: sampleMcpServers,
    mcpActiveCount: 1,
    mcpTotalCount: 1,
    piResources: samplePiResources,
    piActiveCount: 1,
    piTotalCount: 1,
    engramProject: 'test-project',
    supportsFiles: true,
    t,
    ...overrides,
  };
}

test('mobile-layout: desktop renders one toolbar with all controls and no disclosure', () => {
  const html = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps()));

  // Toolbar role and container
  assert.ok(html.includes('role="toolbar"'), 'Toolbar role should be present');
  assert.equal(html.match(/role="toolbar"/g)?.length, 1);
  assert.doesNotMatch(html, /prompt-options-toggle| hidden=""/);

  // Primary action button (Send)
  assert.ok(html.includes('btn-send'), 'Send action button must be present');
  assert.ok(!html.includes('btn-cancel'), 'Cancel button should not be present when idle');

  // Model selector control
  assert.ok(html.includes('model-btn'), 'Model selector button must be present');
  assert.ok(html.includes('model-name'), 'Model name label must be present');
  assert.ok(html.includes('Claude 3.5 Sonnet'), 'Active model name must be displayed');

  // Secondary controls - all must be accessible, none hidden or omitted
  assert.ok(html.includes('file-attach-btn'), 'File attachment button must be present');
  assert.ok(html.includes('profile-btn'), 'Profile button must be present');
  assert.ok(html.includes('thinking-btn'), 'Thinking level button must be present');
  assert.ok(html.includes('stats-btn'), 'Stats context meter button must be present');
  assert.ok(html.includes('mcp-btn'), 'MCP button must be present');
  assert.ok(html.includes('ext-btn'), 'Extension button must be present');
  assert.ok(html.includes('engram-project-btn'), 'Engram project button must be present');
});

test('mobile-layout: collapsed options hide selectors and Stop but leave Send, Queue and the attachment count visible', () => {
  const mobileOptions = { open: false, onToggle: () => {}, relatedIds: ['pending-files'] };
  const attachedFiles: AttachedFile[] = [{ id: 'file', name: 'notes.txt', type: 'text', size: 4, mimeType: 'text/plain', content: 'text' }];
  for (const isBusy of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(React.Fragment, null,
      React.createElement(PendingAttachments, {
        files: attachedFiles, onRemove: () => {}, draftKey: 'draft', id: 'pending-files', hidden: true, t,
      }),
      React.createElement(PromptControls, createDefaultProps({ isBusy, attachedFiles, mobileOptions })),
    ));
    const toggle = html.match(/<button[^>]*class="[^"]*prompt-options-toggle"[^>]*>More options<\/button>/)?.[0];
    assert.ok(toggle, 'renders a single localized disclosure button');
    assert.equal(html.match(/prompt-options-toggle/g)?.length, 1);
    assert.match(toggle, /type="button"/);
    assert.match(toggle, /aria-expanded="false"/);
    const controlled = toggle.match(/aria-controls="([^"]+)"/)?.[1].split(' ') ?? [];
    const selectors = html.match(/<div[^>]*class="prompt-secondary-controls"[^>]*>/)?.[0];
    assert.ok(selectors);
    assert.ok(controlled.includes(selectors.match(/id="([^"]+)"/)![1]));
    assert.match(selectors, /hidden=""/);
    assert.ok(controlled.includes('pending-files'));
    assert.match(html, /<div id="pending-files" class="prompt-attachments-list" hidden="">[\s\S]*?btn-remove-attachment/);
    const send = html.match(/<button[^>]*class="prompt-action-btn btn-send"[^>]*>[^<]+<\/button>/)?.[0];
    assert.ok(send);
    assert.match(send, /type="submit"/);
    assert.ok(send.includes(t(isBusy ? 'action.queue' : 'action.send')));
    assert.doesNotMatch(send, /hidden/);
    assert.ok(html.indexOf(send) < html.indexOf(selectors));
    const count = html.match(/<span[^>]*role="status"[^>]*>Attachments \(1\)<\/span>/)?.[0];
    assert.ok(count && html.indexOf(count) < html.indexOf(selectors));
    if (isBusy) {
      const stop = html.match(/<button[^>]*class="prompt-action-btn btn-cancel"[^>]*>/)?.[0];
      assert.ok(stop);
      assert.match(stop, /hidden=""/);
      assert.ok(controlled.includes(stop.match(/id="([^"]+)"/)![1]));
    }
  }
});

test('mobile-layout: one context indicator stays beside More options when collapsed or expanded', () => {
  for (const open of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps({
      mobileOptions: { open, onToggle: () => {}, relatedIds: [] },
    })));
    assert.equal(html.match(/\bstats-btn\b/g)?.length, 1);
    assert.match(html, />More options<\/button><div class="prompt-control-wrapper stats-control-wrapper"><button[^>]*\bstats-btn\b[^>]*aria-expanded="false"[^>]*aria-haspopup="dialog"/);
    const selectorsStart = html.indexOf('class="prompt-secondary-controls"');
    assert.ok(selectorsStart > html.indexOf('stats-btn'));
    for (const control of ['file-attach-btn', 'profile-btn', 'model-btn', 'thinking-btn', 'mcp-btn', 'ext-btn', 'engram-project-btn']) {
      assert.ok(html.indexOf(control) > selectorsStart, `${control} stays with the disclosed selectors`);
    }
  }
});

test('mobile-layout: desktop keeps one context indicator between Thinking and MCP', () => {
  const html = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps()));
  assert.equal(html.match(/\bstats-btn\b/g)?.length, 1);
  assert.match(html, /class="prompt-secondary-controls"[\s\S]*?thinking-btn[\s\S]*?stats-btn[\s\S]*?mcp-btn/);
});

test('mobile-layout: only the prompt status hint is visually hidden at the mobile breakpoint', () => {
  const app = readFileSync('src/app/App.tsx', 'utf8');
  const css = readFileSync('src/features/chat/chat.css', 'utf8');
  assert.match(app, /<span id="prompt-status-hint"/);
  assert.match(app, /aria-describedby="prompt-status-hint"/);
  assert.equal(css.match(/#prompt-status-hint\b/g)?.length, 1);
  assert.match(css, /@media \(max-width: 768px\)\s*\{(?:(?!@media)[\s\S])*?#prompt-status-hint\s*\{\s*display:\s*none;\s*\}/);
});

test('mobile-layout: the inline context percentage is hidden only at the mobile breakpoint', () => {
  const html = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps()));
  const css = readFileSync('src/features/chat/chat.css', 'utf8');
  assert.match(html, /<span class="stats-percent">\(7\.10%\)<\/span>/);
  const mobileCss = css.match(/^@media \(max-width: 768px\) \{([\s\S]*?)^\}/m)?.[1] ?? '';
  assert.ok(/\.stats-btn \.stats-percent\s*\{\s*display:\s*none;\s*\}/.test(mobileCss),
    'only the inline percentage should be hidden inside the mobile media block');
  assert.equal(css.match(/\.stats-btn \.stats-percent\b/g)?.length, 1);
});

test('mobile-layout: expanded options expose secondary controls and retain desktop Stop/Queue order', () => {
  const mobileOptions = { open: true, onToggle: () => {}, relatedIds: [] };
  const html = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps({
    isBusy: true,
    mobileOptions,
    t: (key, params) => translate('es', key, params),
  })));
  assert.match(html, /<button[^>]*prompt-options-toggle[^>]*aria-expanded="true"[^>]*>Más opciones<\/button>/);
  assert.doesNotMatch(html, / hidden=""/);
  const desktop = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps({ isBusy: true })));
  assert.ok(desktop.indexOf('btn-cancel') < desktop.indexOf('btn-send'));
  assert.ok(desktop.indexOf('btn-send') < desktop.indexOf('profile-btn'));
});

test('mobile-layout: recording can keep the disclosure expanded without disabling Queue', () => {
  const html = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps({
    isBusy: true,
    mobileOptions: { open: true, lockedOpen: true, onToggle: () => {}, relatedIds: ['prompt-mic-options'] },
  })));
  const toggle = html.match(/<button[^>]*prompt-options-toggle[^>]*>/)?.[0];
  assert.ok(toggle);
  assert.match(toggle, /aria-expanded="true"/);
  assert.match(toggle, /aria-disabled="true"/);
  assert.match(toggle, /aria-controls="[^"]*prompt-mic-options"/);
  assert.match(html, /<button type="submit" class="prompt-action-btn btn-send" title="[^"]+">Queue<\/button>/);
});

test('mobile-layout: PromptControls preserves send and abort actions across busy and idle states', () => {
  // Idle state
  const idleHtml = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps({ isBusy: false, canSend: true })));
  assert.ok(idleHtml.includes('btn-send'), 'Idle state renders send button');
  assert.ok(!idleHtml.includes('btn-cancel'), 'Idle state does not render cancel button');

  // Busy state without queue
  const busyHtml = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps({ isBusy: true, canSend: false })));
  assert.ok(busyHtml.includes('btn-cancel'), 'Busy state renders abort/cancel button');
  assert.ok(!busyHtml.includes('btn-send'), 'Busy state without draft does not render queue button');

  // Busy state with queue capability
  const queueHtml = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps({ isBusy: true, canSend: true })));
  assert.ok(queueHtml.includes('btn-cancel'), 'Busy state renders abort/cancel button');
  assert.ok(queueHtml.includes('btn-send'), 'Busy state with canSend renders queue send button');
});

test('mobile-layout: PromptControls preserves accessible attributes on model and secondary controls', () => {
  const html = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps()));

  // Accessible attributes on buttons
  assert.ok(html.includes('aria-haspopup="listbox"'), 'Model or Profile buttons should declare listbox popup');
  assert.ok(html.includes('aria-expanded="false"'), 'Closed menus declare aria-expanded="false"');
  assert.ok(html.includes('title='), 'Buttons should have informative title attributes for accessibility');
});

test('mobile-layout: PromptControls renders semantic wrapper classes for responsive mobile reflow', () => {
  const html = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps()));

  // Semantic wrapper classes for clean CSS targeting and mobile layout reflow
  assert.ok(html.includes('model-control-wrapper'), 'model-control-wrapper should be present');
  assert.ok(html.includes('profile-control-wrapper'), 'profile-control-wrapper should be present');
  assert.ok(html.includes('thinking-control-wrapper'), 'thinking-control-wrapper should be present');
  assert.ok(html.includes('stats-control-wrapper'), 'stats-control-wrapper should be present');
  assert.ok(html.includes('mcp-control-wrapper'), 'mcp-control-wrapper should be present');
  assert.ok(html.includes('ext-control-wrapper'), 'ext-control-wrapper should be present');
  assert.ok(html.includes('file-attach-wrapper'), 'file-attach-wrapper should be present');
  assert.ok(html.includes('engram-project-wrapper'), 'engram-project-wrapper should be present');
});

test('mobile-layout: PromptControls cleanly toggles optional controls without breaking toolbar', () => {
  // Test with reasoning disabled (thinking-btn absent, others preserved)
  const nonReasoningModel: ModelInfo = { ...sampleModel, reasoning: false };
  const htmlNoReasoning = renderToStaticMarkup(
    React.createElement(PromptControls, createDefaultProps({
      modelInfo: nonReasoningModel,
      availableThinkingLevels: ['off'],
    }))
  );
  assert.ok(!htmlNoReasoning.includes('thinking-btn'), 'thinking-btn should be absent when model does not support reasoning');
  assert.ok(htmlNoReasoning.includes('model-btn'), 'model-btn must remain present');
  assert.ok(htmlNoReasoning.includes('btn-send'), 'btn-send must remain present');

  // Test with file attachments disabled (file-attach-btn absent, others preserved)
  const htmlNoFiles = renderToStaticMarkup(
    React.createElement(PromptControls, createDefaultProps({
      supportsFiles: false,
    }))
  );
  assert.ok(!htmlNoFiles.includes('file-attach-btn'), 'file-attach-btn should be absent when files not supported');
  assert.ok(htmlNoFiles.includes('model-btn'), 'model-btn must remain present');
  assert.ok(htmlNoFiles.includes('btn-send'), 'btn-send must remain present');

  // Test with no engram project (engram-project-wrapper absent, others preserved)
  const htmlNoEngram = renderToStaticMarkup(
    React.createElement(PromptControls, createDefaultProps({
      engramProject: null,
    }))
  );
  assert.ok(!htmlNoEngram.includes('engram-project-wrapper'), 'engram-project-wrapper should be absent when engramProject is null');
  assert.ok(htmlNoEngram.includes('model-btn'), 'model-btn must remain present');
  assert.ok(htmlNoEngram.includes('btn-send'), 'btn-send must remain present');
});

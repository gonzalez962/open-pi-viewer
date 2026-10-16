import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { translate } from '@shared/i18n';
import type { ModelInfo, ThinkingLevel, SessionStats } from '@core/types/models';
import type { ProfileSummary } from '@core/types/profiles';
import type { McpServerConfig } from '@core/types/mcp';
import type { PiResourceEntry } from '@core/types/extensions';
import { PromptControls, type PromptControlsProps } from '@features/chat/PromptControls';

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

test('mobile-layout: PromptControls renders all primary and secondary controls keeping all actions accessible', () => {
  const html = renderToStaticMarkup(React.createElement(PromptControls, createDefaultProps()));

  // Toolbar role and container
  assert.ok(html.includes('role="toolbar"'), 'Toolbar role should be present');
  assert.ok(html.includes('prompt-controls-bar'), 'prompt-controls-bar should be present');

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

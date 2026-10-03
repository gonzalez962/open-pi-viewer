import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { translate } from '@shared/i18n';
import { groupMessageBlocks, type ProcessGroup } from '@core/process-grouping';
import type { MessageBlock, ThinkingBlock, ToolCallBlock } from '@core/types/messages';
import { ProcessGroupCard } from '@features/chat/ProcessGroupCard';
import { ToolCard, ThinkingCard } from '@features/chat/ActivityBlocks';
import { MarkdownContent } from '@features/chat/MarkdownContent';
import {
  computeCustomThemeVariables,
  type AppearancePreferences,
} from '@infra/preferences';
import {
  AppearanceLifecycleController,
  applyAppearance,
  clearAppearanceCustomVariables,
} from '@features/settings/appearance';

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en', key, params);

function tool(name: string, overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return {
    type: 'tool_call',
    id: overrides.id ?? `id-${name}-${Math.random()}`,
    name,
    status: 'completed',
    output: 'sample command output line 1\nsample command output line 2',
    isError: false,
    ...overrides,
  };
}

function thinkingBlock(): ThinkingBlock {
  return { type: 'thinking', thinking: 'Deep chain-of-thought reasoning step...' };
}

function createMockDom() {
  const attributes = new Map<string, string>();
  const styles = new Map<string, string>();

  return {
    attributes,
    styles,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    style: {
      colorScheme: 'dark',
      setProperty(name: string, value: string) {
        styles.set(name, value);
      },
      removeProperty(name: string) {
        styles.delete(name);
      },
      getPropertyValue(name: string) {
        return styles.get(name) ?? '';
      },
    },
  };
}

test('chat-opacity: all five areas support opacity-only without choosing color (zero, half, full)', () => {
  // Test half opacity (0.5) across all 5 areas
  const halfVars = computeCustomThemeVariables({
    theme: 'dark',
    customBackground: {
      canvas: { opacity: 0.5 },
      sidebar: { opacity: 0.5 },
      chat: { opacity: 0.5 },
      prompt: { opacity: 0.5 },
      cards: { opacity: 0.5 },
    },
  });

  assert.strictEqual(halfVars['--custom-bg-canvas'], 'color-mix(in srgb, var(--bg-canvas) 50%, transparent)');
  assert.strictEqual(halfVars['--custom-bg-sidebar'], 'color-mix(in srgb, var(--bg-surface) 50%, transparent)');
  assert.strictEqual(halfVars['--custom-bg-chat'], 'color-mix(in srgb, var(--bg-chat-viewport) 50%, transparent)');
  assert.strictEqual(halfVars['--custom-bg-prompt'], 'color-mix(in srgb, var(--bg-surface) 50%, transparent)');
  assert.strictEqual(halfVars['--custom-bg-cards'], 'color-mix(in srgb, var(--bg-elevated) 50%, transparent)');

  // Test zero opacity (0 -> transparent) across all 5 areas
  const zeroVars = computeCustomThemeVariables({
    theme: 'dark',
    customBackground: {
      canvas: { opacity: 0 },
      sidebar: { opacity: 0 },
      chat: { opacity: 0 },
      prompt: { opacity: 0 },
      cards: { opacity: 0 },
    },
  });

  assert.strictEqual(zeroVars['--custom-bg-canvas'], 'transparent');
  assert.strictEqual(zeroVars['--custom-bg-sidebar'], 'transparent');
  assert.strictEqual(zeroVars['--custom-bg-chat'], 'transparent');
  assert.strictEqual(zeroVars['--custom-bg-prompt'], 'transparent');
  assert.strictEqual(zeroVars['--custom-bg-cards'], 'transparent');

  // Test full opacity (1 -> 100% color-mix) across all 5 areas
  const fullVars = computeCustomThemeVariables({
    theme: 'dark',
    customBackground: {
      canvas: { opacity: 1 },
      sidebar: { opacity: 1 },
      chat: { opacity: 1 },
      prompt: { opacity: 1 },
      cards: { opacity: 1 },
    },
  });

  assert.strictEqual(fullVars['--custom-bg-canvas'], 'color-mix(in srgb, var(--bg-canvas) 100%, transparent)');
  assert.strictEqual(fullVars['--custom-bg-sidebar'], 'color-mix(in srgb, var(--bg-surface) 100%, transparent)');
  assert.strictEqual(fullVars['--custom-bg-chat'], 'color-mix(in srgb, var(--bg-chat-viewport) 100%, transparent)');
  assert.strictEqual(fullVars['--custom-bg-prompt'], 'color-mix(in srgb, var(--bg-surface) 100%, transparent)');
  assert.strictEqual(fullVars['--custom-bg-cards'], 'color-mix(in srgb, var(--bg-elevated) 100%, transparent)');

  // Explicit custom hex is strictly preserved as rgba
  const hexVars = computeCustomThemeVariables({
    theme: 'dark',
    customBackground: {
      canvas: { color: '#10b981', opacity: 0.6 },
      cards: { color: '#3b82f6', opacity: 0.75 },
    },
  });
  assert.strictEqual(hexVars['--custom-bg-canvas'], 'rgba(16, 185, 129, 0.6)');
  assert.strictEqual(hexVars['--custom-bg-cards'], 'rgba(59, 130, 246, 0.75)');
});

test('chat-opacity: real React chat components render all required card surfaces and selectors', () => {
  // Render a tool card with bash command (terminal command bar)
  const bashTool = tool('bash', { args: { command: 'npm run test' } });
  const toolCardHtml = renderToStaticMarkup(
    React.createElement(ToolCard, { block: bashTool, t, defaultOpen: true })
  );

  assert.match(toolCardHtml, /class="[^"]*tool-card[^"]*"/, 'renders .tool-card');
  assert.match(toolCardHtml, /class="[^"]*tool-card-header[^"]*"/, 'renders .tool-card-header');
  assert.match(toolCardHtml, /class="[^"]*tool-card-body[^"]*"/, 'renders .tool-card-body');
  assert.match(toolCardHtml, /class="[^"]*terminal-command-bar[^"]*"/, 'renders .terminal-command-bar');
  assert.match(toolCardHtml, /class="[^"]*tool-output-container[^"]*"/, 'renders .tool-output-container');

  // Render a tool card with generic args (.tool-args-pre)
  const genericTool = tool('custom_tool', { args: { query: 'test query', limit: 10 } });
  const genericToolHtml = renderToStaticMarkup(
    React.createElement(ToolCard, { block: genericTool, t, defaultOpen: true })
  );
  assert.match(genericToolHtml, /class="[^"]*tool-args-pre[^"]*"/, 'renders .tool-args-pre');

  // Render a thinking card
  const thinkingHtml = renderToStaticMarkup(
    React.createElement(ThinkingCard, { block: thinkingBlock(), t })
  );
  assert.match(thinkingHtml, /class="[^"]*thinking-card[^"]*"/, 'renders .thinking-card');
  assert.match(thinkingHtml, /class="[^"]*thinking-header[^"]*"/, 'renders .thinking-header');

  // Render markdown with fenced code block
  const markdownHtml = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '```typescript\nconst greeting = "hello";\nconsole.log(greeting);\n```',
      t,
    })
  );
  assert.match(markdownHtml, /class="[^"]*markdown-code-block[^"]*"/, 'renders .markdown-code-block');
  assert.match(markdownHtml, /class="[^"]*markdown-code-header[^"]*"/, 'renders .markdown-code-header');
  assert.match(markdownHtml, /class="[^"]*markdown-code-pre[^"]*"/, 'renders .markdown-code-pre');

  // Render ProcessGroupCard
  const blocks: MessageBlock[] = [thinkingBlock(), bashTool];
  const items = groupMessageBlocks(blocks);
  const group = items.find((i) => i.type === 'process_group') as ProcessGroup;
  assert.ok(group, 'expected process group');

  const processGroupHtml = renderToStaticMarkup(
    React.createElement(ProcessGroupCard, { group, t })
  );
  assert.match(processGroupHtml, /class="[^"]*process-group-card[^"]*"/, 'renders .process-group-card');
  assert.match(processGroupHtml, /class="[^"]*process-group-header[^"]*"/, 'renders .process-group-header');
  assert.match(processGroupHtml, /class="[^"]*process-group-categories[^"]*"/, 'renders .process-group-categories');
});

test('chat-opacity: CSS contract enforces single surface-owner and transparent nested fills under [data-custom-cards]', () => {
  const css = readFileSync(join(process.cwd(), 'src/features/chat/chat.css'), 'utf8');

  // Verify the scoped custom cards override block exists
  assert.match(css, /\[data-custom-cards\]/, 'contains [data-custom-cards] selector');

  // Verify all 15 required nested surfaces are styled transparent under [data-custom-cards]
  const requiredSelectors = [
    '.process-group-card',
    '.process-group-header',
    '.process-category-children',
    '.thinking-card',
    '.thinking-body',
    '.tool-card',
    '.tool-card-header',
    '.tool-card-body',
    '.tool-args-pre',
    '.tool-output-container',
    '.terminal-command-bar',
    '.terminal-screen',
    '.tool-code-pre',
    '.markdown-code-block',
    '.markdown-code-header',
    '.markdown-code-pre',
  ];

  for (const selector of requiredSelectors) {
    const pattern = new RegExp(`\\[data-custom-cards\\][^,{]*\\${selector}`);
    assert.match(css, pattern, `CSS must scope ${selector} under [data-custom-cards]`);
  }

  // Negative assertion: no container opacity rule on message-item or cards
  assert.doesNotMatch(
    css,
    /\[data-custom-cards\][^{]*\{[^}]*\bopacity:\s*0\./,
    'Must NEVER set opacity: 0.x on whole containers (text/buttons/icons must stay fully opaque)'
  );

  // Verify terminal-command-bar and terminal-screen use design tokens by default, not hardcoded hex
  assert.doesNotMatch(
    css,
    /\.terminal-command-bar\s*\{[^}]*background:\s*#0d1117/,
    'terminal-command-bar must not use hardcoded #0d1117 background'
  );
  assert.doesNotMatch(
    css,
    /\.terminal-screen\s*\{[^}]*background:\s*#0d1117/,
    'terminal-screen must not use hardcoded #0d1117 background'
  );
});

test('chat-opacity: lifecycle controller manages data-custom-cards attribute, cancel restoration, and system theme changes', () => {
  const dom = createMockDom();
  let saved: AppearancePreferences = { theme: 'dark' };

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => saved,
    commitAppearance: (candidate) => {
      saved = { ...saved, ...candidate } as AppearancePreferences;
      return { success: true };
    },
    resetAppearance: () => {
      saved = { theme: 'dark' };
      return { success: true };
    },
    rootElement: dom,
  });
  controller.start();

  // Baseline: no override attribute
  assert.strictEqual(dom.attributes.has('data-custom-cards'), false);
  assert.strictEqual(dom.styles.has('--custom-bg-cards'), false);

  // Draft with opacity-only cards: attribute set, color-mix CSS variable emitted
  controller.begin();
  controller.update({
    customBackground: {
      cards: { opacity: 0.5 },
    },
  });

  assert.strictEqual(dom.attributes.get('data-custom-cards'), 'true');
  assert.strictEqual(
    dom.styles.get('--custom-bg-cards'),
    'color-mix(in srgb, var(--bg-elevated) 50%, transparent)'
  );

  // Cancel restores saved appearance without custom cards attribute or variable
  controller.cancel();
  assert.strictEqual(dom.attributes.has('data-custom-cards'), false);
  assert.strictEqual(dom.styles.has('--custom-bg-cards'), false);

  // Confirm saves and preserves attribute and variable
  controller.begin();
  controller.update({
    customBackground: {
      cards: { opacity: 0.7 },
      chat: { opacity: 0.4 },
    },
  });
  const res = controller.confirm();
  assert.strictEqual(res.success, true);
  assert.strictEqual(dom.attributes.get('data-custom-cards'), 'true');
  assert.strictEqual(
    dom.styles.get('--custom-bg-cards'),
    'color-mix(in srgb, var(--bg-elevated) 70%, transparent)'
  );
  assert.strictEqual(
    dom.styles.get('--custom-bg-chat'),
    'color-mix(in srgb, var(--bg-chat-viewport) 40%, transparent)'
  );

  // Atomic reset clears attribute and all custom variables
  controller.resetAppearance();
  assert.strictEqual(dom.attributes.has('data-custom-cards'), false);
  assert.strictEqual(dom.styles.has('--custom-bg-cards'), false);
  assert.strictEqual(dom.styles.has('--custom-bg-chat'), false);

  // Direct applyAppearance and clearAppearanceCustomVariables functions manage data-custom-cards
  applyAppearance({ customBackground: { cards: { opacity: 0.5 } } }, { rootElement: dom });
  assert.strictEqual(dom.attributes.get('data-custom-cards'), 'true');
  clearAppearanceCustomVariables(dom);
  assert.strictEqual(dom.attributes.has('data-custom-cards'), false);

  controller.dispose();
});

test('chat-opacity: tokens.css preserves default token fallbacks when no override exists', () => {
  const tokensCss = readFileSync(join(process.cwd(), 'src/shared/styles/tokens.css'), 'utf8');

  // Verify tokens.css does not define static --custom-bg-* on :root which would shadow component fallbacks
  assert.doesNotMatch(
    tokensCss,
    /--custom-bg-cards:\s*var\(--bg-elevated\)/,
    'tokens.css must not statically set --custom-bg-cards on :root'
  );
  assert.doesNotMatch(
    tokensCss,
    /--custom-bg-canvas:\s*var\(--bg-canvas\)/,
    'tokens.css must not statically set --custom-bg-canvas on :root'
  );
});

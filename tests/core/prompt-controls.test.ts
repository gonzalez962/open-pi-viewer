import assert from 'node:assert';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  formatTokens,
  getContextUsageLevel,
  formatCost,
  formatPercent,
  getModelStatsKey,
  handleDoubleEscCancel,
  isMessageEmpty,
  getSupportedAttachmentCategories,
  modelSupportsInputModality as modelSupportsInputModalityCore,
  isContextHighUsage,
  calculateContextMetrics,
  HIGH_CONTEXT_PERCENT_THRESHOLD,
  buildInsertCodeDraft,
} from '@core/prompt-controls-utils';
import { PopoverSearchBar } from '@features/chat/components/PopoverSearchBar';
import {
  PromptControls,
  modelSupportsFiles,
  modelSupportsInputModality,
} from '@features/chat/PromptControls';
import { getEngramProjectPi, getEngramCloudStatusPi, enrollEngramProjectPi, type EngramCloudStatus } from '@infra/bridge';
import type { ModelInfo } from '@core/types/models';
import type { ProfileSummary } from '@core/types/profiles';
import { decideProfileSelection } from '@core/types/profiles';
import enJson from '@shared/locales/en.json';
import esJson from '@shared/locales/es.json';

test('prompt-controls-utils: formatTokens formats numbers with k and M suffixes accurately', () => {
  assert.strictEqual(formatTokens(0), '0');
  assert.strictEqual(formatTokens(null), '0');
  assert.strictEqual(formatTokens(undefined), '0');
  assert.strictEqual(formatTokens(NaN), '0');
  assert.strictEqual(formatTokens(-10), '0');

  // Less than 1000
  assert.strictEqual(formatTokens(1), '1');
  assert.strictEqual(formatTokens(450), '450');
  assert.strictEqual(formatTokens(999), '999');

  // Thousands (k)
  assert.strictEqual(formatTokens(1000), '1k');
  assert.strictEqual(formatTokens(1500), '1.5k');
  assert.strictEqual(formatTokens(12400), '12.4k');
  assert.strictEqual(formatTokens(272000), '272k');
  assert.strictEqual(formatTokens(999900), '999.9k');

  // Millions (M)
  assert.strictEqual(formatTokens(1000000), '1M');
  assert.strictEqual(formatTokens(1250000), '1.25M');
  assert.strictEqual(formatTokens(2000000), '2M');
});

test('prompt-controls-utils: getContextUsageLevel maps percentages to normal, warning, and critical', () => {
  // Normal (< 60%)
  assert.strictEqual(getContextUsageLevel(0), 'normal');
  assert.strictEqual(getContextUsageLevel(null), 'normal');
  assert.strictEqual(getContextUsageLevel(undefined), 'normal');
  assert.strictEqual(getContextUsageLevel(-5), 'normal');
  assert.strictEqual(getContextUsageLevel(25.4), 'normal');
  assert.strictEqual(getContextUsageLevel(59.9), 'normal');

  // Warning (60% - 84.9%)
  assert.strictEqual(getContextUsageLevel(60), 'warning');
  assert.strictEqual(getContextUsageLevel(72.5), 'warning');
  assert.strictEqual(getContextUsageLevel(84.9), 'warning');

  // Critical (>= 85%)
  assert.strictEqual(getContextUsageLevel(85), 'critical');
  assert.strictEqual(getContextUsageLevel(95.2), 'critical');
  assert.strictEqual(getContextUsageLevel(100), 'critical');
  assert.strictEqual(getContextUsageLevel(110), 'critical');
});

test('prompt-controls-utils: formatCost formats monetary costs accurately', () => {
  assert.strictEqual(formatCost(0), '$0.00');
  assert.strictEqual(formatCost(null), '$0.00');
  assert.strictEqual(formatCost(undefined), '$0.00');
  assert.strictEqual(formatCost(NaN), '$0.00');
  assert.strictEqual(formatCost(-2), '$0.00');

  // Less than 1 cent
  assert.strictEqual(formatCost(0.004), '<$0.01');

  // Standard dollars and cents
  assert.strictEqual(formatCost(0.05), '$0.05');
  assert.strictEqual(formatCost(0.45), '$0.45');
  assert.strictEqual(formatCost(1.5), '$1.50');
  assert.strictEqual(formatCost(12.345), '$12.35');
});

test('prompt-controls-utils: formatPercent formats percentages with 2 decimal places', () => {
  // Handles null, undefined, NaN, 0, negative values by returning '0.00'
  assert.strictEqual(formatPercent(null), '0.00');
  assert.strictEqual(formatPercent(undefined), '0.00');
  assert.strictEqual(formatPercent(NaN), '0.00');
  assert.strictEqual(formatPercent(0), '0.00');
  assert.strictEqual(formatPercent(-1), '0.00');
  assert.strictEqual(formatPercent(-10.5), '0.00');

  // Handles single decimal numbers like 5.1 -> '5.10'
  assert.strictEqual(formatPercent(5.1), '5.10');

  // Handles long decimal numbers like 14.854213 -> '14.85'
  assert.strictEqual(formatPercent(14.854213), '14.85');

  // Handles 100 -> '100.00'
  assert.strictEqual(formatPercent(100), '100.00');
});

test('prompt-controls-utils: getModelStatsKey returns provider/id key or empty string accurately', () => {
  // Empty, null, undefined, or missing provider/id returns ''
  assert.strictEqual(getModelStatsKey(null), '');
  assert.strictEqual(getModelStatsKey(undefined), '');
  assert.strictEqual(getModelStatsKey({}), '');
  assert.strictEqual(getModelStatsKey({ provider: '', id: '' }), '');

  // Both provider and id exist
  assert.strictEqual(
    getModelStatsKey({ provider: 'anthropic', id: 'claude-3-5-sonnet' }),
    'anthropic/claude-3-5-sonnet'
  );
  assert.strictEqual(
    getModelStatsKey({ provider: 'openai', id: 'gpt-4o' }),
    'openai/gpt-4o'
  );

  // Partial provider or id
  assert.strictEqual(getModelStatsKey({ provider: 'anthropic' }), 'anthropic/');
  assert.strictEqual(getModelStatsKey({ id: 'gpt-4o' }), '/gpt-4o');
});

test('i18n: prompt controls and thinking level keys maintain exact parity between en.json and es.json', () => {
  const promptKeys = [
    'prompt_controls.toolbar_aria',
    'prompt_controls.default_model',
    'prompt_controls.select_model_title',
    'prompt_controls.available_models',
    'prompt_controls.search_models_placeholder',
    'prompt_controls.no_models_found',
    'prompt_controls.reasoning_supported',
    'prompt_controls.select_thinking_title',
    'prompt_controls.thinking_levels',
    'prompt_controls.reasoning_effort_header',
    'prompt_controls.default_badge',
    'prompt_controls.context_meter_title',
    'prompt_controls.session_stats',
    'prompt_controls.context_details_title',
    'prompt_controls.context_used',
    'prompt_controls.input_tokens',
    'prompt_controls.output_tokens',
    'prompt_controls.cache_read_tokens',
    'prompt_controls.cache_write_tokens',
    'prompt_controls.total_session_tokens',
    'prompt_controls.estimated_cost',
    'prompt.confirm_cancel',
    'prompt.confirm_cancel_title',
    'prompt.status_dot_aria',
    'thinking_level.off',
    'thinking_level.minimal',
    'thinking_level.low',
    'thinking_level.medium',
    'thinking_level.high',
    'thinking_level.xhigh',
    'thinking_level.max',
    'message.status_cancelled',
    'message.cancelled_note',
  ];

  for (const key of promptKeys) {
    assert.ok(
      key in enJson,
      `Key '${key}' must exist in en.json`
    );
    assert.ok(
      key in esJson,
      `Key '${key}' must exist in es.json`
    );
    assert.ok(
      (enJson as Record<string, string>)[key].trim().length > 0,
      `Key '${key}' in en.json must not be empty`
    );
    assert.ok(
      (esJson as Record<string, string>)[key].trim().length > 0,
      `Key '${key}' in es.json must not be empty`
    );
  }
});

test('i18n: prompt action and status dot keys have expected content and interpolation parity', () => {
  assert.strictEqual(enJson['prompt_controls.default_badge'], 'default');
  assert.strictEqual(esJson['prompt_controls.default_badge'], 'por defecto');
  assert.strictEqual(enJson['prompt.confirm_cancel'], 'Confirm?');
  assert.strictEqual(esJson['prompt.confirm_cancel'], '¿Confirmar?');

  assert.strictEqual(
    enJson['prompt.confirm_cancel_title'],
    'Click again to confirm cancelling response generation'
  );
  assert.strictEqual(
    esJson['prompt.confirm_cancel_title'],
    'Haz clic de nuevo para confirmar la cancelación'
  );

  assert.strictEqual(
    enJson['prompt.status_dot_aria'],
    'Connection status: {status}'
  );
  assert.strictEqual(
    esJson['prompt.status_dot_aria'],
    'Estado de la conexión: {status}'
  );

  assert.strictEqual(enJson['message.status_cancelled'], 'Cancelled');
  assert.strictEqual(esJson['message.status_cancelled'], 'Cancelado');
  assert.strictEqual(enJson['message.cancelled_note'], 'Generation cancelled');
  assert.strictEqual(esJson['message.cancelled_note'], 'Generación cancelada');
});

test('i18n: settings view keys maintain exact parity between en.json and es.json', () => {
  const settingsKeys = [
    'settings.back_to_chat',
    'settings.view_subtitle',
  ];

  for (const key of settingsKeys) {
    assert.ok(
      key in enJson,
      `Key '${key}' must exist in en.json`
    );
    assert.ok(
      key in esJson,
      `Key '${key}' must exist in es.json`
    );
    assert.ok(
      (enJson as Record<string, string>)[key].trim().length > 0,
      `Key '${key}' in en.json must not be empty`
    );
    assert.ok(
      (esJson as Record<string, string>)[key].trim().length > 0,
      `Key '${key}' in es.json must not be empty`
    );
  }

  assert.strictEqual(enJson['settings.back_to_chat'], 'Back to Chat');
  assert.strictEqual(esJson['settings.back_to_chat'], 'Volver al chat');
  assert.strictEqual(
    enJson['settings.view_subtitle'],
    'Configure appearance, connection, tool permissions, and file synchronization'
  );
  assert.strictEqual(
    esJson['settings.view_subtitle'],
    'Configuración de apariencia, conexión, permisos de herramientas y sincronización'
  );
});

test('prompt-controls-utils: handleDoubleEscCancel ignores non-Escape keys', () => {
  let preventDefaultCalled = false;
  let confirmStartCalled = false;
  let abortCalled = false;

  const event = {
    key: 'Enter',
    preventDefault: () => {
      preventDefaultCalled = true;
    },
  };

  const result = handleDoubleEscCancel(event, {
    isBusy: true,
    isConfirming: false,
    hasOpenOverlay: false,
    onConfirmStart: () => {
      confirmStartCalled = true;
    },
    onAbort: () => {
      abortCalled = true;
    },
  });

  assert.strictEqual(result, false);
  assert.strictEqual(preventDefaultCalled, false);
  assert.strictEqual(confirmStartCalled, false);
  assert.strictEqual(abortCalled, false);
});

test('prompt-controls-utils: handleDoubleEscCancel ignores Escape when isBusy is false', () => {
  let preventDefaultCalled = false;
  let confirmStartCalled = false;
  let abortCalled = false;

  const event = {
    key: 'Escape',
    preventDefault: () => {
      preventDefaultCalled = true;
    },
  };

  const result = handleDoubleEscCancel(event, {
    isBusy: false,
    isConfirming: false,
    hasOpenOverlay: false,
    onConfirmStart: () => {
      confirmStartCalled = true;
    },
    onAbort: () => {
      abortCalled = true;
    },
  });

  assert.strictEqual(result, false);
  assert.strictEqual(preventDefaultCalled, false);
  assert.strictEqual(confirmStartCalled, false);
  assert.strictEqual(abortCalled, false);
});

test('prompt-controls-utils: handleDoubleEscCancel ignores Escape when hasOpenOverlay is true', () => {
  let preventDefaultCalled = false;
  let confirmStartCalled = false;
  let abortCalled = false;

  const event = {
    key: 'Escape',
    preventDefault: () => {
      preventDefaultCalled = true;
    },
  };

  // When not confirming
  const result1 = handleDoubleEscCancel(event, {
    isBusy: true,
    isConfirming: false,
    hasOpenOverlay: true,
    onConfirmStart: () => {
      confirmStartCalled = true;
    },
    onAbort: () => {
      abortCalled = true;
    },
  });

  assert.strictEqual(result1, false);
  assert.strictEqual(preventDefaultCalled, false);
  assert.strictEqual(confirmStartCalled, false);
  assert.strictEqual(abortCalled, false);

  // When confirming
  const result2 = handleDoubleEscCancel(event, {
    isBusy: true,
    isConfirming: true,
    hasOpenOverlay: true,
    onConfirmStart: () => {
      confirmStartCalled = true;
    },
    onAbort: () => {
      abortCalled = true;
    },
  });

  assert.strictEqual(result2, false);
  assert.strictEqual(preventDefaultCalled, false);
  assert.strictEqual(confirmStartCalled, false);
  assert.strictEqual(abortCalled, false);
});

test('prompt-controls-utils: handleDoubleEscCancel calls onConfirmStart and preventDefault on first Escape, returns false', () => {
  let preventDefaultCalled = false;
  let confirmStartCalled = false;
  let abortCalled = false;

  const event = {
    key: 'Escape',
    preventDefault: () => {
      preventDefaultCalled = true;
    },
  };

  const result = handleDoubleEscCancel(event, {
    isBusy: true,
    isConfirming: false,
    hasOpenOverlay: false,
    onConfirmStart: () => {
      confirmStartCalled = true;
    },
    onAbort: () => {
      abortCalled = true;
    },
  });

  assert.strictEqual(result, false);
  assert.strictEqual(preventDefaultCalled, true);
  assert.strictEqual(confirmStartCalled, true);
  assert.strictEqual(abortCalled, false);
});

test('prompt-controls-utils: handleDoubleEscCancel calls onAbort and preventDefault on second Escape, returns true', () => {
  let preventDefaultCalled = false;
  let confirmStartCalled = false;
  let abortCalled = false;

  const event = {
    key: 'Escape',
    preventDefault: () => {
      preventDefaultCalled = true;
    },
  };

  const result = handleDoubleEscCancel(event, {
    isBusy: true,
    isConfirming: true,
    hasOpenOverlay: false,
    onConfirmStart: () => {
      confirmStartCalled = true;
    },
    onAbort: () => {
      abortCalled = true;
    },
  });

  assert.strictEqual(result, true);
  assert.strictEqual(preventDefaultCalled, true);
  assert.strictEqual(confirmStartCalled, false);
  assert.strictEqual(abortCalled, true);
});

test('prompt-controls-utils: isMessageEmpty returns false for non-assistant messages', () => {
  assert.strictEqual(isMessageEmpty(null), false);
  assert.strictEqual(isMessageEmpty(undefined), false);
  assert.strictEqual(
    isMessageEmpty({
      id: 'u1',
      role: 'user',
      content: '',
      timestamp: '12:00',
    }),
    false
  );
  assert.strictEqual(
    isMessageEmpty({
      id: 's1',
      role: 'system',
      content: '',
      timestamp: '12:00',
    }),
    false
  );
});

test('prompt-controls-utils: isMessageEmpty returns true for empty/whitespace assistant message with no blocks', () => {
  assert.strictEqual(
    isMessageEmpty({
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: '12:00',
    }),
    true
  );
  assert.strictEqual(
    isMessageEmpty({
      id: 'a2',
      role: 'assistant',
      content: '   \n\t  ',
      timestamp: '12:00',
    }),
    true
  );
});

test('prompt-controls-utils: isMessageEmpty returns false for non-empty content', () => {
  assert.strictEqual(
    isMessageEmpty({
      id: 'a1',
      role: 'assistant',
      content: 'Hello world',
      timestamp: '12:00',
    }),
    false
  );
  assert.strictEqual(
    isMessageEmpty({
      id: 'a2',
      role: 'assistant',
      content: '   non-empty   ',
      timestamp: '12:00',
    }),
    false
  );
});

test('prompt-controls-utils: isMessageEmpty returns false for empty content with text block', () => {
  assert.strictEqual(
    isMessageEmpty({
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: '12:00',
      blocks: [{ type: 'text', text: 'Hello block' }],
    }),
    false
  );
});

test('prompt-controls-utils: isMessageEmpty returns false for empty content with thinking block', () => {
  assert.strictEqual(
    isMessageEmpty({
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: '12:00',
      blocks: [{ type: 'thinking', thinking: 'Thinking through problem...' }],
    }),
    false
  );
});

test('prompt-controls-utils: isMessageEmpty returns false for empty content with tool_call block', () => {
  assert.strictEqual(
    isMessageEmpty({
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: '12:00',
      blocks: [
        {
          type: 'tool_call',
          id: 'tc1',
          name: 'read',
          args: { path: 'foo.ts' },
          status: 'running',
        },
      ],
    }),
    false
  );
});

test('prompt-controls-utils: isMessageEmpty returns true for empty content with empty blocks', () => {
  assert.strictEqual(
    isMessageEmpty({
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: '12:00',
      blocks: [],
    }),
    true
  );
  assert.strictEqual(
    isMessageEmpty({
      id: 'a2',
      role: 'assistant',
      content: '   ',
      timestamp: '12:00',
      blocks: [
        { type: 'text', text: '   ' },
        { type: 'thinking', thinking: '' },
      ],
    }),
    true
  );
});

test('PopoverSearchBar: renders empty state, custom classes, icon, and attributes', () => {
  assert.strictEqual(typeof PopoverSearchBar, 'function');

  const element = React.createElement(PopoverSearchBar, {
    value: '',
    onChange: () => {},
    placeholder: 'Search models...',
    clearAriaLabel: 'Clear model search',
    className: 'model-search-box',
    inputClassName: 'custom-input-class',
    autoFocus: true,
  });

  const markup = renderToStaticMarkup(element);

  // Outer container and classes
  assert.ok(markup.includes('popover-search-box model-search-box'));
  // SVG icon
  assert.ok(markup.includes('popover-search-icon'));
  assert.ok(markup.includes('aria-hidden="true"'));
  // Input classes and attributes
  assert.ok(markup.includes('popover-search-input custom-input-class'));
  assert.ok(markup.includes('placeholder="Search models..."'));
  assert.ok(markup.includes('aria-label="Search models..."'));
  assert.ok(markup.includes('value=""'));
  // Clear button is not rendered when value is empty
  assert.ok(!markup.includes('popover-search-clear'));
});

test('PopoverSearchBar: renders query state with clear button and handles onChange and clear click', () => {
  let changedVal = '';
  const element = React.createElement(PopoverSearchBar, {
    value: 'claude-3-opus',
    onChange: (val: string) => {
      changedVal = val;
    },
    placeholder: 'Search models...',
    clearAriaLabel: 'Clear model filter',
  });

  const markup = renderToStaticMarkup(element);
  assert.ok(markup.includes('value="claude-3-opus"'));
  assert.ok(markup.includes('popover-search-clear'));
  assert.ok(markup.includes('aria-label="Clear model filter"'));
  assert.ok(markup.includes('×'));

  // Direct component tree test for event callbacks
  const instance = PopoverSearchBar({
    value: 'claude-3-opus',
    onChange: (val: string) => {
      changedVal = val;
    },
    placeholder: 'Search models...',
    clearAriaLabel: 'Clear model filter',
  });

  assert.ok(React.isValidElement(instance));
  assert.strictEqual(instance.props.className, 'popover-search-box');

  const children = React.Children.toArray(instance.props.children);
  const inputEl = children.find(
    (c): c is React.ReactElement => React.isValidElement(c) && c.type === 'input'
  );
  assert.ok(inputEl);
  inputEl.props.onChange({ target: { value: 'gpt-4o' } });
  assert.strictEqual(changedVal, 'gpt-4o');

  const clearBtn = children.find(
    (c): c is React.ReactElement => React.isValidElement(c) && c.type === 'button'
  );
  assert.ok(clearBtn);
  assert.strictEqual(clearBtn.props['aria-label'], 'Clear model filter');
  clearBtn.props.onClick();
  assert.strictEqual(changedVal, '');
});

test('PopoverSearchBar: uses default clearAriaLabel when omitted', () => {
  const instance = PopoverSearchBar({
    value: 'active-filter',
    onChange: () => {},
    placeholder: 'Search...',
  });

  assert.ok(React.isValidElement(instance));
  const children = React.Children.toArray(instance.props.children);
  const clearBtn = children.find(
    (c): c is React.ReactElement => React.isValidElement(c) && c.type === 'button'
  );
  assert.ok(clearBtn);
  assert.strictEqual(clearBtn.props['aria-label'], 'Clear search');
});

test('PromptControls: renders file attachment button when model supports files', () => {
  const modelWithFiles: ModelInfo = {
    id: 'claude-3-5-sonnet',
    provider: 'anthropic',
    name: 'Claude 3.5 Sonnet',
    input_modalities: ['text', 'image'],
  };

  assert.strictEqual(modelSupportsFiles(modelWithFiles), true);

  const markup = renderToStaticMarkup(
    React.createElement(PromptControls, {
      modelInfo: modelWithFiles,
      availableModels: [modelWithFiles],
      isChangingModel: false,
      thinkingLevel: null,
      availableThinkingLevels: [],
      sessionStats: null,
      isConnected: true,
      isBusy: false,
      canSend: true,
      onSelectModel: async () => {},
      onSelectThinkingLevel: async () => {},
      t: (key: string) => key,
    })
  );

  assert.ok(markup.includes('file-attach-btn'));
  assert.ok(markup.includes('file-attach-wrapper'));
});

test('PromptControls: omits file attachment button when model does not support files', () => {
  const textOnlyModel: ModelInfo = {
    id: 'deepseek-chat',
    provider: 'deepseek',
    name: 'DeepSeek Chat',
    input_modalities: ['text'],
  };

  assert.strictEqual(modelSupportsFiles(textOnlyModel), false);

  const markup = renderToStaticMarkup(
    React.createElement(PromptControls, {
      modelInfo: textOnlyModel,
      availableModels: [textOnlyModel],
      isChangingModel: false,
      thinkingLevel: null,
      availableThinkingLevels: [],
      sessionStats: null,
      isConnected: true,
      isBusy: false,
      canSend: true,
      onSelectModel: async () => {},
      onSelectThinkingLevel: async () => {},
      t: (key: string) => key,
    })
  );

  assert.ok(!markup.includes('file-attach-btn'));
  assert.ok(!markup.includes('file-attach-wrapper'));
});

test('PromptControls: popover renders image, document/code, and all file type options', () => {
  const modelWithFiles: ModelInfo = {
    id: 'gpt-4o',
    provider: 'openai',
    name: 'GPT-4o',
    input_modalities: ['text', 'image', 'video', 'file', 'audio'],
  };

  const markup = renderToStaticMarkup(
    React.createElement(PromptControls, {
      modelInfo: modelWithFiles,
      availableModels: [modelWithFiles],
      isChangingModel: false,
      thinkingLevel: null,
      availableThinkingLevels: [],
      sessionStats: null,
      isConnected: true,
      isBusy: false,
      canSend: true,
      defaultFileAttachOpen: true,
      onSelectModel: async () => {},
      onSelectThinkingLevel: async () => {},
      t: (key: string) => key,
    })
  );

  assert.ok(markup.includes('file-attach-popover'));
  assert.ok(markup.includes('file-type-list'));
  assert.ok(markup.includes('prompt_controls.select_file_type'));
  assert.ok(markup.includes('prompt_controls.file_type_images'));
  assert.ok(markup.includes('prompt_controls.file_type_videos'));
  assert.ok(markup.includes('prompt_controls.file_type_audio'));
  assert.ok(markup.includes('prompt_controls.file_type_documents'));
  assert.ok(markup.includes('prompt_controls.file_type_all'));
});

test('PromptControls: popover renders only supported modalities (e.g. text + image)', () => {
  const model: ModelInfo = {
    id: 'gpt-4o-mini',
    provider: 'openai',
    name: 'GPT-4o Mini',
    input_modalities: ['text', 'image'],
  };

  const markup = renderToStaticMarkup(
    React.createElement(PromptControls, {
      modelInfo: model,
      availableModels: [model],
      isChangingModel: false,
      thinkingLevel: null,
      availableThinkingLevels: [],
      sessionStats: null,
      isConnected: true,
      isBusy: false,
      canSend: true,
      defaultFileAttachOpen: true,
      onSelectModel: async () => {},
      onSelectThinkingLevel: async () => {},
      t: (key: string) => key,
    })
  );

  assert.ok(markup.includes('file-attach-popover'));
  assert.ok(markup.includes('prompt_controls.file_type_images'));
  assert.ok(markup.includes('prompt_controls.file_type_documents'));
  assert.ok(!markup.includes('prompt_controls.file_type_videos'));
  assert.ok(!markup.includes('prompt_controls.file_type_audio'));
  assert.ok(!markup.includes('prompt_controls.file_type_all'));
});

test('PromptControls: popover renders only image option when model input_modalities has only image', () => {
  const model: ModelInfo = {
    id: 'dall-e-vision',
    provider: 'openai',
    name: 'Vision Only Model',
    input_modalities: ['image'],
  };

  const markup = renderToStaticMarkup(
    React.createElement(PromptControls, {
      modelInfo: model,
      availableModels: [model],
      isChangingModel: false,
      thinkingLevel: null,
      availableThinkingLevels: [],
      sessionStats: null,
      isConnected: true,
      isBusy: false,
      canSend: true,
      defaultFileAttachOpen: true,
      onSelectModel: async () => {},
      onSelectThinkingLevel: async () => {},
      t: (key: string) => key,
    })
  );

  assert.ok(markup.includes('file-attach-popover'));
  assert.ok(markup.includes('prompt_controls.file_type_images'));
  assert.ok(!markup.includes('prompt_controls.file_type_videos'));
  assert.ok(!markup.includes('prompt_controls.file_type_audio'));
  assert.ok(!markup.includes('prompt_controls.file_type_documents'));
  assert.ok(!markup.includes('prompt_controls.file_type_all'));
});

test('PromptControls: popover recovers input_modalities from availableModels when modelInfo lacks it', () => {
  const modelInfo: ModelInfo = {
    id: 'agy_p1/gemini-3.8-flash-high',
    provider: 'cpam',
    name: 'Gemini 3.8 Flash High',
  };
  const availableModels: ModelInfo[] = [
    {
      id: 'agy_p1/gemini-3.8-flash-high',
      provider: 'cpam',
      name: 'Gemini 3.8 Flash High',
      input_modalities: ['text', 'image', 'video', 'file', 'audio'],
    },
  ];

  const markup = renderToStaticMarkup(
    React.createElement(PromptControls, {
      modelInfo,
      availableModels,
      isChangingModel: false,
      thinkingLevel: null,
      availableThinkingLevels: [],
      sessionStats: null,
      isConnected: true,
      isBusy: false,
      canSend: true,
      defaultFileAttachOpen: true,
      onSelectModel: async () => {},
      onSelectThinkingLevel: async () => {},
      t: (key: string) => key,
    })
  );

  assert.ok(markup.includes('prompt_controls.file_type_images'));
  assert.ok(markup.includes('prompt_controls.file_type_videos'));
  assert.ok(markup.includes('prompt_controls.file_type_audio'));
  assert.ok(markup.includes('prompt_controls.file_type_documents'));
  assert.ok(markup.includes('prompt_controls.file_type_all'));
});

test('prompt-controls-utils: getSupportedAttachmentCategories maps input_modalities and fallbacks correctly', () => {
  // null and undefined model
  assert.deepStrictEqual(getSupportedAttachmentCategories(null), []);
  assert.deepStrictEqual(getSupportedAttachmentCategories(undefined), []);

  // undefined / missing modalities fallback
  assert.deepStrictEqual(
    getSupportedAttachmentCategories({ id: 'm_none' } as ModelInfo),
    ['image', 'code', 'all']
  );
  assert.deepStrictEqual(
    getSupportedAttachmentCategories({ id: 'm_undef', input_modalities: undefined } as ModelInfo),
    ['image', 'code', 'all']
  );

  // text only
  assert.deepStrictEqual(
    getSupportedAttachmentCategories({ id: 'm_text', input_modalities: ['text'] }),
    ['code']
  );

  // text + image
  assert.deepStrictEqual(
    getSupportedAttachmentCategories({ id: 'm_img', input_modalities: ['text', 'image'] }),
    ['image', 'code']
  );

  // all 5 modalities
  assert.deepStrictEqual(
    getSupportedAttachmentCategories({
      id: 'm_all',
      input_modalities: ['text', 'image', 'video', 'file', 'audio'],
    }),
    ['image', 'video', 'audio', 'code', 'all']
  );

  // text + file
  assert.deepStrictEqual(
    getSupportedAttachmentCategories({ id: 'm_file', input_modalities: ['text', 'file'] }),
    ['code', 'all']
  );

  // audio only
  assert.deepStrictEqual(
    getSupportedAttachmentCategories({ id: 'm_audio', input_modalities: ['audio'] }),
    ['audio']
  );

  // video only
  assert.deepStrictEqual(
    getSupportedAttachmentCategories({ id: 'm_video', input_modalities: ['video'] }),
    ['video']
  );

  // input array fallback
  assert.deepStrictEqual(
    getSupportedAttachmentCategories({ id: 'm_fallback', input: ['text', 'video'] } as ModelInfo),
    ['video', 'code']
  );
});

test('prompt-controls-utils & PromptControls: modelSupportsInputModality checks input modalities accurately', () => {
  // Re-export equality check
  assert.strictEqual(modelSupportsInputModality, modelSupportsInputModalityCore);

  const modelWithModalities: ModelInfo = {
    id: 'test-multimodal',
    input_modalities: ['text', 'image', 'video', 'file', 'audio'],
  };

  // 'text', 'image', 'video', 'file', 'audio' modalities on a model with input_modalities
  assert.strictEqual(modelSupportsInputModality(modelWithModalities, 'text'), true);
  assert.strictEqual(modelSupportsInputModality(modelWithModalities, 'image'), true);
  assert.strictEqual(modelSupportsInputModality(modelWithModalities, 'video'), true);
  assert.strictEqual(modelSupportsInputModality(modelWithModalities, 'file'), true);
  assert.strictEqual(modelSupportsInputModality(modelWithModalities, 'audio'), true);

  // Case insensitivity ('IMAGE', 'Video', etc.)
  assert.strictEqual(modelSupportsInputModality(modelWithModalities, 'TEXT'), true);
  assert.strictEqual(modelSupportsInputModality(modelWithModalities, 'IMAGE'), true);
  assert.strictEqual(modelSupportsInputModality(modelWithModalities, 'Video'), true);
  assert.strictEqual(modelSupportsInputModality(modelWithModalities, 'FILE'), true);
  assert.strictEqual(modelSupportsInputModality(modelWithModalities, 'AuDiO'), true);

  // Case insensitivity with mixed-case in model.input_modalities
  const modelMixedCasing: ModelInfo = {
    id: 'test-mixed',
    input_modalities: ['Text', 'IMAGE', 'ViDeO'],
  };
  assert.strictEqual(modelSupportsInputModality(modelMixedCasing, 'text'), true);
  assert.strictEqual(modelSupportsInputModality(modelMixedCasing, 'image'), true);
  assert.strictEqual(modelSupportsInputModality(modelMixedCasing, 'video'), true);

  // Returns false for modalities not in input_modalities
  const textImageModel: ModelInfo = {
    id: 'test-text-image',
    input_modalities: ['text', 'image'],
  };
  assert.strictEqual(modelSupportsInputModality(textImageModel, 'video'), false);
  assert.strictEqual(modelSupportsInputModality(textImageModel, 'audio'), false);
  assert.strictEqual(modelSupportsInputModality(textImageModel, 'file'), false);
  assert.strictEqual(modelSupportsInputModality(textImageModel, 'unknown'), false);
  assert.strictEqual(modelSupportsInputModality(textImageModel, ''), false);

  // Returns false for null/undefined/missing models
  assert.strictEqual(modelSupportsInputModality(null, 'text'), false);
  assert.strictEqual(modelSupportsInputModality(undefined, 'image'), false);
  assert.strictEqual(modelSupportsInputModality({ id: 'empty-model' } as ModelInfo, 'text'), false);
  assert.strictEqual(
    modelSupportsInputModality({ id: 'undef-modalities', input_modalities: undefined } as ModelInfo, 'text'),
    false
  );

  // Fallback to model.input when input_modalities is not present
  const fallbackModel: ModelInfo = {
    id: 'test-fallback',
    input: ['text', 'video'],
  };
  assert.strictEqual(modelSupportsInputModality(fallbackModel, 'text'), true);
  assert.strictEqual(modelSupportsInputModality(fallbackModel, 'video'), true);
  assert.strictEqual(modelSupportsInputModality(fallbackModel, 'ViDeO'), true);
  assert.strictEqual(modelSupportsInputModality(fallbackModel, 'image'), false);
  assert.strictEqual(modelSupportsInputModality(fallbackModel, 'audio'), false);
});

test('decideProfileSelection: guards activation while busy or changing and preserves exact ProfileSummary or null', () => {
  const profile: ProfileSummary = {
    name: 'developer-speed',
    scope: 'project',
    agent_count: 2,
    is_active: false,
    default_model: 'openrouter/anthropic/claude-3.5-sonnet',
    default_effort: 'medium',
  };

  // 1. Guarded when busy
  const busyResult = decideProfileSelection(profile, { isBusy: true, isChangingProfile: false });
  assert.strictEqual(busyResult.shouldProceed, false);
  assert.strictEqual(busyResult.selected, null);

  // 2. Guarded when changing profile
  const changingResult = decideProfileSelection(profile, { isBusy: false, isChangingProfile: true });
  assert.strictEqual(changingResult.shouldProceed, false);
  assert.strictEqual(changingResult.selected, null);

  // 3. Allowed when idle: passes exact ProfileSummary object
  const allowedResult = decideProfileSelection(profile, { isBusy: false, isChangingProfile: false });
  assert.strictEqual(allowedResult.shouldProceed, true);
  assert.strictEqual(allowedResult.selected, profile);
  assert.strictEqual(allowedResult.selected?.default_model, 'openrouter/anthropic/claude-3.5-sonnet');

  // 4. Allowed when clearing (null choice)
  const clearResult = decideProfileSelection(null, { isBusy: false, isChangingProfile: false });
  assert.strictEqual(clearResult.shouldProceed, true);
  assert.strictEqual(clearResult.selected, null);
});

test('PromptControls: renders with ProfileSummary objects and respects profile props', () => {
  const profile: ProfileSummary = {
    name: 'research-profile',
    scope: 'global',
    agent_count: 1,
    is_active: false,
    default_model: 'anthropic/claude-3.5-sonnet',
    default_effort: 'high',
  };

  let selectedResult: ProfileSummary | null | undefined = undefined;
  const handleSelect = (p: ProfileSummary | null) => {
    selectedResult = p;
  };

  const html = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      profiles: [profile],
      activeProfileName: profile.name,
      effectiveScope: 'global',
      onSelectProfile: handleSelect,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.ok(html.includes('research-profile'));
  assert.ok(html.includes('prompt-control-btn profile-btn'));

  handleSelect(profile);
  assert.strictEqual(selectedResult, profile);
});

test('PromptControls: renders brain emote and project name when engramProject is provided', () => {
  const html = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'my-engram-app',
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.ok(html.includes('engram-project-badge'), 'Expected badge class in markup');
  assert.ok(html.includes('🧠'), 'Expected brain emote in markup');
  assert.ok(html.includes('my-engram-app'), 'Expected project name in markup');
  assert.ok(html.includes('title="Engram: my-engram-app"'), 'Expected title attribute');
  assert.ok(html.includes('aria-label="Engram: my-engram-app"'), 'Expected aria-label');
});

test('PromptControls: does NOT render engram-project-badge when engramProject is null or omitted', () => {
  const htmlNull = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: null,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.strictEqual(htmlNull.includes('engram-project-badge'), false);
  assert.strictEqual(htmlNull.includes('🧠'), false);

  const htmlOmitted = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.strictEqual(htmlOmitted.includes('engram-project-badge'), false);
  assert.strictEqual(htmlOmitted.includes('🧠'), false);
});

test('bridge: getEngramProjectPi handles successful invoke, null project, and invoke errors safely', async () => {
  const mockInvokeSuccess = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    assert.strictEqual(cmd, 'get_engram_project');
    assert.strictEqual((args as { cwd?: string })?.cwd, '/test/path');
    return 'pi-viewer' as unknown as T;
  };
  const result = await getEngramProjectPi('/test/path', mockInvokeSuccess);
  assert.strictEqual(result, 'pi-viewer');

  const mockInvokeNull = async <T>(): Promise<T> => {
    return null as unknown as T;
  };
  const nullResult = await getEngramProjectPi('/test/path', mockInvokeNull);
  assert.strictEqual(nullResult, null);

  const mockInvokeThrow = async <T>(): Promise<T> => {
    throw new Error('Engram binary not found');
  };
  const errorResult = await getEngramProjectPi('/test/path', mockInvokeThrow);
  assert.strictEqual(errorResult, null);

  const mockInvokeUndefined = async <T>(): Promise<T> => {
    return undefined as unknown as T;
  };
  const undefinedResult = await getEngramProjectPi('/test/path', mockInvokeUndefined);
  assert.strictEqual(undefinedResult, null);
});

test('PromptControls: renders lightning bolt (⚡) for reasoning effort instead of brain emoji', () => {
  const modelWithReasoning: ModelInfo = {
    id: 'o3-mini',
    name: 'o3-mini',
    provider: 'openai',
    reasoning: true,
  };

  const html = renderToStaticMarkup(
    React.createElement(PromptControls, {
      modelInfo: modelWithReasoning,
      availableModels: [modelWithReasoning],
      isChangingModel: false,
      thinkingLevel: 'medium',
      availableThinkingLevels: ['low', 'medium', 'high'],
      sessionStats: null,
      isConnected: true,
      isBusy: false,
      onSelectModel: async () => {},
      onSelectThinkingLevel: async () => {},
      engramProject: null,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  // The thinking button must contain the lightning bolt
  assert.ok(html.includes('thinking-btn'), 'Expected thinking-btn in markup');
  assert.ok(html.includes('⚡'), 'Expected lightning bolt (⚡) emote in markup for reasoning effort');
  // Brain emote must NOT be present when engramProject is null, even with reasoning enabled
  assert.strictEqual(
    html.includes('🧠'),
    false,
    'Brain emote (🧠) must be solely reserved for Engram project badge'
  );
});

test('bridge: getEngramCloudStatusPi handles successful invoke, null, and errors safely', async () => {
  const mockStatus: EngramCloudStatus = {
    configured: true,
    serverUrl: 'https://engram.myshortener.xyz/',
    authReady: true,
    enrolled: true,
    daemonRunning: true,
    daemonPort: 7437,
    phase: 'synced',
    lastSyncAt: '2026-03-30T10:00:00Z',
    lastError: null,
    reasonCode: null,
    rawDetails: 'Cloud status: configured',
  };

  const mockInvokeSuccess = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    assert.strictEqual(cmd, 'get_engram_cloud_status');
    assert.strictEqual((args as { project?: string })?.project, 'pi-viewer');
    assert.strictEqual((args as { cwd?: string })?.cwd, '/test/path');
    return mockStatus as unknown as T;
  };
  const result = await getEngramCloudStatusPi('pi-viewer', '/test/path', mockInvokeSuccess);
  assert.deepStrictEqual(result, mockStatus);

  const mockInvokeNull = async <T>(): Promise<T> => {
    return null as unknown as T;
  };
  const nullResult = await getEngramCloudStatusPi('pi-viewer', '/test/path', mockInvokeNull);
  assert.strictEqual(nullResult, null);

  const mockInvokeThrow = async <T>(): Promise<T> => {
    throw new Error('engram not installed');
  };
  const errorResult = await getEngramCloudStatusPi('pi-viewer', '/test/path', mockInvokeThrow);
  assert.strictEqual(errorResult, null);

  const mockInvokeUndefined = async <T>(): Promise<T> => {
    return undefined as unknown as T;
  };
  const undefinedResult = await getEngramCloudStatusPi('pi-viewer', '/test/path', mockInvokeUndefined);
  assert.strictEqual(undefinedResult, null);
});

test('PromptControls: renders engram cloud indicator dot with enrolled class when enrolled', () => {
  const cloudStatus: EngramCloudStatus = {
    configured: true,
    serverUrl: 'https://engram.myshortener.xyz/',
    authReady: true,
    enrolled: true,
    daemonRunning: true,
    daemonPort: 7437,
    phase: 'synced',
    lastSyncAt: '2026-03-30T10:00:00Z',
    lastError: null,
    reasonCode: null,
    rawDetails: null,
  };

  const html = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'test-app',
      cloudStatus,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  // Badge button
  assert.ok(html.includes('engram-project-badge'), 'Expected engram-project-badge in markup');
  assert.ok(html.includes('engram-cloud-dot'), 'Expected dot indicator when configured');
  assert.ok(html.includes('enrolled'), 'Expected enrolled class on dot indicator');
  assert.ok(html.includes('🧠'), 'Expected brain emoji for engram project');
});

test('PromptControls: renders engram cloud indicator dot with configured class when not enrolled', () => {
  const cloudStatus: EngramCloudStatus = {
    configured: true,
    serverUrl: 'https://engram.myshortener.xyz/',
    authReady: true,
    enrolled: false,
    daemonRunning: false,
    daemonPort: null,
    phase: null,
    lastSyncAt: null,
    lastError: null,
    reasonCode: null,
    rawDetails: null,
  };

  const html = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'test-app',
      cloudStatus,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.ok(html.includes('engram-cloud-dot configured'), 'Expected configured class on dot indicator');
});

test('bridge: enrollEngramProjectPi invokes enroll_engram_project via mock invoke and handles errors safely', async () => {
  // Preview / non-Tauri with defaultInvoke returns false without throwing
  const previewResult = await enrollEngramProjectPi('my-project', '/test/path');
  assert.strictEqual(previewResult, false);

  // Successful enrollment via mock invoke
  let invokedCmd = '';
  let invokedArgs: unknown = null;
  const mockInvokeSuccess = async <T>(cmd: string, args?: unknown): Promise<T> => {
    invokedCmd = cmd;
    invokedArgs = args;
    return true as unknown as T;
  };
  const successResult = await enrollEngramProjectPi('test-project', '/custom/cwd', mockInvokeSuccess);
  assert.strictEqual(invokedCmd, 'enroll_engram_project');
  assert.deepStrictEqual(invokedArgs, { project: 'test-project', cwd: '/custom/cwd' });
  assert.strictEqual(successResult, true);

  // Failed enrollment returns false without throwing
  const mockInvokeFail = async <T>(): Promise<T> => {
    throw new Error('Command failed: unauthorized');
  };
  const failResult = await enrollEngramProjectPi('test-project', undefined, mockInvokeFail);
  assert.strictEqual(failResult, false);

  const mockInvokeFalse = async <T>(): Promise<T> => {
    return false as unknown as T;
  };
  const falseResult = await enrollEngramProjectPi('test-project', undefined, mockInvokeFalse);
  assert.strictEqual(falseResult, false);
});

test('PromptControls: engram cloud refresh button applies spinning animation only to icon and not button frame', () => {
  // When checking cloud is in flight
  const htmlChecking = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'test-app',
      cloudStatus: null,
      isCheckingCloud: true,
      defaultCloudPopoverOpen: true,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  // Icon has spinning class
  assert.ok(htmlChecking.includes('engram-refresh-icon spinning'), 'Expected engram-refresh-icon spinning in markup');
  // Button frame does NOT have spinning class
  assert.ok(htmlChecking.includes('class="engram-refresh-btn"'), 'Expected engram-refresh-btn without spinning class');
  assert.strictEqual(htmlChecking.includes('engram-refresh-btn spinning'), false, 'Button should not have spinning class');

  // When checking cloud is idle
  const htmlIdle = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'test-app',
      cloudStatus: null,
      isCheckingCloud: false,
      defaultCloudPopoverOpen: true,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.ok(htmlIdle.includes('engram-refresh-icon'), 'Expected engram-refresh-icon in markup');
  assert.strictEqual(htmlIdle.includes('spinning'), false, 'Should not contain spinning class when idle');
});

test('PromptControls: renders enroll button badge when enrolled is false and normal badge when enrolled is true', () => {
  const unenrolledStatus: EngramCloudStatus = {
    configured: true,
    serverUrl: 'https://engram.myshortener.xyz/',
    authReady: true,
    enrolled: false,
    daemonRunning: true,
    daemonPort: 7437,
    phase: null,
    lastSyncAt: null,
    lastError: null,
    reasonCode: null,
    rawDetails: null,
  };

  const htmlUnenrolled = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'test-app',
      cloudStatus: unenrolledStatus,
      defaultCloudPopoverOpen: true,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.ok(htmlUnenrolled.includes('engram-enroll-trigger'), 'Expected engram-enroll-trigger button class in markup');
  assert.ok(htmlUnenrolled.includes('No inscrito (+ Inscribir)'), 'Expected un-enrolled prompt badge text');

  const enrolledStatus: EngramCloudStatus = {
    ...unenrolledStatus,
    enrolled: true,
  };

  const htmlEnrolled = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'test-app',
      cloudStatus: enrolledStatus,
      defaultCloudPopoverOpen: true,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.strictEqual(htmlEnrolled.includes('engram-enroll-trigger'), false, 'Should not have enroll trigger button when enrolled');
  assert.ok(htmlEnrolled.includes('Inscrito'), 'Expected regular Inscrito badge text');
});

test('PromptControls: renders in-container confirmation box when showEnrollConfirm is true', () => {
  const htmlConfirm = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'super-proj',
      defaultCloudPopoverOpen: true,
      defaultEnrollConfirmOpen: true,
      isEnrolling: false,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.ok(htmlConfirm.includes('engram-confirm-box'), 'Expected engram-confirm-box in markup');
  assert.ok(
    htmlConfirm.includes('¿Inscribir super-proj en Engram Cloud para sincronización?'),
    'Expected project confirmation prompt'
  );
  assert.ok(htmlConfirm.includes('btn-engram-confirm'), 'Expected confirm button');
  assert.ok(htmlConfirm.includes('Confirmar e Inscribir'), 'Expected confirm button label');
  assert.ok(htmlConfirm.includes('btn-engram-cancel'), 'Expected cancel button');
  assert.ok(htmlConfirm.includes('Cancelar'), 'Expected cancel button label');

  // Loading / isEnrolling state
  const htmlEnrolling = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'super-proj',
      defaultCloudPopoverOpen: true,
      defaultEnrollConfirmOpen: true,
      isEnrolling: true,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.ok(htmlEnrolling.includes('Inscribiendo...'), 'Expected loading label when enrolling');
  assert.ok(htmlEnrolling.includes('disabled'), 'Expected disabled attribute on confirm button');
});

test('PromptControls: renders Permisos Cloud row with Permitido when cloudPermitted is true', () => {
  const cloudStatus: EngramCloudStatus = {
    configured: true,
    serverUrl: 'https://engram.myshortener.xyz/',
    authReady: true,
    enrolled: true,
    daemonRunning: true,
    daemonPort: 7437,
    cloudPermitted: true,
    cloudPermissionMessage: 'Sincronización permitida en el servidor',
  };

  const html = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'test-app',
      cloudStatus,
      defaultCloudPopoverOpen: true,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.ok(html.includes('Permisos Cloud:'), 'Expected Permisos Cloud row label');
  assert.ok(html.includes('Permitido'), 'Expected Permitido text');
  assert.ok(html.includes('status-ok'), 'Expected status-ok class');
  assert.strictEqual(html.includes('engram-permission-alert'), false, 'Should not render alert when permitted');
});

test('PromptControls: renders Permisos Cloud row with No permitido (403) and displays .engram-permission-alert when cloudPermitted is false', () => {
  const cloudStatus: EngramCloudStatus = {
    configured: true,
    serverUrl: 'https://engram.myshortener.xyz/',
    authReady: true,
    enrolled: true,
    daemonRunning: true,
    daemonPort: 7437,
    cloudPermitted: false,
    cloudPermissionMessage: 'Acceso denegado por política del servidor (403 Forbidden). Verifique ENGRAM_CLOUD_ALLOWED_PROJECTS en el servidor Cloud.',
  };

  const html = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'test-app',
      cloudStatus,
      defaultCloudPopoverOpen: true,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.ok(html.includes('Permisos Cloud:'), 'Expected Permisos Cloud row label');
  assert.ok(html.includes('No permitido (403)'), 'Expected No permitido (403) text');
  assert.ok(html.includes('status-error'), 'Expected status-error class');
  assert.ok(html.includes('engram-permission-alert'), 'Expected engram-permission-alert class');
  assert.ok(html.includes('⚠️ Proyecto no permitido en el servidor'), 'Expected alert title');
  assert.ok(
    html.includes('Acceso denegado por política del servidor (403 Forbidden). Verifique ENGRAM_CLOUD_ALLOWED_PROJECTS en el servidor Cloud.'),
    'Expected alert desc message'
  );
});

test('PromptControls: renders engram-cloud-dot.forbidden when enrolled is true but cloudPermitted is false', () => {
  const cloudStatus: EngramCloudStatus = {
    configured: true,
    serverUrl: 'https://engram.myshortener.xyz/',
    authReady: true,
    enrolled: true,
    daemonRunning: true,
    daemonPort: 7437,
    cloudPermitted: false,
    cloudPermissionMessage: 'Forbidden',
  };

  const html = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'test-app',
      cloudStatus,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.ok(html.includes('engram-cloud-dot forbidden'), 'Expected engram-cloud-dot forbidden class');
  assert.strictEqual(html.includes('engram-cloud-dot enrolled'), false, 'Should not have enrolled class when forbidden');
});

test('bridge: getEngramCloudStatusPi roundtrips cloudPermitted and cloudPermissionMessage', async () => {
  const mockStatus: EngramCloudStatus = {
    configured: true,
    serverUrl: 'https://engram.myshortener.xyz/',
    authReady: true,
    enrolled: true,
    daemonRunning: true,
    daemonPort: 7437,
    cloudPermitted: false,
    cloudPermissionMessage: 'Acceso denegado por política del servidor (403 Forbidden). Verifique ENGRAM_CLOUD_ALLOWED_PROJECTS en el servidor Cloud.',
  };

  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    assert.strictEqual(cmd, 'get_engram_cloud_status');
    assert.strictEqual((args as { project?: string })?.project, 'my-proj');
    return mockStatus as unknown as T;
  };

  const res = await getEngramCloudStatusPi('my-proj', undefined, mockInvoke);
  assert.ok(res !== null);
  assert.strictEqual(res.cloudPermitted, false);
  assert.strictEqual(
    res.cloudPermissionMessage,
    'Acceso denegado por política del servidor (403 Forbidden). Verifique ENGRAM_CLOUD_ALLOWED_PROJECTS en el servidor Cloud.'
  );
});

test('PromptControls: does not render .engram-error-block and renders .engram-permission-alert when reasonCode is policy_forbidden', () => {
  const cloudStatus: EngramCloudStatus = {
    configured: true,
    serverUrl: 'https://engram.myshortener.xyz/',
    authReady: true,
    enrolled: true,
    daemonRunning: true,
    daemonPort: 7437,
    reasonCode: 'policy_forbidden',
    cloudPermitted: false,
    cloudPermissionMessage: 'Acceso denegado por política del servidor (403 Forbidden). Verifique ENGRAM_CLOUD_ALLOWED_PROJECTS en el servidor Cloud.',
  };

  const html = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'test-app',
      cloudStatus,
      defaultCloudPopoverOpen: true,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.strictEqual(html.includes('engram-error-block'), false, 'Should not render .engram-error-block when policy_forbidden');
  assert.strictEqual(html.includes('Error: policy_forbidden'), false, 'Should omit Error: policy_forbidden message');
  assert.ok(html.includes('engram-permission-alert'), 'Expected engram-permission-alert in markup');
  assert.ok(html.includes('⚠️ Proyecto no permitido en el servidor'), 'Expected alert title');
  assert.ok(
    html.includes('Acceso denegado por política del servidor (403 Forbidden). Verifique ENGRAM_CLOUD_ALLOWED_PROJECTS en el servidor Cloud.'),
    'Expected cloudPermissionMessage in alert description'
  );
});

test('PromptControls: renders .engram-error-block with error code and message and does not render .engram-permission-alert for ordinary error', () => {
  const cloudStatus: EngramCloudStatus = {
    configured: true,
    serverUrl: 'https://engram.myshortener.xyz/',
    authReady: true,
    enrolled: true,
    daemonRunning: true,
    daemonPort: 7437,
    reasonCode: 'network_timeout',
    lastError: 'Connection refused',
    cloudPermitted: null,
  };

  const html = renderToStaticMarkup(
    React.createElement(PromptControls, {
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
      engramProject: 'test-app',
      cloudStatus,
      defaultCloudPopoverOpen: true,
      t: (k: string) => (enJson as Record<string, string>)[k] || k,
    })
  );

  assert.ok(html.includes('engram-error-block'), 'Expected engram-error-block in markup for ordinary error');
  assert.ok(html.includes('engram-error-code'), 'Expected engram-error-code in markup');
  assert.ok(html.includes('network_timeout'), 'Expected reasonCode network_timeout in error block');
  assert.ok(html.includes('engram-error-message'), 'Expected engram-error-message in markup');
  assert.ok(html.includes('Connection refused'), 'Expected lastError message in error block');
  assert.strictEqual(html.includes('engram-permission-alert'), false, 'Should not render .engram-permission-alert for ordinary error');
});

test('prompt-controls-utils: isContextHighUsage returns false for values below threshold (<70) and true for >= 70', () => {
  assert.strictEqual(HIGH_CONTEXT_PERCENT_THRESHOLD, 70);

  // Values < 70, non-positive, null, undefined, NaN return false
  assert.strictEqual(isContextHighUsage(null), false);
  assert.strictEqual(isContextHighUsage(undefined), false);
  assert.strictEqual(isContextHighUsage(NaN), false);
  assert.strictEqual(isContextHighUsage(-10), false);
  assert.strictEqual(isContextHighUsage(0), false);
  assert.strictEqual(isContextHighUsage(25), false);
  assert.strictEqual(isContextHighUsage(50), false);
  assert.strictEqual(isContextHighUsage(69), false);
  assert.strictEqual(isContextHighUsage(69.9), false);

  // Values >= 70 return true
  assert.strictEqual(isContextHighUsage(70), true);
  assert.strictEqual(isContextHighUsage(70.0), true);
  assert.strictEqual(isContextHighUsage(70.1), true);
  assert.strictEqual(isContextHighUsage(85), true);
  assert.strictEqual(isContextHighUsage(99.9), true);
  assert.strictEqual(isContextHighUsage(100), true);
  assert.strictEqual(isContextHighUsage(120), true);
});

test('prompt-controls-utils: calculateContextMetrics calculates metrics with tokens/window, explicit percent, and null cases', () => {
  // 1. Null / undefined cases
  const emptyMetrics = calculateContextMetrics(null, null, []);
  assert.deepStrictEqual(emptyMetrics, {
    contextTokens: 0,
    contextWindow: 0,
    usagePercent: 0,
    isHighContext: false,
  });

  const undefinedMetrics = calculateContextMetrics(undefined, undefined, undefined);
  assert.deepStrictEqual(undefinedMetrics, {
    contextTokens: 0,
    contextWindow: 0,
    usagePercent: 0,
    isHighContext: false,
  });

  // 2. Calculation with tokens/window from modelInfo and availableModels
  const model: ModelInfo = {
    id: 'claude-3-5-sonnet',
    provider: 'anthropic',
    name: 'Claude 3.5 Sonnet',
    contextWindow: 100000,
  };
  const statsUnderThreshold = {
    tokens: { total: 50000, input: 30000, output: 20000 },
  };
  const metricsUnder = calculateContextMetrics(statsUnderThreshold, model, [model]);
  assert.strictEqual(metricsUnder.contextTokens, 50000);
  assert.strictEqual(metricsUnder.contextWindow, 100000);
  assert.strictEqual(metricsUnder.usagePercent, 50);
  assert.strictEqual(metricsUnder.isHighContext, false);

  // Exactly at 70% threshold
  const statsAtThreshold = {
    tokens: { total: 70000, input: 50000, output: 20000 },
  };
  const metricsAt = calculateContextMetrics(statsAtThreshold, model, [model]);
  assert.strictEqual(metricsAt.contextTokens, 70000);
  assert.strictEqual(metricsAt.contextWindow, 100000);
  assert.strictEqual(metricsAt.usagePercent, 70);
  assert.strictEqual(metricsAt.isHighContext, true);

  // Above 70% threshold (e.g. 85%)
  const statsAboveThreshold = {
    tokens: { total: 85000, input: 60000, output: 25000 },
  };
  const metricsAbove = calculateContextMetrics(statsAboveThreshold, model, [model]);
  assert.strictEqual(metricsAbove.contextTokens, 85000);
  assert.strictEqual(metricsAbove.contextWindow, 100000);
  assert.strictEqual(metricsAbove.usagePercent, 85);
  assert.strictEqual(metricsAbove.isHighContext, true);

  // 3. Explicit percent in contextUsage
  const statsWithExplicitPercent = {
    tokens: { total: 40000, input: 20000, output: 20000 },
    contextUsage: {
      tokens: 72000,
      contextWindow: 100000,
      percent: 72,
    },
  };
  const metricsExplicit = calculateContextMetrics(statsWithExplicitPercent, model, [model]);
  assert.strictEqual(metricsExplicit.contextTokens, 72000);
  assert.strictEqual(metricsExplicit.contextWindow, 100000);
  assert.strictEqual(metricsExplicit.usagePercent, 72);
  assert.strictEqual(metricsExplicit.isHighContext, true);

  // Explicit percent below threshold in contextUsage
  const statsExplicitLow = {
    contextUsage: {
      tokens: 20000,
      contextWindow: 100000,
      percent: 20,
    },
  };
  const metricsExplicitLow = calculateContextMetrics(statsExplicitLow, model, [model]);
  assert.strictEqual(metricsExplicitLow.contextTokens, 20000);
  assert.strictEqual(metricsExplicitLow.contextWindow, 100000);
  assert.strictEqual(metricsExplicitLow.usagePercent, 20);
  assert.strictEqual(metricsExplicitLow.isHighContext, false);
});

test('PromptControls: stats-btn includes context-pulse-red when context is >= 70% and omits it when < 70%', () => {
  const model: ModelInfo = {
    id: 'gpt-4o',
    provider: 'openai',
    name: 'GPT-4o',
    contextWindow: 100000,
  };

  // Case 1: context < 70% (50%) -> should NOT include context-pulse-red
  const statsLow = {
    tokens: { total: 50000, input: 30000, output: 20000 },
  };
  const htmlLow = renderToStaticMarkup(
    React.createElement(PromptControls, {
      modelInfo: model,
      availableModels: [model],
      isChangingModel: false,
      thinkingLevel: null,
      availableThinkingLevels: [],
      sessionStats: statsLow,
      isConnected: true,
      isBusy: false,
      onSelectModel: async () => {},
      onSelectThinkingLevel: async () => {},
      t: (k: string) => k,
    })
  );
  assert.ok(htmlLow.includes('stats-btn'), 'Expected stats-btn in markup');
  assert.strictEqual(
    htmlLow.includes('context-pulse-red'),
    false,
    'Expected context-pulse-red to NOT be present when usage is < 70%'
  );

  // Case 2: context >= 70% (70%) -> should include context-pulse-red on stats-btn
  const statsHigh = {
    tokens: { total: 70000, input: 40000, output: 30000 },
  };
  const htmlHigh = renderToStaticMarkup(
    React.createElement(PromptControls, {
      modelInfo: model,
      availableModels: [model],
      isChangingModel: false,
      thinkingLevel: null,
      availableThinkingLevels: [],
      sessionStats: statsHigh,
      isConnected: true,
      isBusy: false,
      onSelectModel: async () => {},
      onSelectThinkingLevel: async () => {},
      t: (k: string) => k,
    })
  );
  assert.ok(htmlHigh.includes('stats-btn'), 'Expected stats-btn in markup');
  assert.ok(
    htmlHigh.includes('context-pulse-red'),
    'Expected context-pulse-red to be present when usage is >= 70%'
  );

  // Case 3: explicit isHighContext prop override = true
  const htmlPropOverrideTrue = renderToStaticMarkup(
    React.createElement(PromptControls, {
      modelInfo: model,
      availableModels: [model],
      isChangingModel: false,
      thinkingLevel: null,
      availableThinkingLevels: [],
      sessionStats: statsLow,
      isHighContext: true,
      isConnected: true,
      isBusy: false,
      onSelectModel: async () => {},
      onSelectThinkingLevel: async () => {},
      t: (k: string) => k,
    })
  );
  assert.ok(
    htmlPropOverrideTrue.includes('context-pulse-red'),
    'Expected context-pulse-red when isHighContext prop is explicitly true'
  );

  // Case 4: explicit isHighContext prop override = false
  const htmlPropOverrideFalse = renderToStaticMarkup(
    React.createElement(PromptControls, {
      modelInfo: model,
      availableModels: [model],
      isChangingModel: false,
      thinkingLevel: null,
      availableThinkingLevels: [],
      sessionStats: statsHigh,
      isHighContext: false,
      isConnected: true,
      isBusy: false,
      onSelectModel: async () => {},
      onSelectThinkingLevel: async () => {},
      t: (k: string) => k,
    })
  );
  assert.strictEqual(
    htmlPropOverrideFalse.includes('context-pulse-red'),
    false,
    'Expected context-pulse-red to NOT be present when isHighContext prop is explicitly false'
  );
});

test('buildInsertCodeDraft: wraps code in a fenced block tagged with the language', () => {
  assert.strictEqual(
    buildInsertCodeDraft('', 'const x = 1;', 'typescript'),
    '```typescript\nconst x = 1;\n```'
  );
});

test('buildInsertCodeDraft: omits the language tag when none is provided', () => {
  assert.strictEqual(buildInsertCodeDraft('', 'plain snippet'), '```\nplain snippet\n```');
});

test('buildInsertCodeDraft: appends to a non-empty draft with a separating blank line', () => {
  assert.strictEqual(
    buildInsertCodeDraft('please review this:', 'a();', 'js'),
    'please review this:\n\n```js\na();\n```'
  );
});

test('buildInsertCodeDraft: treats a whitespace-only draft as empty (no leading blank line)', () => {
  assert.strictEqual(buildInsertCodeDraft('   \n  ', 'a();', 'js'), '```js\na();\n```');
});






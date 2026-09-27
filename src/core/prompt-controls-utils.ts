import type { ChatMessage } from './types/messages';
import type { ModelInfo, SessionStats } from './types/models';

/**
 * Pure utility functions for Prompt Box Controls:
 * - Token count formatting (e.g. 850, 14.2k, 1.25M)
 * - Context window usage level classification (normal, warning, critical)
 * - Cost formatting
 * - Context window percentage formatting
 * - Context metrics calculation & high-usage (>=70%) threshold detection
 */

/**
 * Threshold percentage at or above which the context window is considered high/critical
 * and triggers visual red pulsing alerts across the prompt controls and input.
 */
export const HIGH_CONTEXT_PERCENT_THRESHOLD = 70;

/**
 * Returns true if context saturation percentage is at or above the high context threshold (>= 70%).
 */
export function isContextHighUsage(percent: number | null | undefined): boolean {
  if (percent == null || isNaN(percent) || percent <= 0) {
    return false;
  }
  return percent >= HIGH_CONTEXT_PERCENT_THRESHOLD;
}

export interface ContextMetrics {
  contextTokens: number;
  contextWindow: number;
  usagePercent: number;
  isHighContext: boolean;
}

/**
 * Pure calculation of context window usage metrics (tokens, total window limit, percentage, and high alert flag).
 */
export function calculateContextMetrics(
  sessionStats?: SessionStats | null,
  modelInfo?: ModelInfo | null,
  availableModels?: ModelInfo[]
): ContextMetrics {
  const contextTokens = sessionStats
    ? (sessionStats.contextUsage?.tokens ?? sessionStats.tokens?.total ?? 0)
    : 0;

  const activeModelId = modelInfo?.id || '';
  const matchedModel = availableModels?.find(
    (m) => m.id === activeModelId && (m.provider === modelInfo?.provider || !modelInfo?.provider)
  );
  const effectiveModel = matchedModel
    ? {
        ...matchedModel,
        ...modelInfo,
        input_modalities: modelInfo?.input_modalities ?? matchedModel.input_modalities,
      }
    : modelInfo;

  const modelLimit = effectiveModel?.contextWindow ?? matchedModel?.contextWindow;
  const contextWindow = modelLimit ?? sessionStats?.contextUsage?.contextWindow ?? 0;

  const usagePercent =
    !sessionStats
      ? 0
      : sessionStats.contextUsage?.percent != null
        ? sessionStats.contextUsage.percent
        : contextWindow > 0
          ? Math.round((contextTokens / contextWindow) * 100 * 10) / 10
          : 0;

  const isHighContext = isContextHighUsage(usagePercent);

  return {
    contextTokens,
    contextWindow,
    usagePercent,
    isHighContext,
  };
}

/**
 * Format token count with compact suffix (e.g. 850, 12.4k, 1.2M).
 */
export function formatTokens(count: number | null | undefined): string {
  if (count == null || isNaN(count) || count <= 0) {
    return '0';
  }
  if (count < 1000) {
    return String(Math.round(count));
  }
  if (count < 1000000) {
    const k = (count / 1000).toFixed(1).replace(/\.0$/, '');
    return `${k}k`;
  }
  const m = (count / 1000000).toFixed(2).replace(/\.00$/, '');
  return `${m}M`;
}

/**
 * Categorize context window saturation percentage into visual levels:
 * - normal: < 60%
 * - warning: 60% - 84.9%
 * - critical: >= 85%
 */
export function getContextUsageLevel(
  percent: number | null | undefined
): 'normal' | 'warning' | 'critical' {
  if (percent == null || isNaN(percent) || percent <= 0) {
    return 'normal';
  }
  if (percent >= 85) {
    return 'critical';
  }
  if (percent >= 60) {
    return 'warning';
  }
  return 'normal';
}

/**
 * Format currency cost concisely.
 */
export function formatCost(cost: number | null | undefined): string {
  if (cost == null || isNaN(cost) || cost <= 0) {
    return '$0.00';
  }
  if (cost < 0.01) {
    return '<$0.01';
  }
  return `$${cost.toFixed(2)}`;
}

/**
 * Format context usage percentage with 2 decimal places (e.g. 14.85, 0.00).
 */
export function formatPercent(percent: number | null | undefined): string {
  if (percent == null || isNaN(percent) || percent <= 0) {
    return '0.00';
  }
  return Number(percent).toFixed(2);
}

/**
 * Generate a unique cache key for a model's statistics: `provider/id`.
 * Returns `${model.provider || ''}/${model.id || ''}` if model exists with provider or id, else ''.
 */
export function getModelStatsKey(model: ModelInfo | null | undefined): string {
  if (!model || (!model.provider && !model.id)) {
    return '';
  }
  return `${model.provider || ''}/${model.id || ''}`;
}

export interface DoubleEscCancelOptions {
  isBusy: boolean;
  isConfirming: boolean;
  hasOpenOverlay: boolean;
  onConfirmStart: () => void;
  onAbort: () => void;
}

/**
 * Pure handler for Escape key events to cancel in-flight prompt response generation:
 * - If event.key !== 'Escape', return false.
 * - If !options.isBusy || options.hasOpenOverlay, return false.
 * - Call event.preventDefault?.().
 * - If !options.isConfirming, call options.onConfirmStart() and return false.
 * - If options.isConfirming, call options.onAbort() and return true.
 */
export function handleDoubleEscCancel(
  event: { key: string; preventDefault?: () => void },
  options: DoubleEscCancelOptions
): boolean {
  if (event.key !== 'Escape') {
    return false;
  }
  if (!options.isBusy || options.hasOpenOverlay) {
    return false;
  }
  event.preventDefault?.();
  if (!options.isConfirming) {
    options.onConfirmStart();
    return false;
  }
  options.onAbort();
  return true;
}

/**
 * Check if a chat message is an assistant message with no meaningful content
 * (no non-empty text, no non-empty thinking blocks, and no tool calls).
 * Returns false for non-assistant or null/undefined messages.
 */
export function isMessageEmpty(msg: ChatMessage | null | undefined): boolean {
  if (!msg || msg.role !== 'assistant') {
    return false;
  }
  if (msg.content && msg.content.trim().length > 0) {
    return false;
  }
  if (msg.blocks && msg.blocks.length > 0) {
    for (const block of msg.blocks) {
      if (block.type === 'text' && block.text.trim().length > 0) {
        return false;
      }
      if (block.type === 'thinking' && block.thinking.trim().length > 0) {
        return false;
      }
      if (block.type === 'tool_call') {
        return false;
      }
    }
  }
  return true;
}

/**
 * Builds the next prompt draft after inserting a code snippet: wraps `code` in a fenced
 * block tagged with `language` (empty when not provided), appending it to `currentDraft`
 * with a separating blank line when the draft is non-empty (Issue #7's "Insert into
 * prompt" code-card button and the Alt+I global shortcut).
 */
export function buildInsertCodeDraft(currentDraft: string, code: string, language?: string): string {
  const fence = '```' + (language ?? '') + '\n' + code + '\n```';
  return currentDraft.trim().length > 0 ? `${currentDraft}\n\n${fence}` : fence;
}

export type FileAttachmentCategory = 'image' | 'video' | 'audio' | 'code' | 'all';

/**
 * Check if a model supports sending images or files based on input_modalities or input array:
 * - Returns false if model is null/undefined
 * - Check modalities from model.input_modalities or fallback model.input
 * - If modalities is present, return true if any modality lowercased is 'image', 'video', 'audio', or 'file'
 * - Returns false otherwise (including for text-only ['text'])
 */
export function modelSupportsFiles(model?: ModelInfo | null): boolean {
  if (!model) {
    return false;
  }
  const modalities = model.input_modalities ?? model.input;
  if (!modalities || !Array.isArray(modalities)) {
    return false;
  }
  return modalities.some((m) => {
    const lower = typeof m === 'string' ? m.toLowerCase() : '';
    return lower === 'image' || lower === 'video' || lower === 'audio' || lower === 'file';
  });
}

/**
 * Check whether a model supports the specified input modality (e.g. 'text', 'image', 'video', 'file', 'audio')
 * using model.input_modalities (with fallback model.input if input_modalities is not present), case-insensitively.
 * Returns false for null/undefined/missing models, missing modalities arrays, or empty modality string.
 */
export function modelSupportsInputModality(
  model: ModelInfo | null | undefined,
  modality: string
): boolean {
  if (!model || !modality || typeof modality !== 'string') {
    return false;
  }
  const target = modality.toLowerCase();
  const modalities = Array.isArray(model.input_modalities)
    ? model.input_modalities
    : Array.isArray(model.input)
      ? model.input
      : null;
  if (!modalities) {
    return false;
  }
  return modalities.some((m) => {
    const lower = typeof m === 'string' ? m.toLowerCase() : '';
    return lower === target;
  });
}

/**
 * Determine supported attachment categories for a model:
 * - If model is null/undefined, return []
 * - Check modalities from model.input_modalities or fallback model.input
 * - If neither is present, return ['image', 'code', 'all']
 * - Otherwise:
 *   - if modalities include 'image' -> push 'image'
 *   - if modalities include 'video' -> push 'video'
 *   - if modalities include 'audio' -> push 'audio'
 *   - if modalities include 'text' or 'file' -> push 'code'
 *   - if modalities include 'file' -> push 'all'
 *   return result
 */
export function getSupportedAttachmentCategories(
  model?: ModelInfo | null
): FileAttachmentCategory[] {
  if (!model) {
    return [];
  }
  const modalities = model.input_modalities ?? model.input;
  if (!modalities || !Array.isArray(modalities)) {
    return ['image', 'code', 'all'];
  }
  const lowerModalities = modalities.map((m) =>
    typeof m === 'string' ? m.toLowerCase() : ''
  );
  const result: FileAttachmentCategory[] = [];
  if (lowerModalities.includes('image')) {
    result.push('image');
  }
  if (lowerModalities.includes('video')) {
    result.push('video');
  }
  if (lowerModalities.includes('audio')) {
    result.push('audio');
  }
  if (lowerModalities.includes('text') || lowerModalities.includes('file')) {
    result.push('code');
  }
  if (lowerModalities.includes('file')) {
    result.push('all');
  }
  return result;
}



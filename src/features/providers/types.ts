import type { CustomModelDefinition } from '@core/types/providers';
import type { ThinkingLevel } from '@core/types/models';
import {
  buildStrictThinkingLevelMap,
  isModelAllowed,
  type SupportedApiProtocol,
} from './providers';

export interface ProviderFormData {
  id: string;
  name: string;
  baseUrl: string;
  api: SupportedApiProtocol | string;
  apiKey: string;
  models: CustomModelDefinition[];
  excludedModels: string[];
  includedModels: string[];
  isBuiltin?: boolean;
}

export const EMPTY_FORM: ProviderFormData = {
  id: '',
  name: '',
  baseUrl: '',
  api: 'openai-completions',
  apiKey: '',
  models: [],
  excludedModels: [],
  includedModels: [],
  isBuiltin: false,
};

export function buildDraftModel(
  id: string,
  name: string,
  contextStr: string,
  maxTokensStr: string,
  reasoning: boolean,
  supportsImage: boolean,
  thinkingLevel: ThinkingLevel,
  existingModel?: CustomModelDefinition
): CustomModelDefinition {
  const parsedCtx = contextStr.trim() ? parseInt(contextStr.trim(), 10) : undefined;
  const parsedMax = maxTokensStr.trim() ? parseInt(maxTokensStr.trim(), 10) : undefined;
  const efforts = existingModel?.reasoningEfforts || ['low', 'medium', 'high'];

  return {
    ...existingModel,
    id,
    name: name.trim() || undefined,
    contextWindow: parsedCtx && !isNaN(parsedCtx) ? parsedCtx : undefined,
    maxTokens: parsedMax && !isNaN(parsedMax) ? parsedMax : undefined,
    reasoning,
    input: supportsImage ? ['text', 'image'] : ['text'],
    ...(reasoning
      ? {
          reasoningEfforts: efforts,
          thinkingLevelMap: existingModel?.thinkingLevelMap || buildStrictThinkingLevelMap(efforts),
          thinkingLevel,
          defaultThinkingLevel: thinkingLevel,
        }
      : existingModel
        ? {
            reasoningEfforts: undefined,
            thinkingLevelMap: undefined,
            thinkingLevel: undefined,
            defaultThinkingLevel: undefined,
          }
        : {}),
  };
}

export function mergeDiscoveredModels(
  existingModels: CustomModelDefinition[],
  discovered: CustomModelDefinition[],
  excludedList: string[],
  includedList?: string[]
): CustomModelDefinition[] {
  const existingIds = new Set(existingModels.map((m) => m.id));
  const newModels = discovered.filter((m) => !existingIds.has(m.id));

  const updatedExisting = existingModels
    .filter((existing) =>
      isModelAllowed(existing.id, {
        includedModels: includedList,
        excludedModels: excludedList,
      })
    )
    .map((existing) => {
      const match = discovered.find((f) => f.id === existing.id);
      if (!match) return existing;
      return {
        ...match,
        ...existing,
        name: existing.name || match.name,
        contextWindow: existing.contextWindow ?? match.contextWindow,
        maxTokens: existing.maxTokens ?? match.maxTokens,
        reasoning: existing.reasoning ?? match.reasoning,
        input: existing.input ?? match.input,
        cost: existing.cost ?? match.cost,
        compat: existing.compat ?? match.compat,
        thinkingLevelMap: existing.thinkingLevelMap ?? match.thinkingLevelMap,
        reasoningEfforts: existing.reasoningEfforts ?? match.reasoningEfforts,
      };
    });

  return [...updatedExisting, ...newModels];
}

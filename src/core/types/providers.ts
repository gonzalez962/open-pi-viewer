import type { ThinkingLevel } from './models';

export interface CustomModelDefinition {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  input_modalities?: string[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  compat?: Record<string, boolean>;
  thinkingLevelMap?: Record<string, string | null>;
  reasoningEfforts?: string[];
  thinkingLevel?: ThinkingLevel;
  defaultThinkingLevel?: ThinkingLevel;
}

export interface CustomProviderConfig {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models: CustomModelDefinition[];
  excludedModels?: string[];
  includedModels?: string[];
  compat?: Record<string, unknown>;
  isBuiltin?: boolean;
}

export type CustomProvidersMap = Record<string, Omit<CustomProviderConfig, 'id'>>;

export interface ModelsConfigFile {
  providers?: CustomProvidersMap;
  modelOverrides?: Record<string, unknown>;
  [key: string]: unknown;
}

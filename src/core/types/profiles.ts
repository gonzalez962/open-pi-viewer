//! Profile and subagent types and pure utility functions.
//! Based on pi-sdd-profiles by CinloDev (https://github.com/CinloDev/).

import type { ModelInfo, ThinkingLevel } from './models';

export const REASONING_EFFORTS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const RESET_EFFORT_TOKENS = new Set([
  'default',
  'predeterminado',
  'heredar',
  'none',
  '-',
  'unset',
]);

/**
 * Normalizes reasoning effort string into a valid ReasoningEffort or undefined (default).
 */
export function parseReasoningEffort(
  value: unknown,
  strict = false
): ReasoningEffort | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    if (strict) {
      throw new Error(`Invalid effort value type: ${typeof value}`);
    }
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '' || RESET_EFFORT_TOKENS.has(normalized)) {
    return undefined;
  }

  if ((REASONING_EFFORTS as readonly string[]).includes(normalized)) {
    return normalized as ReasoningEffort;
  }

  if (strict) {
    throw new Error(
      `Invalid effort level: "${value}". Allowed: ${REASONING_EFFORTS.join(', ')}`
    );
  }

  return undefined;
}

export interface ModelProfileEntry {
  model: string;
  effort?: ReasoningEffort;
}

export interface Profile {
  name: string;
  description?: string;
  default_model?: string; // Orchestrator or default model
  default_effort?: ReasoningEffort;
  model_profiles: Record<string, ModelProfileEntry>;
  created_at?: string;
  updated_at?: string;
}

export type ProfileScope = 'global' | 'project';

export interface ProfileSummary {
  name: string;
  description?: string;
  default_model?: string;
  default_effort?: ReasoningEffort;
  agent_count: number;
  scope: ProfileScope;
  is_active: boolean;
  active_scope?: 'project' | 'global';
  path?: string;
  model_profiles?: Record<string, ModelProfileEntry>;
}

export interface AgentCategory {
  id: string;
  name: string;
  description: string;
  agents: string[];
}

export interface DiscoveredAgentMeta {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  scope?: ProfileScope;
  origin?: 'definition' | 'package' | 'config';
  packageName?: string;
}

/**
 * Sanitizes a category name into a slug/id.
 */
export function sanitizeCategoryId(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'general'
  );
}

/**
 * Parses agent Markdown YAML frontmatter safely, extracting only name, description,
 * category, and id when present. Discards prompt body and unrecognized secret fields.
 */
export function parseAgentMarkdownFrontmatter(
  content: string,
  fallbackId: string,
  scope?: ProfileScope,
  packageName?: string
): DiscoveredAgentMeta | null {
  if (typeof content !== 'string') return null;

  const trimmed = content.trim();
  let frontmatterBlock = '';

  if (trimmed.startsWith('---')) {
    const afterFirst = trimmed.slice(3);
    const endMatch = afterFirst.match(/\n\s*---\s*(\r?\n|$)/);
    if (endMatch && endMatch.index !== undefined) {
      frontmatterBlock = afterFirst.slice(0, endMatch.index);
    }
  }

  let id: string | undefined;
  let name: string | undefined;
  let description: string | undefined;
  let category: string | undefined;

  if (frontmatterBlock) {
    const lines = frontmatterBlock.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
      if (!match) continue;

      const key = match[1].trim().toLowerCase();
      let val = match[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1).trim();
      }

      if (key === 'id') {
        id = val;
      } else if (key === 'name') {
        name = val;
      } else if (key === 'description') {
        description = val;
      } else if (key === 'category') {
        category = val;
      }
    }
  }

  const effectiveId = (id || name || fallbackId || '').trim();
  if (!effectiveId || isSyntheticAgentKey(effectiveId)) {
    return null;
  }

  return {
    id: effectiveId,
    name: name || effectiveId,
    description: description || undefined,
    category: category || undefined,
    scope,
    origin: 'definition',
    packageName,
  };
}

/**
 * Builds dynamic agent categories from discovered agent definitions or configuration.
 * Uses explicit category metadata when available, package origin when applicable,
 * or prefix/scope grouping heuristics on discovered agents.
 * Omit empty categories and produces deterministic ordering.
 */
export function buildDynamicCategories(
  agents: Array<DiscoveredAgentMeta | string>
): AgentCategory[] {
  if (!agents || agents.length === 0) {
    return [];
  }

  const normalizedMap = new Map<string, DiscoveredAgentMeta>();

  for (const item of agents) {
    const meta: DiscoveredAgentMeta =
      typeof item === 'string' ? { id: item } : item;

    const id = meta.id?.trim();
    if (!id || isSyntheticAgentKey(id)) {
      continue;
    }

    if (!normalizedMap.has(id)) {
      normalizedMap.set(id, { ...meta, id });
    } else {
      const existing = normalizedMap.get(id)!;
      normalizedMap.set(id, {
        id,
        name: existing.name || meta.name,
        description: existing.description || meta.description,
        category: existing.category || meta.category,
        scope:
          existing.scope === 'project'
            ? 'project'
            : meta.scope || existing.scope,
        origin: existing.origin || meta.origin,
        packageName: existing.packageName || meta.packageName,
      });
    }
  }

  if (normalizedMap.size === 0) {
    return [];
  }

  const categoryMap = new Map<
    string,
    {
      id: string;
      name: string;
      description: string;
      priority: number;
      agents: string[];
    }
  >();

  for (const [id, meta] of normalizedMap.entries()) {
    let catId: string;
    let catName: string;
    let catDesc: string;
    let priority: number;

    const explicitCategory = meta.category?.trim();
    const pkgName = meta.packageName?.trim();

    if (explicitCategory) {
      catId = sanitizeCategoryId(explicitCategory);
      catName = explicitCategory;
      catDesc = `${explicitCategory} agents`;
      priority = 50;
    } else if (pkgName) {
      catId = `pkg-${sanitizeCategoryId(pkgName)}`;
      catName = pkgName;
      catDesc = `Agents provided by ${pkgName}`;
      priority = 60;
    } else if (id.startsWith('sdd-')) {
      catId = 'sdd-core';
      catName = 'Spec-Driven Development';
      catDesc = 'Spec-Driven Development phase executor agents';
      priority = 10;
    } else if (id.startsWith('jd-')) {
      catId = 'judgment-day';
      catName = 'Judgment Day';
      catDesc = 'Blind dual review judges and fix agent';
      priority = 20;
    } else if (id.startsWith('review-') || id.endsWith('-auditor')) {
      catId = 'reviewers';
      catName = 'Reviewers & Auditors';
      catDesc = 'Quality, security, and architectural review lenses';
      priority = 30;
    } else if (id.startsWith('gentle-ai-') || id.startsWith('gentle-')) {
      catId = 'gentle-ai';
      catName = 'Gentle AI';
      catDesc = 'General harness and execution agents';
      priority = 40;
    } else if (meta.scope === 'project') {
      catId = 'project';
      catName = 'Project Agents';
      catDesc = 'Subagents discovered in project directory';
      priority = 70;
    } else if (meta.scope === 'global') {
      catId = 'global';
      catName = 'Global Agents';
      catDesc = 'Globally configured subagents';
      priority = 80;
    } else {
      catId = 'general';
      catName = 'General Harness';
      catDesc = 'General subagents for code, exploration, and tracking';
      priority = 90;
    }

    if (!categoryMap.has(catId)) {
      categoryMap.set(catId, {
        id: catId,
        name: catName,
        description: catDesc,
        priority,
        agents: [],
      });
    }

    categoryMap.get(catId)!.agents.push(id);
  }

  const result: AgentCategory[] = [];
  const sortedCategories = Array.from(categoryMap.values()).sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.name.localeCompare(b.name);
  });

  for (const cat of sortedCategories) {
    if (cat.agents.length > 0) {
      cat.agents.sort((a, b) => a.localeCompare(b));
      result.push({
        id: cat.id,
        name: cat.name,
        description: cat.description,
        agents: cat.agents,
      });
    }
  }

  return result;
}



/**
 * Sanitizes a profile name into a valid filename / identifier.
 */
export function sanitizeProfileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
}

/**
 * Checks whether a key is a synthetic or invalid agent key.
 */
export function isSyntheticAgentKey(key: string): boolean {
  if (!key || typeof key !== 'string') return true;
  const trimmed = key.trim();
  if (!trimmed) return true;
  if (
    trimmed.startsWith('⚡') ||
    trimmed.startsWith('🧠') ||
    trimmed.startsWith('📦') ||
    trimmed.startsWith('👑') ||
    trimmed.includes('[Asignar') ||
    /\s/.test(trimmed)
  ) {
    return true;
  }
  return false;
}



/**
 * Resolves effective active profile.
 * If project active profile is set, returns project active profile.
 * If project active profile is absent or empty, falls back to global active profile.
 */
export function resolveEffectiveProfile(
  projectActive: string | null | undefined,
  globalActive: string | null | undefined,
  profiles: ProfileSummary[] = []
): {
  name: string | null;
  scope: 'project' | 'global' | null;
  isFallback: boolean;
  profile: ProfileSummary | null;
} {
  const cleanProj = projectActive ? sanitizeProfileName(projectActive) : null;
  const cleanGlob = globalActive ? sanitizeProfileName(globalActive) : null;

  if (cleanProj) {
    const matched = profiles.find((p) => sanitizeProfileName(p.name) === cleanProj);
    return {
      name: projectActive!.trim(),
      scope: (matched?.scope as 'project' | 'global') ?? 'project',
      isFallback: false,
      profile: matched ?? null,
    };
  }

  if (cleanGlob) {
    const matched = profiles.find((p) => sanitizeProfileName(p.name) === cleanGlob);
    return {
      name: globalActive!.trim(),
      scope: (matched?.scope as 'project' | 'global') ?? 'global',
      isFallback: true,
      profile: matched ?? null,
    };
  }

  return {
    name: null,
    scope: null,
    isFallback: false,
    profile: null,
  };
}

/**
 * Pure function: applies profile configuration to a subagents.json object,
 * preserving any custom keys, timeouts, shortcuts, etc.
 */
export function applyProfileToSubagentsConfig(
  currentConfig: Record<string, unknown>,
  profile: Profile
): Record<string, unknown> {
  const nextConfig: Record<string, unknown> = { ...currentConfig };

  if (profile.default_model) {
    nextConfig.default_model = profile.default_model;
  }
  if (profile.default_effort) {
    nextConfig.default_effort = profile.default_effort;
  } else {
    delete nextConfig.default_effort;
  }

  nextConfig.active_profile = profile.name;

  const modelProfiles: Record<string, { model: string; effort?: string }> = {};
  for (const [agentKey, entry] of Object.entries(profile.model_profiles || {})) {
    if (!isSyntheticAgentKey(agentKey) && entry && entry.model) {
      modelProfiles[agentKey] = {
        model: entry.model,
        ...(entry.effort ? { effort: entry.effort } : {}),
      };
    }
  }

  nextConfig.model_profiles = modelProfiles;
  return nextConfig;
}

export interface ProfilesPayload {
  profiles: ProfileSummary[];
  projectActiveProfile: string | null;
  globalActiveProfile: string | null;
  effectiveActiveProfile: string | null;
  effectiveScope: 'project' | 'global' | null;
  categories: AgentCategory[];
  allAgents: string[];
  agentMeta?: Record<string, DiscoveredAgentMeta>;
}

export interface SaveProfilePayload {
  cwd?: string;
  scope?: ProfileScope;
  profile: Profile;
}

export interface SetActiveProfilePayload {
  cwd?: string;
  name: string | null;
  scope: 'project' | 'global';
}

export interface ResolvedProfileModel {
  provider: string;
  modelId: string;
}

export function qualifyProfileModelId(providerId: string, modelId: string): string {
  const cleanProv = (providerId || '').trim();
  const cleanModel = (modelId || '').trim();
  if (!cleanProv) return cleanModel;
  if (!cleanModel) return cleanProv;
  if (cleanModel.startsWith(`${cleanProv}/`)) {
    return cleanModel;
  }
  return `${cleanProv}/${cleanModel}`;
}

export function resolveProfileModel(
  rawModel: string | null | undefined,
  availableModels: Array<{ id?: string; provider?: string }> = []
): ResolvedProfileModel | null {
  if (!rawModel || typeof rawModel !== 'string') return null;
  const trimmed = rawModel.trim();
  if (!trimmed) return null;

  // 1. Prefer exact catalog match
  // 1a. Check if qualifyProfileModelId(m.provider, m.id) matches or `${m.provider}/${m.id}` matches
  for (const m of availableModels) {
    if (m.id && m.provider) {
      const qualified = qualifyProfileModelId(m.provider, m.id);
      if (qualified === trimmed || `${m.provider}/${m.id}` === trimmed) {
        return { provider: m.provider, modelId: m.id };
      }
    }
  }

  // 1b. Check if m.id directly matches
  for (const m of availableModels) {
    if (m.id && m.id === trimmed) {
      return { provider: m.provider || '', modelId: m.id };
    }
  }

  // 2. Fallback: split on first slash only
  const firstSlash = trimmed.indexOf('/');
  if (firstSlash === -1) {
    return { provider: '', modelId: trimmed };
  }

  return {
    provider: trimmed.slice(0, firstSlash),
    modelId: trimmed.slice(firstSlash + 1),
  };
}

export function resolveProfileEffort(
  rawEffort: string | null | undefined
): ThinkingLevel | undefined {
  return parseReasoningEffort(rawEffort) as ThinkingLevel | undefined;
}

export interface ApplyProfileRuntimeOptions {
  isConnected: boolean;
  availableModels: ModelInfo[];
  onSelectModel: (provider: string, modelId: string) => Promise<void>;
  onSelectThinkingLevel: (level: ThinkingLevel) => Promise<void>;
}

export async function applyProfileRuntime(
  profile: ProfileSummary | null,
  options: ApplyProfileRuntimeOptions
): Promise<boolean> {
  if (!options.isConnected || !profile) {
    return false;
  }

  let modelApplied = false;
  if (profile.default_model) {
    const resolved = resolveProfileModel(profile.default_model, options.availableModels);
    if (resolved && resolved.modelId) {
      await options.onSelectModel(resolved.provider, resolved.modelId);
      modelApplied = true;
    }
  }

  if (profile.default_effort) {
    const effort = resolveProfileEffort(profile.default_effort);
    if (effort) {
      await options.onSelectThinkingLevel(effort);
    }
  }

  return modelApplied;
}

export const PROFILE_ACTIVATED_EVENT = 'pi:profile-activated';
export const PROFILE_CLEARED_EVENT = 'pi:profile-cleared';

export interface ProfileActivationEventDetail {
  profile: ProfileSummary;
  scope: 'project' | 'global';
}

export interface ProfileClearActiveEventDetail {
  scope: 'project';
}

export function decideProfileSelection(
  profile: ProfileSummary | null,
  options: {
    isBusy: boolean;
    isChangingProfile: boolean;
  }
): { shouldProceed: boolean; selected: ProfileSummary | null } {
  if (options.isBusy || options.isChangingProfile) {
    return { shouldProceed: false, selected: null };
  }
  return { shouldProceed: true, selected: profile };
}

import type {
  Profile,
  ProfileSummary,
  ProfileScope,
  ReasoningEffort,
  AgentCategory,
  DiscoveredAgentMeta,
  ModelProfileEntry,
  ProfilesPayload,
  SaveProfilePayload,
} from '@core/types/profiles';
import type { ModelInfo, ModelThinkingLevelsMap } from '@core/types/models';
import type { TranslationKey } from '@shared/i18n';

export type {
  Profile,
  ProfileSummary,
  ProfileScope,
  ReasoningEffort,
  AgentCategory,
  DiscoveredAgentMeta,
  ModelProfileEntry,
  ProfilesPayload,
  SaveProfilePayload,
};

export interface ProfileFormData {
  name: string;
  description: string;
  scope: 'global' | 'project';
  default_model: string;
  default_effort: ReasoningEffort | '';
  model_profiles: Record<string, ModelProfileEntry>;
}

export const EMPTY_PROFILE_FORM: ProfileFormData = {
  name: '',
  description: '',
  scope: 'global',
  default_model: '',
  default_effort: '',
  model_profiles: {},
};

export interface ProfileCardProps {
  profile: ProfileSummary;
  isActive: boolean;
  effectiveScope?: 'project' | 'global' | null;
  cwd?: string;
  isActivating?: boolean;
  isDeleting?: boolean;
  onActivate: (profile: ProfileSummary, scope: 'project' | 'global') => Promise<void> | void;
  onClearActive?: (scope: 'project') => Promise<void> | void;
  onEdit: (profile: ProfileSummary) => void;
  onDuplicate: (profile: ProfileSummary) => void;
  onDelete: (profile: ProfileSummary) => void;
}

export interface ProfileModalProps {
  isOpen: boolean;
  isEditing: boolean;
  isSaving: boolean;
  formData: ProfileFormData;
  error: string | null;
  availableModels: ModelInfo[];
  categories: AgentCategory[];
  agentMeta?: Record<string, DiscoveredAgentMeta>;
  modelThinkingLevels?: ModelThinkingLevelsMap;
  cwd?: string;
  onClose: () => void;
  onChangeField: <K extends keyof ProfileFormData>(field: K, value: ProfileFormData[K]) => void;
  onChangeAgentModel: (agentKey: string, model: string, effort?: ReasoningEffort | '') => void;
  onRemoveAgentOverride: (agentKey: string) => void;
  onSave: (e: React.FormEvent) => Promise<void> | void;
}

export interface ProfilesViewProps {
  cwd?: string;
  isBusy?: boolean;
  onClose?: () => void;
  t?: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

/**
 * Filter profiles by search query and scope filter.
 */
export function filterProfiles(
  profiles: ProfileSummary[],
  query: string,
  scopeFilter: 'all' | ProfileScope = 'all'
): ProfileSummary[] {
  let result = profiles;

  if (scopeFilter !== 'all') {
    result = result.filter((p) => p.scope === scopeFilter);
  }

  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return result;
  }

  return result.filter((p) => {
    if (p.name.toLowerCase().includes(trimmed)) return true;
    if (p.description && p.description.toLowerCase().includes(trimmed)) return true;
    if (p.default_model && p.default_model.toLowerCase().includes(trimmed)) return true;
    if (p.model_profiles) {
      for (const [agentKey, entry] of Object.entries(p.model_profiles) as [string, ModelProfileEntry][]) {
        if (agentKey.toLowerCase().includes(trimmed)) return true;
        if (entry?.model && entry.model.toLowerCase().includes(trimmed)) return true;
      }
    }
    return false;
  });
}

/**
 * Compute counts of profiles by scope and active state.
 */
export function computeProfileCounts(profiles: ProfileSummary[]): {
  total: number;
  global: number;
  project: number;
  active: number;
} {
  let globalCount = 0;
  let projectCount = 0;
  let activeCount = 0;

  for (const p of profiles) {
    if (p.scope === 'global') globalCount++;
    else if (p.scope === 'project') projectCount++;

    if (p.is_active) activeCount++;
  }

  return {
    total: profiles.length,
    global: globalCount,
    project: projectCount,
    active: activeCount,
  };
}

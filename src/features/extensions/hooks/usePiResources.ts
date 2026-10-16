import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  PiResourceEntry,
  PiResourceScope,
  SavePiResourcePayload,
  TogglePiResourcePayload,
  TogglePiResourceResult,
  DeletePiResourcePayload,
} from '@core/types/extensions';
import type {
  SetResourceActivationPayload,
  SetResourceActivationResult,
} from '@core/types/mcp';
import {
  getPiResources,
  savePiResource,
  setResourceActivationPi,
  togglePiResource,
  deletePiResource,
} from '@infra/bridge';
import {
  calculateDeletedResourceState,
  calculateToggledResourceState,
  computeResourceCounts,
} from '../types';

export interface UsePiResourcesOptions {
  cwd?: string;
}

export interface UsePiResourcesResult {
  resources: PiResourceEntry[];
  isLoading: boolean;
  totalCount: number;
  activeCount: number;
  extensionsCount: number;
  packagesCount: number;
  handleToggleResource: (
    resource: PiResourceEntry,
    enabled: boolean,
    targetScope?: PiResourceScope
  ) => Promise<void>;
  handleToggleProjectResource: (
    resource: PiResourceEntry,
    enabled: boolean
  ) => Promise<void>;
  handleToggleAlwaysActive: (
    resource: PiResourceEntry,
    alwaysActive: boolean
  ) => Promise<void>;
  handleSaveResource: (
    payload: SavePiResourcePayload,
    original?: PiResourceEntry | null
  ) => Promise<boolean>;
  handleDeleteResource: (resource: PiResourceEntry) => Promise<boolean>;
  refreshResources: () => Promise<void>;
  error: string | null;
  successNotice: string | null;
  setError: (err: string | null) => void;
  setSuccessNotice: (notice: string | null) => void;
  togglingIds: Set<string>;
}

export interface ExecuteResourceToggleOptions {
  resources: PiResourceEntry[];
  resource: PiResourceEntry;
  enabled: boolean;
  cwd?: string;
  targetScope?: PiResourceScope;
  toggleFn?: (
    payload: TogglePiResourcePayload
  ) => Promise<TogglePiResourceResult>;
}

export interface ExecuteResourceToggleResult {
  nextResources: PiResourceEntry[];
  success: boolean;
  error?: string;
}

export interface ExecuteResourceAlwaysActiveToggleOptions {
  resources: PiResourceEntry[];
  resource: PiResourceEntry;
  alwaysActive: boolean;
  activationFn?: (
    payload: SetResourceActivationPayload
  ) => Promise<SetResourceActivationResult>;
}

export interface ExecuteResourceAlwaysActiveToggleResult {
  nextResources: PiResourceEntry[];
  success: boolean;
  error?: string;
}

/**
 * Optimistically toggles always-active global exception on extension and invokes bridge activation.
 * No-op for packages.
 */
export async function executeResourceAlwaysActiveToggle({
  resources,
  resource,
  alwaysActive,
  activationFn = setResourceActivationPi,
}: ExecuteResourceAlwaysActiveToggleOptions): Promise<ExecuteResourceAlwaysActiveToggleResult> {
  if (resource.kind !== 'extension') {
    return {
      nextResources: resources,
      success: true,
    };
  }

  const nextResources = resources.map((r) =>
    r.id === resource.id ? { ...r, alwaysActive } : r
  );

  try {
    const res = await activationFn({
      kind: 'extension',
      identity: resource.source,
      enabled: alwaysActive,
      cwd: undefined,
    });

    if (!res.success) {
      return {
        nextResources: resources,
        success: false,
        error: `Failed to update always-active exception for extension "${resource.name}"`,
      };
    }

    return {
      nextResources,
      success: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      nextResources: resources,
      success: false,
      error: message,
    };
  }
}

/**
 * Core toggle workflow: applies optimistic update, calls bridge toggle,
 * and rolls back if bridge reports failure or throws.
 */
export async function executeResourceToggle({
  resources,
  resource,
  enabled,
  cwd,
  targetScope,
  toggleFn = togglePiResource,
}: ExecuteResourceToggleOptions): Promise<ExecuteResourceToggleResult> {
  const finalScope = targetScope || resource.scope;
  const optimisticResources = calculateToggledResourceState(
    resources,
    resource.id,
    enabled,
    targetScope
  );

  try {
    const res = await toggleFn({
      kind: resource.kind,
      source: resource.source,
      enabled,
      scope: finalScope,
      cwd: finalScope === 'project' ? cwd : undefined,
    });

    if (!res.success) {
      const reverted = calculateToggledResourceState(
        resources,
        resource.id,
        resource.enabled
      );
      return {
        nextResources: reverted,
        success: false,
        error: `Failed to toggle resource "${resource.name}"`,
      };
    }

    return {
      nextResources: optimisticResources,
      success: true,
    };
  } catch (err) {
    const reverted = calculateToggledResourceState(
      resources,
      resource.id,
      resource.enabled
    );
    const message = err instanceof Error ? err.message : String(err);
    return {
      nextResources: reverted,
      success: false,
      error: message,
    };
  }
}

/**
 * Hook to manage Pi extensions and packages:
 * loads global and project resources, provides counts, optimistic toggle with rollback,
 * save/delete with authoritative refresh, and reload notices.
 */
export function usePiResources({
  cwd,
}: UsePiResourcesOptions = {}): UsePiResourcesResult {
  const [resources, setResources] = useState<PiResourceEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(
    () => new Set()
  );

  const refreshResources = useCallback(async () => {
    setIsLoading(true);
    try {
      const payload = await getPiResources(cwd);
      setResources(payload.resources || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void refreshResources();
  }, [refreshResources]);

  const handleToggleResource = useCallback(
    async (
      resource: PiResourceEntry,
      enabled: boolean,
      targetScope?: PiResourceScope
    ) => {
      setTogglingIds((prev) => new Set(prev).add(resource.id));
      setError(null);
      setSuccessNotice(null);

      const finalScope = targetScope || resource.scope;

      // Apply optimistic update immediately
      setResources((prev) =>
        calculateToggledResourceState(prev, resource.id, enabled, targetScope)
      );

      try {
        const res = await togglePiResource({
          kind: resource.kind,
          source: resource.source,
          enabled,
          scope: finalScope,
          cwd: finalScope === 'project' ? cwd : undefined,
        });

        if (!res.success) {
          // Rollback on non-success
          setResources((prev) =>
            calculateToggledResourceState(prev, resource.id, resource.enabled)
          );
          setError(`Failed to toggle resource "${resource.name}"`);
        }
      } catch (err) {
        // Rollback on exception
        setResources((prev) =>
          calculateToggledResourceState(prev, resource.id, resource.enabled)
        );
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        setTogglingIds((prev) => {
          const next = new Set(prev);
          next.delete(resource.id);
          return next;
        });
      }
    },
    [cwd]
  );

  const handleToggleProjectResource = useCallback(
    async (resource: PiResourceEntry, enabled: boolean) => {
      if (resource.kind === 'extension' && cwd) {
        setTogglingIds((prev) => new Set(prev).add(resource.id));
        setError(null);
        setSuccessNotice(null);

        setResources((prev) =>
          calculateToggledResourceState(prev, resource.id, enabled, 'project')
        );

        try {
          const res = await setResourceActivationPi({
            kind: 'extension',
            identity: resource.source,
            enabled,
            cwd,
          });

          if (!res.success) {
            setResources((prev) =>
              calculateToggledResourceState(prev, resource.id, resource.enabled)
            );
            setError(`Failed to update project activation for resource "${resource.name}"`);
          }
        } catch (err) {
          setResources((prev) =>
            calculateToggledResourceState(prev, resource.id, resource.enabled)
          );
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
        } finally {
          setTogglingIds((prev) => {
            const next = new Set(prev);
            next.delete(resource.id);
            return next;
          });
        }
      } else {
        await handleToggleResource(
          resource,
          enabled,
          cwd ? 'project' : resource.scope
        );
      }
    },
    [cwd, handleToggleResource]
  );

  const handleToggleAlwaysActive = useCallback(
    async (resource: PiResourceEntry, alwaysActive: boolean) => {
      if (resource.kind !== 'extension') {
        return;
      }

      setTogglingIds((prev) => new Set(prev).add(resource.id));
      setError(null);
      setSuccessNotice(null);

      setResources((prev) =>
        prev.map((r) => (r.id === resource.id ? { ...r, alwaysActive } : r))
      );

      try {
        const res = await setResourceActivationPi({
          kind: 'extension',
          identity: resource.source,
          enabled: alwaysActive,
          cwd: undefined,
        });

        if (!res.success) {
          setResources((prev) =>
            prev.map((r) =>
              r.id === resource.id ? { ...r, alwaysActive: resource.alwaysActive } : r
            )
          );
          setError(
            `Failed to update activation policy for extension "${resource.name}"`
          );
        }
      } catch (err) {
        setResources((prev) =>
          prev.map((r) =>
            r.id === resource.id ? { ...r, alwaysActive: resource.alwaysActive } : r
          )
        );
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        setTogglingIds((prev) => {
          const next = new Set(prev);
          next.delete(resource.id);
          return next;
        });
      }
    },
    []
  );

  const handleSaveResource = useCallback(
    async (
      payload: SavePiResourcePayload,
      original?: PiResourceEntry | null
    ): Promise<boolean> => {
      setError(null);
      setSuccessNotice(null);

      try {
        const targetScope = payload.scope || 'global';
        const hasScopeChanged =
          original && original.scope !== targetScope;
        const hasKindChanged =
          original && original.kind !== payload.kind;

        if (hasScopeChanged || hasKindChanged) {
          // If scope or kind changed, save new entry first
          const saveRes = await savePiResource({
            ...payload,
            oldSource: undefined,
          });

          if (!saveRes.success) {
            setError('Failed to save resource in new scope or kind');
            return false;
          }

          // Then delete old entry from its old scope/kind
          try {
            await deletePiResource({
              kind: original.kind,
              source: original.source,
              scope: original.scope,
              cwd: original.scope === 'project' ? cwd : undefined,
            });
          } catch (deleteErr) {
            console.warn('Failed to clean up old resource entry:', deleteErr);
          }
        } else {
          const saveRes = await savePiResource(payload);
          if (!saveRes.success) {
            setError('Failed to save resource');
            return false;
          }
        }

        await refreshResources();
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return false;
      }
    },
    [cwd, refreshResources]
  );

  const handleDeleteResource = useCallback(
    async (resource: PiResourceEntry): Promise<boolean> => {
      setError(null);
      setSuccessNotice(null);

      try {
        const payload: DeletePiResourcePayload = {
          kind: resource.kind,
          source: resource.source,
          scope: resource.scope,
          cwd: resource.scope === 'project' ? cwd : undefined,
        };

        const res = await deletePiResource(payload);
        if (!res.success) {
          setError(`Failed to delete resource "${resource.name}"`);
          return false;
        }

        setResources((prev) =>
          calculateDeletedResourceState(prev, resource.id)
        );
        await refreshResources();
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return false;
      }
    },
    [cwd, refreshResources]
  );

  const {
    total: totalCount,
    active: activeCount,
    extensions: extensionsCount,
    packages: packagesCount,
  } = useMemo(() => computeResourceCounts(resources), [resources]);

  return {
    resources,
    isLoading,
    totalCount,
    activeCount,
    extensionsCount,
    packagesCount,
    handleToggleResource,
    handleToggleProjectResource,
    handleToggleAlwaysActive,
    handleSaveResource,
    handleDeleteResource,
    refreshResources,
    error,
    successNotice,
    setError,
    setSuccessNotice,
    togglingIds,
  };
}

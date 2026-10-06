import { useState, useEffect, useCallback } from 'react';
import { getEngramProjectPi, getEngramCloudStatusPi, enrollEngramProjectPi, type EngramCloudStatus } from '@infra/bridge';

export interface UseEngramProjectOptions {
  cwd?: string;
}

export interface UseEngramProjectReturn {
  engramProject: string | null;
  refreshEngramProject: () => Promise<void>;
  cloudStatus: EngramCloudStatus | null;
  isCheckingCloud: boolean;
  checkCloudStatus: () => Promise<EngramCloudStatus | null>;
  isEnrolling: boolean;
  enrollProject: () => Promise<boolean>;
}

export function useEngramProject({ cwd }: UseEngramProjectOptions = {}): UseEngramProjectReturn {
  const [engramProject, setEngramProject] = useState<string | null>(null);
  const [cloudStatus, setCloudStatus] = useState<EngramCloudStatus | null>(null);
  const [isCheckingCloud, setIsCheckingCloud] = useState(false);
  const [isEnrolling, setIsEnrolling] = useState(false);

  const checkCloudStatus = useCallback(async (): Promise<EngramCloudStatus | null> => {
    setIsCheckingCloud(true);
    try {
      const status = await getEngramCloudStatusPi(engramProject ?? undefined, cwd);
      if (!status) {
        setCloudStatus(null);
        return null;
      }

      let merged: EngramCloudStatus = { ...status };

      if (status.daemonRunning && status.enrolled === true) {
        try {
          const port = status.daemonPort || 7437;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 1500);
          const projectParam = engramProject ? `?project=${encodeURIComponent(engramProject)}` : '';
          const isWebIpc = typeof window !== 'undefined' && Boolean((window as any).__IS_WEB_IPC__);
          const daemonUrl = isWebIpc
            ? `/api/engram-daemon/sync/status${projectParam}`
            : `http://127.0.0.1:${port}/sync/status${projectParam}`;

          const res = await fetch(daemonUrl, {
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (res.ok) {
            const data = await res.json();
            if (data && typeof data === 'object') {
              const daemonErr = data.last_error || data.reason_message;
              const isProjectError = Boolean(
                engramProject && typeof daemonErr === 'string' && daemonErr.includes(engramProject)
              );

              merged = {
                ...merged,
                phase: isProjectError ? (data.phase ?? merged.phase) : (merged.phase ?? 'synced'),
                lastSyncAt: data.last_sync_at ?? merged.lastSyncAt,
                lastError: isProjectError ? (daemonErr ?? merged.lastError) : merged.lastError,
                reasonCode: isProjectError ? (data.reason_code ?? merged.reasonCode) : merged.reasonCode,
              };
            }
          }
        } catch {
          // Daemon fetch failed or timed out; keep CLI status
        }
      }

      setCloudStatus(merged);
      return merged;
    } catch {
      setCloudStatus(null);
      return null;
    } finally {
      setIsCheckingCloud(false);
    }
  }, [engramProject, cwd]);

  const refreshEngramProject = useCallback(async () => {
    try {
      const project = await getEngramProjectPi(cwd);
      setEngramProject(project);
    } catch {
      setEngramProject(null);
    }
  }, [cwd]);

  const enrollProject = useCallback(async (): Promise<boolean> => {
    if (!engramProject) {
      return false;
    }
    setIsEnrolling(true);
    try {
      const ok = await enrollEngramProjectPi(engramProject, cwd);
      if (ok) {
        await checkCloudStatus();
      }
      return ok;
    } catch {
      return false;
    } finally {
      setIsEnrolling(false);
    }
  }, [engramProject, cwd, checkCloudStatus]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const project = await getEngramProjectPi(cwd);
        if (!cancelled) {
          setEngramProject(project);
          try {
            const status = await getEngramCloudStatusPi(project ?? undefined, cwd);
            if (!cancelled && status) {
              setCloudStatus(status);
            }
          } catch {}
        }
      } catch {
        if (!cancelled) {
          setEngramProject(null);
          setCloudStatus(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return {
    engramProject,
    refreshEngramProject,
    cloudStatus,
    isCheckingCloud,
    checkCloudStatus,
    isEnrolling,
    enrollProject,
  };
}


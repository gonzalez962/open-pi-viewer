export interface DockerContainer { id: string; name: string; state: string; status: string }
export interface DockerFile { path: string; kind: 'yaml' | 'env'; identity: string }
export type DockerRequest = (payload: Record<string, unknown>, onEvent?: (event: any) => void) => Promise<any>;
export function dockerNavigation(existing: string[], web: boolean): string[] { return web ? [...existing, 'docker'] : existing; }
export function createDockerController(request: DockerRequest) {
  let state = { containers: [] as DockerContainer[], selected: null as string | null, files: [] as DockerFile[], file: null as DockerFile | null, content: '', version: '', logs: null as { stdout: string; stderr: string } | null, error: '', notice: '', updating: false, updateBusy: false, updateFailed: false, updateConsole: null as null | { id: string; phase: string; phases: string[]; text: string } };
  let updatingId: string | null = null;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const error = (e: unknown) => set({ error: e instanceof Error ? e.message : String(e), notice: '' });
  const refresh = async () => { try { const result = await request({ action: 'list' }); set({ containers: result.containers, error: '' }); } catch (e) { error(e); } };
  const loadFiles = async () => { const id = state.selected; if (!id) return; try { const result = await request({ action: 'files', containerId: id }); if (state.selected === id) set({ files: result.files, error: '' }); } catch (e) { if (state.selected === id) error(e); } };
  const openFile = async (file: DockerFile) => { const id = state.selected; if (!id || !state.files.some(f => f.identity === file.identity && f.path === file.path)) return; try { const result = await request({ action: 'readFile', containerId: id, file }); if (state.selected === id) set({ file, content: result.content, version: result.version, error: '', notice: '' }); } catch (e) { if (state.selected === id) error(e); } };
  return {
    getState: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh,
    select: async (id: string) => { if (state.containers.some(c => c.id === id)) set({ selected: id, files: [], file: null, content: '', version: '', logs: null, error: '', notice: '', updating: updatingId === id, updateFailed: false }); },
    updateImage: async (confirmed: boolean) => {
      const id = state.selected;
      if (!confirmed || !id || updatingId) return;
      updatingId = id;
      set({ updating: true, updateBusy: true, updateFailed: false, error: '', notice: '', updateConsole: { id, phase: 'pull', phases: ['pull'], text: '' } });
      try {
        await request({ action: 'updateImage', containerId: id, confirmed: true }, event => {
          const current = state.updateConsole;
          if (!current || current.id !== id) return;
          const phase = event.type === 'phase' ? event.phase : event.type === 'result' ? (event.ok ? 'success' : 'error') : current.phase;
          const text = event.type === 'output' ? `${current.text}[${event.stream}] ${event.text}` : event.type === 'truncated' ? `${current.text}\n[output truncated]\n` : current.text;
          set({ updateConsole: { id, phase, phases: event.type === 'phase' && !current.phases.includes(phase) ? [...current.phases, phase] : current.phases, text: text.slice(-128 * 1024) } });
        });
        if (state.selected === id) set({ notice: 'updateImage', error: '' });
        try {
          const result = await request({ action: 'list' });
          const missing = state.selected === id && !result.containers.some((container: DockerContainer) => container.id === id);
          set({ containers: result.containers, ...(missing ? { selected: null, files: [], file: null, content: '', version: '', logs: null, updating: false } : {}) });
        } catch (e) {
          if (state.selected === id) set({ error: e instanceof Error ? e.message : String(e) });
        }
      } catch (e) {
        if (state.updateConsole?.id === id) set({ updateConsole: { ...state.updateConsole, phase: /unknown/i.test(String(e)) ? 'unknown' : 'error' } });
        if (state.selected === id) set({ error: e instanceof Error ? e.message : String(e), notice: '', updateFailed: true });
      } finally {
        updatingId = null;
        set({ updateBusy: false, ...(state.selected === id ? { updating: false } : {}) });
      }
    },
    action: async (action: 'start' | 'stop' | 'restart') => { const id = state.selected; if (!id) return; try { await request({ action, containerId: id }); await refresh(); set({ notice: action, error: '' }); } catch (e) { error(e); } },
    remove: async (confirmed: boolean) => { const container = state.containers.find(c => c.id === state.selected); if (!confirmed || !container || !['exited', 'created', 'dead'].includes(container.state)) return; try { await request({ action: 'remove', containerId: container.id, confirmed: true }); set({ selected: null, files: [], file: null, content: '', version: '', logs: null }); await refresh(); set({ notice: 'remove', error: '' }); } catch (e) { error(e); } },
    loadLogs: async () => { const id = state.selected; if (!id) return; try { const logs = await request({ action: 'logs', containerId: id }); if (state.selected === id) set({ logs, error: '' }); } catch (e) { if (state.selected === id) error(e); } },
    loadFiles, openFile,
    editContent: (content: string) => set({ content, notice: '' }),
    saveFile: async () => { const { selected: id, file, version, content } = state; if (!id || !file || !version) return; try { await request({ action: 'saveFile', containerId: id, file, version, content }); if (state.selected !== id) return; const result = await request({ action: 'files', containerId: id }); const next = (result.files as DockerFile[]).find(f => f.path === file.path && f.kind === file.kind); set({ files: result.files, file: null, version: '', notice: 'saved', error: '' }); if (next) { await openFile(next); set({ notice: 'saved' }); } } catch (e) { error(e); } },
  };
}

export interface DockerContainer { id: string; name: string; state: string; status: string }
export interface DockerFile { path: string; kind: 'yaml' | 'env'; identity: string }
export type DockerRequest = (payload: Record<string, unknown>, onEvent?: (event: any) => void) => Promise<any>;
type DockerAction = 'saved' | 'updateImage' | 'start' | 'stop' | 'restart' | 'remove' | 'list' | 'files' | 'readFile' | 'logs';
type FeedbackContext = { action: DockerAction; container: string; file?: string };
export type DockerFeedback = ({ type: 'success'; notice: 'saved' | 'updateImage' | 'start' | 'stop' | 'restart' | 'remove' } | { type: 'error'; error: string; updateFailed: boolean }) & FeedbackContext;
export function dockerNavigation(existing: string[], web: boolean): string[] { return web ? [...existing, 'docker'] : existing; }
export function createDockerController(request: DockerRequest) {
  let state = { containers: [] as DockerContainer[], selected: null as string | null, files: [] as DockerFile[], file: null as DockerFile | null, content: '', version: '', logs: null as { stdout: string; stderr: string } | null, error: '', notice: '', updating: false, updateBusy: false, updateFailed: false, updateConsole: null as null | { id: string; phase: string; phases: string[]; text: string } };
  let updatingId: string | null = null;
  let selectionVersion = 0;
  let fileVersion = 0;
  const listeners = new Set<() => void>();
  const feedbackListeners = new Set<(event: DockerFeedback) => void>();
  const set = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const notify = (event: DockerFeedback) => feedbackListeners.forEach(fn => fn(event));
  const name = (id: string | null) => state.containers.find(c => c.id === id)?.name ?? id ?? '';
  const basename = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const error = (e: unknown, context: FeedbackContext, updateFailed = false) => { const message = e instanceof Error ? e.message : String(e); set({ error: message, notice: '', updateFailed }); notify({ type: 'error', error: message, updateFailed, ...context }); };
  const success = (notice: Extract<DockerFeedback, { type: 'success' }>['notice'], container: string, file?: string) => { set({ notice, error: '' }); notify({ type: 'success', notice, action: notice, container, file }); };
  const refresh = async () => { const version = selectionVersion; try { const result = await request({ action: 'list' }); set({ containers: result.containers, ...(version === selectionVersion ? { error: '' } : {}) }); } catch (e) { if (version === selectionVersion) error(e, { action: 'list', container: '' }); } };
  const loadFiles = async () => { const id = state.selected; const selection = selectionVersion; if (!id) return; const container = name(id); try { const result = await request({ action: 'files', containerId: id }); if (selection === selectionVersion) set({ files: result.files, error: '' }); } catch (e) { if (selection === selectionVersion) error(e, { action: 'files', container }); } };
  const openFile = async (file: DockerFile) => {
    const id = state.selected; const selection = selectionVersion;
    if (!id || !state.files.some(f => f.identity === file.identity && f.path === file.path)) return;
    const container = name(id);
    const generation = ++fileVersion;
    if (state.file?.identity === file.identity && state.file.path === file.path) { set({ file: null, content: '', version: '' }); return; }
    try {
      const result = await request({ action: 'readFile', containerId: id, file });
      if (selection === selectionVersion && generation === fileVersion && state.selected === id) set({ file, content: result.content, version: result.version, error: '', notice: '' });
    } catch (e) { if (selection === selectionVersion && generation === fileVersion && state.selected === id) error(e, { action: 'readFile', container, file: basename(file.path) }); }
  };
  return {
    getState: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    subscribeFeedback: (fn: (event: DockerFeedback) => void) => { feedbackListeners.add(fn); return () => { feedbackListeners.delete(fn); }; },
    refresh,
    select: async (id: string) => { if (state.containers.some(c => c.id === id)) { if (state.selected !== id) selectionVersion++; fileVersion++; set({ selected: id, files: [], file: null, content: '', version: '', logs: null, error: '', notice: '', updating: updatingId === id, updateFailed: false }); } },
    updateImage: async (confirmed: boolean) => {
      const id = state.selected;
      if (!confirmed || !id || updatingId) return;
      const selection = selectionVersion;
      const container = name(id);
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
        if (state.selected === id && selectionVersion === selection) success('updateImage', container);
        try {
          const result = await request({ action: 'list' });
          const missing = state.selected === id && !result.containers.some((container: DockerContainer) => container.id === id);
          set({ containers: result.containers, ...(missing ? { selected: null, files: [], file: null, content: '', version: '', logs: null, updating: false } : {}) });
        } catch (e) {
          if (state.selected === id && selectionVersion === selection) error(e, { action: 'list', container: '' });
        }
      } catch (e) {
        if (state.updateConsole?.id === id) set({ updateConsole: { ...state.updateConsole, phase: /unknown/i.test(String(e)) ? 'unknown' : 'error' } });
        if (state.selected === id && selectionVersion === selection) error(e, { action: 'updateImage', container }, true);
      } finally {
        updatingId = null;
        set({ updateBusy: false, ...(state.selected === id ? { updating: false } : {}) });
      }
    },
    action: async (action: 'start' | 'stop' | 'restart') => { const id = state.selected; const selection = selectionVersion; if (!id) return; const container = name(id); try { await request({ action, containerId: id }); if (selection === selectionVersion) { await refresh(); if (selection === selectionVersion) success(action, container); } } catch (e) { if (selection === selectionVersion) error(e, { action, container }); } },
    remove: async (confirmed: boolean) => { const container = state.containers.find(c => c.id === state.selected); const selection = selectionVersion; if (!confirmed || !container || !['exited', 'created', 'dead'].includes(container.state)) return; try { await request({ action: 'remove', containerId: container.id, confirmed: true }); if (selection === selectionVersion) { set({ selected: null, files: [], file: null, content: '', version: '', logs: null }); await refresh(); if (selection === selectionVersion) success('remove', container.name); } } catch (e) { if (selection === selectionVersion) error(e, { action: 'remove', container: container.name }); } },
    loadLogs: async () => { const id = state.selected; const selection = selectionVersion; if (!id) return; const container = name(id); try { const logs = await request({ action: 'logs', containerId: id }); if (selection === selectionVersion) set({ logs, error: '' }); } catch (e) { if (selection === selectionVersion) error(e, { action: 'logs', container }); } },
    loadFiles, openFile,
    editContent: (content: string) => set({ content, notice: '' }),
    saveFile: async () => {
      const { selected: id, file, version, content } = state; const selection = selectionVersion; const generation = fileVersion;
      if (!id || !file || !version) return;
      const container = name(id); const fileName = basename(file.path);
      const current = () => selection === selectionVersion && generation === fileVersion && state.selected === id;
      try {
        await request({ action: 'saveFile', containerId: id, file, version, content }); if (!current()) return;
        const result = await request({ action: 'files', containerId: id }); if (!current()) return;
        const next = (result.files as DockerFile[]).find(f => f.path === file.path && f.kind === file.kind);
        set({ files: result.files, file: null, content: '', version: '', notice: 'saved', error: '' });
        if (next) { const reopening = openFile(next); const reopenGeneration = fileVersion; await reopening; if (selection === selectionVersion && reopenGeneration === fileVersion && state.selected === id) success('saved', container, fileName); }
        else if (current()) success('saved', container, fileName);
      } catch (e) { if (current()) error(e, { action: 'saved', container, file: fileName }); }
    },
  };
}

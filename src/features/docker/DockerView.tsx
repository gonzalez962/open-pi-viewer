import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { dockerRequest } from '@infra/bridge';
import { ConfirmationModal } from '@app/components/ConfirmationModal';
import { translate, type SupportedLocale } from '@shared/i18n';
import { SettingsToastContext, SettingsToastContainer, useToastManager } from '@features/settings/toast';
import type { SettingsToastContextValue } from '@features/settings/toast';
import { createDockerController, type DockerFeedback } from './docker-controller';
import '@features/settings/toast/settings-toast.css';
import './docker.css';

type DockerController = ReturnType<typeof createDockerController>;
type UpdateConsole = NonNullable<ReturnType<DockerController['getState']>['updateConsole']>;

function filePathParts(path: string) {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return { name: path.slice(separator + 1), directory: separator < 0 ? '.' : separator === 0 || (separator === 2 && /^[a-z]:$/i.test(path.slice(0, 2))) ? path.slice(0, separator + 1) : path.slice(0, separator) };
}

export function subscribeDockerToasts(controller: DockerController, locale: SupportedLocale, toast: Pick<SettingsToastContextValue, 'success' | 'error'>) {
  return controller.subscribeFeedback((event: DockerFeedback) => {
    const params = { container: event.container, file: event.file ?? '', reason: event.type === 'error' ? event.error : '' };
    if (event.type === 'error') {
      toast.error(translate(locale, `docker.error_${event.action}`, params));
    } else {
      toast.success(translate(locale, `docker.feedback_${event.notice}`, params));
    }
  });
}

export function UpdateLogModal({ isOpen, console: output, locale, onClose }: { isOpen: boolean; console: UpdateConsole; locale: SupportedLocale; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const consoleRef = useRef<HTMLPreElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    closeRef.current?.focus();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [isOpen]);
  useEffect(() => {
    if (isOpen && consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [isOpen, output.text]);

  if (!isOpen) return null;
  return <dialog ref={dialogRef} className="docker-update-modal" aria-modal="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id={titleId}>{translate(locale, 'docker.update_console')} · {output.id}</h2>
    <p>{translate(locale, 'docker.phase')}: {output.phase}</p>
    <pre ref={consoleRef} className="docker-update-console">{output.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')}</pre>
    <button ref={closeRef} type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{translate(locale, 'docker.update_close')}</button>
  </dialog>;
}

export function DockerView({ locale, controller: providedController }: { locale: SupportedLocale; controller?: DockerController }) {
  const controller = useMemo(() => providedController ?? createDockerController((payload, onEvent) => dockerRequest(payload, fetch, onEvent)), [providedController]);
  const ambientToast = useContext(SettingsToastContext);
  const localToast = useToastManager();
  const toast = ambientToast ?? localToast;
  const { success, error } = toast;
  const [state, setState] = useState(controller.getState());
  const [tab, setTab] = useState<'files' | 'logs'>('files');
  const [confirm, setConfirm] = useState(false);
  const [updateConfirm, setUpdateConfirm] = useState<string | null>(null);
  const [updateLogOpen, setUpdateLogOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  useEffect(() => subscribeDockerToasts(controller, locale, { success, error }), [controller, locale, success, error]);
  useEffect(() => { const unsubscribe = controller.subscribe(() => setState(controller.getState())); void controller.refresh(); return unsubscribe; }, [controller]);
  const run = async (fn: () => Promise<void>) => { setPending(true); try { await fn(); } finally { setPending(false); } };
  const selected = state.containers.find(c => c.id === state.selected);
  const stopped = selected && ['exited', 'created', 'dead'].includes(selected.state);
  return <SettingsToastContext.Provider value={toast}><div className="docker-view">
    <div className="docker-heading"><h1>{t('docker.title')}</h1><p>{t('docker.subtitle')}</p></div>
    <div className="docker-toolbar">
      <div className="docker-search"><label htmlFor="docker-search">{t('docker.search')}</label><input id="docker-search" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => void run(controller.refresh)}>{t('docker.refresh')}</button>
    </div>
    {state.updating && <div role="status" className="docker-notice">{t('docker.update_pending')}</div>}
    {state.updateConsole && <UpdateLogModal isOpen={updateLogOpen} console={state.updateConsole} locale={locale} onClose={() => setUpdateLogOpen(false)} />}
    <div className="docker-layout">
      <section className="docker-panel">
        <div className="docker-panel-head"><h2>{t('docker.containers')}</h2><p>{t('docker.all')}</p></div>
        <ul className="docker-list">{state.containers.filter(c => c.name.toLowerCase().includes(query.toLowerCase())).map(c => <li key={c.id}>
          <button type="button" className="docker-list-item" aria-pressed={c.id === state.selected} onClick={() => void run(async () => { await controller.select(c.id); setTab('files'); await controller.loadFiles(); })}>
            <span className="docker-container-name">{c.name}</span><span className={`docker-state ${c.state === 'running' ? 'running' : ''}`}>{c.state.charAt(0).toUpperCase() + c.state.slice(1)}</span>
          </button>
        </li>)}</ul>
        {state.containers.length === 0 && !state.error && <p className="docker-content">{t('docker.empty')}</p>}
      </section>
      <section className="docker-panel">{selected ? <>
        <div className="docker-panel-head">
          <h2>{selected.name}</h2><p>{selected.id}</p><div className="docker-metadata"><span className="docker-container-status">{selected.status}</span><span className={`docker-state ${selected.state === 'running' ? 'running' : ''}`}>{selected.state.charAt(0).toUpperCase() + selected.state.slice(1)}</span></div>
          <div className="docker-actions">
            {(['start', 'stop', 'restart'] as const).filter(action => action === 'restart' || (action === 'start' ? stopped : selected.state === 'running')).map(action => <button type="button" className="btn btn-secondary btn-sm" key={action} disabled={pending} onClick={() => void run(() => controller.action(action))}>{t(`docker.${action}`)}</button>)}
            <button type="button" className="btn btn-secondary btn-sm" disabled={pending || state.updateBusy} onClick={() => setUpdateConfirm(selected.id)}>{t('docker.update')}</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={pending || !stopped} onClick={() => setConfirm(true)}>{t('docker.remove')}</button>
          </div>
          <p>{t('docker.remove_hint')}</p>
        </div>
        <div className="docker-tabs">
          <button type="button" className="btn btn-secondary btn-sm" aria-pressed={tab === 'files'} onClick={() => setTab('files')}>{t('docker.configuration')}</button>
          <button type="button" className="btn btn-secondary btn-sm" aria-pressed={tab === 'logs'} onClick={() => { setTab('logs'); void run(controller.loadLogs); }}>{t('docker.logs')}</button>
        </div>
        {tab === 'files' ? <div className="docker-content">
          <h3>{t('docker.discovered')}</h3><p>{t('docker.discovered_hint')}</p>
          <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => void run(controller.loadFiles)}>{t('docker.refresh')}</button>
          {state.files.length === 0 ? <p>{t('docker.unavailable')}</p> : <>
            <p>{t('docker.directories')}: {[...new Set(state.files.map(file => filePathParts(file.path).directory))].join(' · ')}</p>
            <div className="docker-file-tabs">{state.files.map(file => <button type="button" className="btn btn-secondary btn-sm" key={file.identity} disabled={pending} aria-pressed={state.file?.identity === file.identity} onClick={() => void run(() => controller.openFile(file))}>{filePathParts(file.path).name}</button>)}</div>
            {state.file && <><label htmlFor="docker-editor">{t('docker.original')}</label><textarea id="docker-editor" spellCheck={false} value={state.content} onChange={e => controller.editContent(e.target.value)} /><p>{t('docker.save_hint')}</p><button type="button" className="btn btn-primary btn-sm" disabled={pending || !state.version} onClick={() => void run(controller.saveFile)}>{t('docker.save')}</button></>}
          </>}
        </div> : <div className="docker-content"><p>{t('docker.logs_hint')}</p><button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => void run(controller.loadLogs)}>{t('docker.refresh')}</button>{state.logs && <pre className="docker-container-logs">{state.logs.stdout}{state.logs.stderr}</pre>}</div>}
        <ConfirmationModal isOpen={updateConfirm === selected.id} title={`${t('docker.update')} ${selected.name}?`} message={t('docker.update_confirm')} confirmLabel={t('docker.update')} cancelLabel={t('docker.cancel')} onCancel={() => setUpdateConfirm(null)} onConfirm={() => { setUpdateConfirm(null); if (updateConfirm && controller.getState().selected === updateConfirm && !controller.getState().updateBusy) { void controller.updateImage(true); setUpdateLogOpen(true); } }} />
        <ConfirmationModal isOpen={confirm} title={`${t('docker.remove')} ${selected.name}?`} message={t('docker.confirm')} confirmLabel={t('docker.remove')} cancelLabel={t('docker.cancel')} onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void run(() => controller.remove(true)); }} />
      </> : <p className="docker-content">{t('docker.select')}</p>}</section>
    </div>
  </div><SettingsToastContainer /></SettingsToastContext.Provider>;
}

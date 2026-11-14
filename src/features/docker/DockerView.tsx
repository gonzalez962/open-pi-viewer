import { useEffect, useMemo, useRef, useState } from 'react';
import { dockerRequest } from '@infra/bridge';
import { ConfirmationModal } from '@app/components/ConfirmationModal';
import { translate, type SupportedLocale } from '@shared/i18n';
import { createDockerController } from './docker-controller';
import './docker.css';

export function DockerView({ locale }: { locale: SupportedLocale }) {
  const controller = useMemo(() => createDockerController((payload, onEvent) => dockerRequest(payload, fetch, onEvent)), []);
  const consoleRef = useRef<HTMLPreElement>(null);
  const [state, setState] = useState(controller.getState());
  const [tab, setTab] = useState<'files' | 'logs'>('files');
  const [confirm, setConfirm] = useState(false);
  const [updateConfirm, setUpdateConfirm] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  useEffect(() => { const unsubscribe = controller.subscribe(() => setState(controller.getState())); void controller.refresh(); return unsubscribe; }, [controller]);
  useEffect(() => { if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight; }, [state.updateConsole]);
  const run = async (fn: () => Promise<void>) => { setPending(true); try { await fn(); } finally { setPending(false); } };
  const selected = state.containers.find(c => c.id === state.selected);
  const stopped = selected && ['exited', 'created', 'dead'].includes(selected.state);
  return <div className="docker-view">
    <div className="docker-heading"><div><h1>{t('docker.title')}</h1><p>{t('docker.subtitle')}</p></div><button disabled={pending} onClick={() => void run(controller.refresh)}>{t('docker.refresh')}</button></div>
    {state.error && <div className="docker-error" role="alert">{state.updateFailed && <>{t('docker.update_error')}: </>}{state.error}</div>}
    {state.updating && <div role="status" className="docker-notice">{t('docker.update_pending')}</div>}
    {state.notice && <div role="status" className="docker-notice">{state.notice === 'saved' ? t('docker.saved') : state.notice === 'updateImage' ? t('docker.update_done') : t('docker.action_done')}</div>}
    {state.updateConsole && <section className="docker-panel docker-content" aria-label={t('docker.update_console')}><h2>{t('docker.update_console')} · {state.updateConsole.id}</h2><p>{t('docker.phase')}: {state.updateConsole.phase}</p><pre ref={consoleRef} className="docker-update-console">{state.updateConsole.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')}</pre></section>}
    <div className="docker-layout"><section className="docker-panel"><div className="docker-panel-head"><h2>{t('docker.containers')}</h2><p>{t('docker.all')}</p></div>
      <div className="docker-content"><label htmlFor="docker-search">{t('docker.search')}</label><input id="docker-search" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <ul className="docker-list">{state.containers.filter(c => c.name.toLowerCase().includes(query.toLowerCase())).map(c => <li key={c.id} className={c.id === state.selected ? 'selected' : ''}><button aria-pressed={c.id === state.selected} onClick={() => void run(async () => { await controller.select(c.id); setTab('files'); await controller.loadFiles(); })}>{c.name}</button><span>{c.state} · {c.status}</span></li>)}</ul>
      {state.containers.length === 0 && !state.error && <p className="docker-content">{t('docker.empty')}</p>}
    </section><section className="docker-panel">{selected ? <><div className="docker-panel-head"><h2>{selected.name}</h2><p>{selected.id} · {selected.state} · {selected.status}</p><div className="docker-actions">{(['start', 'stop', 'restart'] as const).map(action => <button key={action} disabled={pending} onClick={() => void run(() => controller.action(action))}>{t(`docker.${action}`)}</button>)}<button disabled={pending || state.updateBusy} onClick={() => setUpdateConfirm(selected.id)}>{t('docker.update')}</button><button disabled={pending || !stopped} onClick={() => setConfirm(true)}>{t('docker.remove')}</button></div><p>{t('docker.remove_hint')}</p><p>{t('docker.update_hint')}</p></div>
      <div className="docker-tabs"><button aria-pressed={tab === 'files'} onClick={() => setTab('files')}>{t('docker.configuration')}</button><button aria-pressed={tab === 'logs'} onClick={() => { setTab('logs'); void run(controller.loadLogs); }}>{t('docker.logs')}</button></div>
      {tab === 'files' ? <div className="docker-content"><h3>{t('docker.discovered')}</h3><p>{t('docker.discovered_hint')}</p><button disabled={pending} onClick={() => void run(controller.loadFiles)}>{t('docker.refresh')}</button>{state.files.length === 0 ? <p>{t('docker.unavailable')}</p> : <><div className="docker-file-tabs">{state.files.map(file => <button key={file.identity} disabled={pending} aria-pressed={state.file?.identity === file.identity} onClick={() => void run(() => controller.openFile(file))}>{file.path} ({file.kind})</button>)}</div>{state.file && <><label htmlFor="docker-editor">{t('docker.original')}</label><textarea id="docker-editor" spellCheck={false} value={state.content} onChange={e => controller.editContent(e.target.value)} /><p>{t('docker.save_hint')}</p><button disabled={pending || !state.version} onClick={() => void run(controller.saveFile)}>{t('docker.save')}</button></>}</>}</div> : <div className="docker-content"><p>{t('docker.logs_hint')}</p><button disabled={pending} onClick={() => void run(controller.loadLogs)}>{t('docker.refresh')}</button>{state.logs && <pre>{state.logs.stdout}{state.logs.stderr}</pre>}</div>}
      <ConfirmationModal isOpen={updateConfirm === selected.id} title={`${t('docker.update')} ${selected.name}?`} message={t('docker.update_confirm')} confirmLabel={t('docker.update')} cancelLabel={t('docker.cancel')} onCancel={() => setUpdateConfirm(null)} onConfirm={() => { setUpdateConfirm(null); if (controller.getState().selected === updateConfirm) void controller.updateImage(true); }} />
      <ConfirmationModal isOpen={confirm} title={`${t('docker.remove')} ${selected.name}?`} message={t('docker.confirm')} confirmLabel={t('docker.remove')} cancelLabel={t('docker.cancel')} onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void run(() => controller.remove(true)); }} />
    </> : <p className="docker-content">{t('docker.select')}</p>}</section></div>
  </div>;
}

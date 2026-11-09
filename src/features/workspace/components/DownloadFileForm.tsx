import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ResourceModalLayout } from '@shared/components/ResourceModalLayout';
import { downloadWorkspaceFile } from '@infra/workspace-download';
import { translate, type SupportedLocale } from '@shared/i18n';

export function DownloadFileForm({ locale, onClose }: { locale: SupportedLocale; onClose: () => void }) {
  const [path, setPath] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = (key: 'file_tree.download_path' | 'file_tree.download' | 'file_tree.download_initiated' | 'file_tree.download_saved' | 'action.cancel') => translate(locale, key);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const close = () => { if (!busyRef.current) onClose(); };
  return createPortal(<ResourceModalLayout titleId="workspace-download-title" title={t('file_tree.download_path')} isOpen onClose={close} error={error} className="workspace-download-modal" onSubmit={(event) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage(''); setError('');
    void downloadWorkspaceFile({ sourcePath: path }).then((result) => {
      if (result.outcome === 'initiated') setMessage(t('file_tree.download_initiated'));
      if (result.outcome === 'saved') setMessage(t('file_tree.download_saved'));
    }).catch((err) => setError(String(err))).finally(() => { busyRef.current = false; setBusy(false); });
  }} footer={<><button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>{t('action.cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{t('file_tree.download')}</button></>}>
    <div className="field-group"><label className="field-label" htmlFor="workspace-download-path">{t('file_tree.download_path')}</label><input id="workspace-download-path" className="field-input" ref={inputRef} value={path} onChange={(event) => setPath(event.target.value)} required /></div>
    {message && <div role="status">{message}</div>}
  </ResourceModalLayout>, document.body);
}

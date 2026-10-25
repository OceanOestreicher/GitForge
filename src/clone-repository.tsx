import { Message } from './messages';
import { useEffect, useRef, useState } from 'react';
import type { Repository } from './repository';

export function CloneRepository({ onClose, onCloned }: { onClose: () => void; onCloned: (repository: Repository) => void }) {
  const [url, setUrl] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="clone-repository-title" onCancel={event => { event.preventDefault(); if (!submitting.current) onClose(); }}>
    <header><h1 id="clone-repository-title">Clone a Repository</h1><button aria-label="Close clone form" disabled={busy} onClick={onClose}>×</button></header>
    <form onSubmit={async event => {
      event.preventDefault(); if (!url.trim() || !parentPath.trim() || submitting.current || browsing) return;
      submitting.current = true; setBusy(true); setError('');
      try { onCloned(await window.gitforge.cloneRepository({ url, parentPath })); }
      catch (error) { setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : Message["clone.unexpectedFailure"]); setBusy(false); submitting.current = false; }
    }}>
      <label>GitHub HTTPS clone link<input autoFocus required value={url} disabled={busy} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repository.git"/></label>
      <div className="parent-directory-field"><label htmlFor="clone-parent-directory">Parent directory</label><div className="directory-input"><input id="clone-parent-directory" required value={parentPath} disabled={busy} onChange={event => setParentPath(event.target.value)}/><button type="button" disabled={busy || browsing} onClick={async () => {
        setBrowsing(true);
        try { const folder = await window.gitforge.chooseParentDirectory(); if (folder !== null) setParentPath(folder); }
        catch { setError(Message["directory.picker.failed"]); }
        finally { setBrowsing(false); }
      }}>Browse</button></div></div>
      {error && <p className="create-error" role="alert">{error}</p>}
      {busy && <p role="status">Cloning repository…</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" disabled={!url.trim() || !parentPath.trim() || busy || browsing}>{busy ? 'Cloning…' : 'Clone Repository'}</button></footer>
    </form>
  </dialog>;
}

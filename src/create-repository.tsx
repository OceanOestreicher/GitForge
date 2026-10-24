import { useEffect, useRef, useState } from 'react';
import type { Repository } from './repository';

export function CreateRepository({ onClose, onCreated }: { onClose: () => void; onCreated: (repository: Repository) => void }) {
  const [name, setName] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const complete = Boolean(name.trim() && parentPath.trim() && branch.trim());
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="create-repository-title" onCancel={event => { event.preventDefault(); if (!submitting.current) onClose(); }}>
    <header><h1 id="create-repository-title">Initialize a Repository</h1><button aria-label="Close initialization form" disabled={busy} onClick={onClose}>×</button></header>
    <form onSubmit={async event => {
      event.preventDefault();
      if (!complete || submitting.current) return;
      submitting.current = true; setBusy(true); setError('');
      try { onCreated(await window.gitforge.createRepository({ name, parentPath, branch })); }
      catch (error) { setError(String(error)); setBusy(false); submitting.current = false; }
    }}>
      <label>Repository name<input autoFocus required value={name} disabled={busy} onChange={event => setName(event.target.value)}/></label>
      <div className="parent-directory-field"><label htmlFor="parent-directory">Parent directory</label><div className="directory-input"><input id="parent-directory" required value={parentPath} disabled={busy} onChange={event => setParentPath(event.target.value)}/><button type="button" disabled={busy || browsing} onClick={async () => {
        setBrowsing(true);
        try { const folder = await window.gitforge.chooseParentDirectory(); if (folder !== null) setParentPath(folder); }
        catch (error) { setError(String(error)); }
        finally { setBrowsing(false); }
      }}>Browse</button></div></div>
      <label>Default branch name<input required value={branch} disabled={busy} onChange={event => setBranch(event.target.value)}/></label>
      {error && <p className="create-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" disabled={!complete || busy || browsing}>{busy ? 'Creating repository…' : 'Create Repository'}</button></footer>
    </form>
  </dialog>;
}

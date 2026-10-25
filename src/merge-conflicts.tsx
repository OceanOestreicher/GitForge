import { useEffect, useRef, useState } from 'react';
export type Conflict = { id: string; kind: 'merge' | 'pull' | 'stash'; index: number; total: number; path: string; ours: string; theirs: string; canBoth: boolean };
export type ConflictAction = { action: 'abort' | 'resolve'; id: string; index?: number; choice?: 'ours' | 'theirs' | 'both' };

export function MergeConflicts({ conflict, execute }: { conflict: Conflict; execute: (input: ConflictAction) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [ours, setOurs] = useState(false), [theirs, setTheirs] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => { setOurs(false); setTheirs(false); setError(''); }, [conflict.id, conflict.index]);
  const run = async (action: 'abort' | 'resolve') => {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await execute({ action, id: conflict.id, index: conflict.index, choice: ours && theirs ? 'both' : ours ? 'ours' : 'theirs' }); }
    catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not update the merge.'); }
    finally { working.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="merge-dialog" aria-labelledby="merge-title" onCancel={event => event.preventDefault()}>
    <header><h1 id="merge-title">Merge Conflicts</h1><p>{conflict.path} <span className="muted">Conflict {conflict.index + 1} of {conflict.total}</span></p></header>
    <div className="merge-panes">
      <section aria-label="Current branch code"><h2>Current branch</h2><pre>{conflict.ours || '(No lines)'}</pre><label><input type="checkbox" disabled={busy} checked={ours} onChange={event => { setOurs(event.target.checked); if (event.target.checked && !conflict.canBoth) setTheirs(false); }}/>Keep local changes</label></section>
      <section aria-label="Incoming code"><h2>{conflict.kind === 'stash' ? 'Stashed changes' : 'Incoming changes'}</h2><pre>{conflict.theirs || '(No lines)'}</pre><label><input type="checkbox" disabled={busy} checked={theirs} onChange={event => { setTheirs(event.target.checked); if (event.target.checked && !conflict.canBoth) setOurs(false); }}/>Keep incoming changes</label></section>
    </div>
    {conflict.canBoth && <p className="merge-help">Select both to keep local changes followed by incoming changes.</p>}
    {error && <p className="create-error merge-error" role="alert">{error}</p>}
    <footer><button disabled={busy} onClick={() => void run('abort')}>Abort Merge</button><button disabled={busy || (!ours && !theirs)} onClick={() => void run('resolve')}>{conflict.index + 1 < conflict.total ? 'Next Conflict' : 'Resolve'}</button></footer>
  </dialog>;
}

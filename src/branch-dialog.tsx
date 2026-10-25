import { useEffect, useRef, useState } from 'react';
export type BranchAction = { action: string; ref?: string; hash?: string; name?: string; paths?: string[]; strategy?: string; mode?: string; deleteAfter?: boolean };
export type BranchPrompt = { kind: 'create' | 'reset' | 'switch' | 'stash' | 'apply-stash' | 'delete-stash'; input: BranchAction };
export function BranchDialog({ prompt, close, execute }: { prompt: BranchPrompt; close: () => void; execute: (input: BranchAction) => Promise<void> }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState('keep');
  const [strategy, setStrategy] = useState('');
  const [deleteAfter, setDeleteAfter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const title = { create: 'Create Branch', reset: 'Reset Branch To Commit', switch: 'Switch Branch', stash: 'Stash Changes', 'apply-stash': 'Apply Stash', 'delete-stash': 'Delete Stash' }[prompt.kind];
  const complete = !(['create', 'stash'].includes(prompt.kind) && !name.trim()) && !(prompt.kind === 'switch' && !strategy);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="branch-dialog-title" onCancel={event => { event.preventDefault(); if (!submitting.current) close(); }}><header><h1 id="branch-dialog-title">{title}</h1></header><form onSubmit={async event => {
    event.preventDefault(); if (!complete || submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try { await execute({ ...prompt.input, name, mode, strategy, deleteAfter }); close(); }
    catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'The operation failed.'); setBusy(false); submitting.current = false; }
  }}>
    {['create', 'stash'].includes(prompt.kind) && <label>{prompt.kind === 'create' ? 'Branch name' : 'Stash name'}<input autoFocus required disabled={busy} value={name} onChange={event => setName(event.target.value)}/></label>}
    {prompt.kind === 'reset' && <><p>Reset the current branch to {prompt.input.hash?.slice(0, 7)}.</p><label className="choice"><input type="radio" name="reset-mode" value="keep" checked={mode === 'keep'} disabled={busy} onChange={() => setMode('keep')}/>Keep changes as unstaged files</label><label className="choice"><input type="radio" name="reset-mode" value="discard" checked={mode === 'discard'} disabled={busy} onChange={() => setMode('discard')}/>Discard all changes</label></>}
    {prompt.kind === 'switch' && <><p>Uncommitted changes are present. Choose what to do before switching branches.</p><label className="choice"><input type="radio" name="switch-strategy" checked={strategy === 'discard'} disabled={busy} onChange={() => setStrategy('discard')}/>Discard changes</label><label className="choice"><input type="radio" name="switch-strategy" checked={strategy === 'stash'} disabled={busy} onChange={() => setStrategy('stash')}/>Stash and apply on the new branch</label></>}
    {prompt.kind === 'apply-stash' && <><p>Apply this stash to the checked-out branch.</p><label className="choice"><input type="checkbox" checked={deleteAfter} disabled={busy} onChange={event => setDeleteAfter(event.target.checked)}/>Delete stash after successful application</label></>}
    {prompt.kind === 'delete-stash' && <p>Delete the selected stash? This removes its saved changes from the stash list.</p>}
    {error && <p role="alert" className="create-error">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" disabled={busy || !complete}>{busy ? 'Working...' : prompt.kind === 'create' ? 'Create Branch' : prompt.kind === 'apply-stash' ? 'Apply Stash' : 'Confirm'}</button></footer>
  </form></dialog>;
}

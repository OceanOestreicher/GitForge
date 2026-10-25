import { Message } from './messages';
import { useEffect, useRef, useState } from 'react';
export type BranchAction = { action: string; ref?: string; hash?: string; name?: string; paths?: string[]; strategy?: string; mode?: string; deleteAfter?: boolean; deleteRemote?: boolean; remoteRef?: string };
export type BranchPrompt = { kind: 'create' | 'reset' | 'switch' | 'stash' | 'apply-stash' | 'delete-stash' | 'delete-branch' | 'checkout-remote' | 'delete-remote-branch'; input: BranchAction; dirty?: boolean };
export function BranchDialog({ prompt, close, execute }: { prompt: BranchPrompt; close: () => void; execute: (input: BranchAction) => Promise<void> }) {
  const [name, setName] = useState(prompt.input.name ?? '');
  const [mode, setMode] = useState('keep');
  const [strategy, setStrategy] = useState('');
  const [deleteAfter, setDeleteAfter] = useState(false);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const title = { create: 'Create Branch', reset: 'Reset Branch To Commit', switch: 'Switch Branch', stash: 'Stash Changes', 'apply-stash': 'Apply Stash', 'delete-stash': 'Delete Stash', 'delete-branch': 'Delete Branch', 'checkout-remote': 'Create Local Branch', 'delete-remote-branch': 'Delete Remote Branch' }[prompt.kind];
  const chooseChanges = prompt.kind === 'switch' || (prompt.kind === 'checkout-remote' && prompt.dirty);
  const complete = !(['create', 'stash', 'checkout-remote'].includes(prompt.kind) && !name.trim()) && !(chooseChanges && !strategy);
  return <dialog ref={dialog} className="create-dialog" aria-labelledby="branch-dialog-title" onCancel={event => { event.preventDefault(); if (!submitting.current) close(); }}><header><h1 id="branch-dialog-title">{title}</h1></header><form onSubmit={async event => {
    event.preventDefault(); if (!complete || submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try { await execute({ ...prompt.input, name, mode, strategy, deleteAfter, deleteRemote }); close(); }
    catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : Message["operation.failed"]); setBusy(false); submitting.current = false; }
  }}>
    {prompt.kind === 'checkout-remote' && <p>Create and check out a local branch based on remote branch {prompt.input.ref?.slice(13).split('/').slice(1).join('/')}.</p>}
    {['create', 'stash', 'checkout-remote'].includes(prompt.kind) && <label>{prompt.kind === 'stash' ? 'Stash name' : 'Branch name'}<input autoFocus required disabled={busy} value={name} onChange={event => setName(event.target.value)}/></label>}
    {prompt.kind === 'reset' && <><p>Reset the current branch to {prompt.input.hash?.slice(0, 7)}.</p><label className="choice"><input type="radio" name="reset-mode" value="keep" checked={mode === 'keep'} disabled={busy} onChange={() => setMode('keep')}/>Keep changes as unstaged files</label><label className="choice"><input type="radio" name="reset-mode" value="discard" checked={mode === 'discard'} disabled={busy} onChange={() => setMode('discard')}/>Discard all changes</label></>}
    {chooseChanges && <><p>Uncommitted changes are present. Choose what to do before switching branches.</p><label className="choice"><input type="radio" name="switch-strategy" checked={strategy === 'discard'} disabled={busy} onChange={() => setStrategy('discard')}/>Discard changes</label><label className="choice"><input type="radio" name="switch-strategy" checked={strategy === 'stash'} disabled={busy} onChange={() => setStrategy('stash')}/>Stash and apply on the new branch</label></>}
    {prompt.kind === 'apply-stash' && <><p>Apply this stash to the checked-out branch.</p><label className="choice"><input type="checkbox" checked={deleteAfter} disabled={busy} onChange={event => setDeleteAfter(event.target.checked)}/>Delete stash after successful application</label></>}
    {prompt.kind === 'delete-remote-branch' && <p>Delete remote branch <strong>{prompt.input.ref?.slice(13).split('/').slice(1).join('/')}</strong>? Local branches and their files will be kept. Commits that exist only on the remote branch may be lost.</p>}
    {prompt.kind === 'delete-stash' && <p>Delete the selected stash? This removes its saved changes from the stash list.</p>}
    {prompt.kind === 'delete-branch' && <><p>Delete local branch <strong>{prompt.input.ref?.slice(11)}</strong>? Commits that exist only on this branch may be lost.</p>{prompt.input.remoteRef && <label className="choice"><input type="checkbox" checked={deleteRemote} disabled={busy} onChange={event => setDeleteRemote(event.target.checked)}/>Also delete remote branch {prompt.input.remoteRef.slice('refs/remotes/'.length)}</label>}</>}
    {error && <p role="alert" className="create-error">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" disabled={busy || !complete}>{busy ? 'Working...' : prompt.kind === 'create' ? 'Create Branch' : prompt.kind === 'apply-stash' ? 'Apply Stash' : 'Confirm'}</button></footer>
  </form></dialog>;
}

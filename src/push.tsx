import { useEffect, useRef, useState } from 'react';
import type { Repository } from './repository';
export type PushPlan = { branch: string; target: string; remote: string; url: string; needsRepository: boolean; needsBranch: boolean; owner?: string; name?: string };
export type PushInput = { force: boolean; confirmForce?: boolean; createBranch?: boolean; createRepository?: boolean; owner?: string; name?: string; visibility?: string };
export function PushDialog({ plan, force, close, pushed }: { plan: PushPlan; force: boolean; close: () => void; pushed: (input: PushInput) => Promise<void> }) {
  const [owner, setOwner] = useState(plan.owner ?? '');
  const [name, setName] = useState(plan.name ?? '');
  const [visibility, setVisibility] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog className="create-dialog" ref={dialog} aria-labelledby="push-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}><header><h1 id="push-dialog-title">{force ? 'Confirm Force Push' : plan.needsRepository ? 'Create Remote Repository' : 'Create Remote Branch'}</h1></header><form onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { await pushed({ force, confirmForce: force, createBranch: plan.needsBranch, createRepository: plan.needsRepository, owner, name, visibility }); }
    catch (error) { setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Push failed.'); setBusy(false); }
  }}>
    <p>Push {plan.branch} to {plan.remote}/{plan.target}.</p>
    {force && <p className="create-error">Force push can overwrite commits on the remote branch. Confirm that you want to replace the remote history with your local history.</p>}
    {plan.needsRepository && <><p>Create the GitHub repository and its branch before pushing. If this repository already exists, check your PAT access instead.</p><label>Owner<input required value={owner} disabled={busy || Boolean(plan.url)} onChange={e => setOwner(e.target.value)}/></label><label>Repository name<input required value={name} disabled={busy || Boolean(plan.url)} onChange={e => setName(e.target.value)}/></label><div className="parent-directory-field"><label htmlFor="push-visibility">Visibility</label><select id="push-visibility" required value={visibility} disabled={busy} onChange={e => setVisibility(e.target.value)}><option value="">Choose visibility</option><option value="private">Private</option><option value="public">Public</option></select></div></>}
    {!plan.needsRepository && plan.needsBranch && <p>The remote branch does not exist. Create it and publish your commits?</p>}
    {error && <p className="create-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" disabled={busy || (plan.needsRepository && (!owner.trim() || !name.trim() || !visibility))}>{busy ? 'Pushing...' : force ? 'Confirm Force Push' : 'Create and Push'}</button></footer>
  </form></dialog>;
}

import { useEffect, useState } from 'react';

const drafts = new Map<string, { title: string; description: string }>();
export function CommitForm({ draftKey, busy, staged, mergePending, commit, abort }: {
  draftKey: string; busy: boolean; staged: boolean; mergePending: boolean;
  commit: (input: { title: string; description: string }) => Promise<boolean>; abort: () => void;
}) {
  const [title, setTitle] = useState(() => drafts.get(draftKey)?.title ?? '');
  const [description, setDescription] = useState(() => drafts.get(draftKey)?.description ?? '');
  useEffect(() => {
    drafts.delete(draftKey); drafts.set(draftKey, { title, description });
    if (drafts.size > 64) drafts.delete(drafts.keys().next().value!);
  }, [draftKey, title, description]);
  return <div className="commit-form">{mergePending && <p className="merge-pending">Commit to complete the pending merge.</p>}
    <label>Commit title<input value={title} onChange={event => setTitle(event.target.value)} placeholder="Commit title"/></label>
    <label>Description<textarea aria-label="Description" value={description} onChange={event => setDescription(event.target.value)} placeholder="Description (optional)"/></label>
    <div className="commit-actions"><button className="commit-button" disabled={busy || (!staged && !mergePending) || !title.trim()} onClick={async () => {
      if (await commit({ title, description })) { setTitle(''); setDescription(''); }
    }}>Commit</button>{mergePending && <button className="abort-merge" disabled={busy} onClick={abort}>Abort Merge</button>}</div>
  </div>;
}

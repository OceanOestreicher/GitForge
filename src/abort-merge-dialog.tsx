import { useEffect, useRef, useState } from 'react';
import { Message } from './messages';

export function AbortMergeDialog({ close, execute }: { close: () => void; execute: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null), submitting = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="create-dialog abort-merge-dialog" aria-labelledby="abort-merge-title" onCancel={event => { event.preventDefault(); if (!submitting.current) close(); }}>
    <header><h1 id="abort-merge-title">{Message['conflict.abortTitle']}</h1></header>
    <form onSubmit={async event => {
      event.preventDefault(); if (submitting.current) return;
      submitting.current = true; setBusy(true); setError('');
      try { await execute(); close(); }
      catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : Message['conflict.updateFailed']); submitting.current = false; setBusy(false); }
    }}>
      <p>{Message['conflict.abortConfirmation']}</p>
      {error && <p role="alert" className="create-error">{error}</p>}
      <footer><button autoFocus type="button" disabled={busy} onClick={close}>Cancel</button><button className="abort-merge" type="submit" disabled={busy}>Abort Merge</button></footer>
    </form>
  </dialog>;
}

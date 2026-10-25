import { Message } from './messages';
import { useEffect, useRef, useState } from 'react';
import { conflictOutputLine, editOutput, generateOutput, initialSelections, outputText, updateSelections, type MergeFile, type Output, type Selections, type SourceLine } from './merge-output';

export type Conflict = { id: string; kind: 'merge' | 'pull' | 'stash'; index: number; total: number; path: string; file: MergeFile };
export type ConflictAction = { action: 'abort' | 'resolve'; id?: string; index?: number; choice?: 'ours' | 'theirs' | 'both'; resolveFile?: boolean; output?: string; deleteFile?: boolean };

function SelectAll({ label, checked, partial, disabled, change }: { label: string; checked: boolean; partial: boolean; disabled: boolean; change: (value: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = partial; }, [partial]);
  return <label className="merge-select-all"><input ref={input} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={event => change(event.target.checked)}/>Select all</label>;
}
function SourceCode({ rows, side, selections, disabled, change, region }: { region: number; rows: SourceLine[]; side: 'ours' | 'theirs'; selections: Selections; disabled: boolean; change: (region: number, line: number, value: boolean) => void }) {
  const code = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
    const pane = code.current, target = pane?.querySelector<HTMLElement>(`[data-region="${region}"]`);
    if (pane && target) pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 26;
    });
    return () => cancelAnimationFrame(frame);
  }, [region]);
  return <pre ref={code} className="merge-code" data-side={side}>{rows.map((row, index) => <span key={index} data-region={row.region} className={`merge-code-row${row.region !== undefined ? ' merge-conflict-line' : ''}`}>
    <span className="merge-line-choice">{row.region !== undefined && <input type="checkbox" aria-label={`Keep ${side === 'ours' ? 'local' : 'incoming'} ${row.number !== null ? `line ${row.number}` : `change ${row.region + 1}`}`} disabled={disabled} checked={Boolean(selections[row.region][side][row.line || 0])} onChange={event => change(row.region!, row.line || 0, event.target.checked)}/>}</span>
    <span className="merge-line-number" aria-label="Line number">{row.number ?? ''}</span><span className="merge-line-text">{row.text || ' '}</span>
  </span>)}</pre>;
}
function OutputEditor({ output, disabled, change, region, targetLine }: { region: number; targetLine: number; output: Output; disabled: boolean; change: (value: string) => void }) {
  const background = useRef<HTMLPreElement>(null), numbers = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const rows = output.ending || !output.rows.length ? [...output.rows, { text: '', conflict: false }] : output.rows;
  const sync = () => { if (input.current && background.current && numbers.current) { background.current.style.transform = `translate(${-input.current.scrollLeft}px, ${-input.current.scrollTop}px)`; numbers.current.style.transform = `translateY(${-input.current.scrollTop}px)`; } };
  useEffect(sync, [output]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (input.current) { input.current.scrollTop = Math.max(0, targetLine * 20 - 20); sync(); }
    });
    return () => cancelAnimationFrame(frame);
  }, [region]);
  return <div className="merge-output-editor">
    <div className="merge-output-gutter" aria-hidden="true"><div ref={numbers}>{rows.map((_, index) => <div key={index} className={rows[index].conflict ? "merge-conflict-line" : ""}>{index + 1}</div>)}</div></div>
    <div className="merge-output-surface"><pre ref={background} className="merge-output-highlights" aria-hidden="true">{rows.map((row, index) => <span key={index} className={row.conflict ? 'merge-conflict-line' : ''}>{row.text || ' '}</span>)}</pre>
      <textarea ref={input} className="merge-output-input" aria-label="Merge output" value={outputText(output)} disabled={disabled} spellCheck={false} wrap="off" onScroll={sync} onChange={event => change(event.target.value)}/>
    </div>
  </div>;
}

function FileResolution({ conflict, execute }: { conflict: Conflict; execute: (input: ConflictAction) => Promise<void> }) {
  const file = conflict.file;
  const [active, setActive] = useState(0);
  const region = file.regions[active].id;
  const [state, setState] = useState(() => { const selections = initialSelections(file); return { selections, output: generateOutput(file, selections), edited: false }; });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const working = useRef(false);
  const select = (side: 'ours' | 'theirs', value: boolean, region?: number, line?: number) => setState(previous => {
    const selections = Object.fromEntries(Object.entries(previous.selections).map(([id, selected]) => [Number(id), { ...selected, ours: [...selected.ours], theirs: [...selected.theirs] }])) as Selections;
    for (const item of file.regions) {
      if (region !== undefined && item.id !== region) continue;
      const selected = selections[item.id]; selected.touched = true;
      selected[side] = selected[side].map((old, index) => line === undefined || line === index ? value : old);
      if (value && !item.canBoth) selected[side === 'ours' ? 'theirs' : 'ours'].fill(false);
    }
    return { ...previous, selections, output: updateSelections(previous.output, generateOutput(file, selections)) };
  });
  const complete = file.editable ? state.edited || file.regions.every(region => state.selections[region.id].touched) : file.regions.every(region => state.selections[region.id].ours.some(Boolean) || state.selections[region.id].theirs.some(Boolean));
  const run = async (action: 'abort' | 'resolve') => {
    if (working.current) return; working.current = true; setBusy(true); setError('');
    const selected = state.selections[file.regions[0].id], ours = selected.ours.some(Boolean), theirs = selected.theirs.some(Boolean);
    try {
      await execute({ action, id: conflict.id, index: conflict.index, resolveFile: true, ...(file.editable ? { output: outputText(state.output), deleteFile: !state.edited && file.parts.length === 1 && ((file.oursDeleted && ours && !theirs) || (file.theirsDeleted && theirs && !ours)) } : { choice: ours && theirs ? 'both' : ours ? 'ours' : 'theirs' }) });
    } catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : Message['conflict.updateFailed']); }
    finally { working.current = false; setBusy(false); }
  };
  return <>
    <header><div className="merge-title-row"><h1 id="merge-title">Merge Conflicts</h1><span className="merge-conflict-count" aria-live="polite">Conflict {active + 1} of {file.regions.length}</span></div><p>{conflict.path} <span className="muted">File {file.index + 1} of {file.total}</span></p></header>
    <div className="merge-panes merge-file-sources">{(['ours', 'theirs'] as const).map(side => {
      const values = file.regions.flatMap(region => state.selections[region.id][side]);
      return <section key={side} aria-label={side === 'ours' ? 'Current branch code' : 'Incoming code'}><div className="merge-source-heading"><span className={`merge-side-badge ${side}`}>{side === 'ours' ? 'A' : 'B'}</span><h2>{side === 'ours' ? 'Current branch' : conflict.kind === 'stash' ? 'Stashed changes' : 'Incoming changes'}</h2><SelectAll label={`Select all ${side === 'ours' ? 'local' : 'incoming'} changes`} checked={values.every(Boolean)} partial={values.some(Boolean) && !values.every(Boolean)} disabled={busy} change={value => select(side, value)}/></div><SourceCode region={region} rows={side === 'ours' ? file.oursRows : file.theirsRows} side={side} selections={state.selections} disabled={busy} change={(region, line, value) => select(side, value, region, line)}/></section>;
    })}</div>
    <section className="merge-output-section" aria-label="Resolved file output"><div className="merge-output-heading"><h2>Output</h2><span className="muted">{file.editable ? 'Editable · local lines first, incoming lines below' : 'Choose a complete version of this file'}</span></div><OutputEditor region={region} targetLine={conflictOutputLine(file, state.output, region)} output={state.output} disabled={busy || !file.editable} change={value => setState(previous => ({ ...previous, edited: true, output: editOutput(previous.output, value) }))}/></section>
    {error && <p className="create-error merge-error" role="alert">{error}</p>}
    <footer><nav className="merge-conflict-navigation" aria-label="Conflict navigation"><button aria-label="Previous Conflict" title="Previous Conflict" disabled={busy || file.regions.length < 2} onClick={() => setActive(value => (value + file.regions.length - 1) % file.regions.length)}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button><button aria-label="Next Conflict" title="Next Conflict" disabled={busy || file.regions.length < 2} onClick={() => setActive(value => (value + 1) % file.regions.length)}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14m-6-6 6 6 6-6"/></svg></button></nav><button className="abort-merge" disabled={busy} onClick={() => void run('abort')}>Abort Merge</button><button className={file.index + 1 === file.total ? 'commit-button' : undefined} disabled={busy || !complete} onClick={() => void run('resolve')}>{file.index + 1 < file.total ? 'Next File' : 'Resolve'}</button></footer>
  </>;
}

export function MergeConflicts({ conflict, execute }: { conflict: Conflict; execute: (input: ConflictAction) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="merge-dialog merge-file-dialog" aria-labelledby="merge-title" onCancel={event => event.preventDefault()}>
    <FileResolution key={`${conflict.id}:${conflict.file.index}`} conflict={conflict} execute={execute}/>
  </dialog>;
}

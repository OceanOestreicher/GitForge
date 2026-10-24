import { useEffect, useRef, useState } from 'react';
import { parseDiff } from './diff';

export type FileChange = { path: string; status: string; untracked?: boolean; oldPath?: string };
export type Commit = { hash: string; parents: string[]; author: string; date: string; subject: string; refs: string };
export type Repository = { path: string; name: string; branch: string; local: string[]; remote: string[]; stashes: string[]; staged: FileChange[]; unstaged: FileChange[]; commits: Commit[] };
type Selection = { file: FileChange; staged?: boolean; hash?: string };

function FileList({ files, tree, select, selectedPath }: { files: FileChange[]; tree: boolean; select: (file: FileChange) => void; selectedPath?: string }) {
  const list = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const point = pointer.current;
        const row = point ? document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('.file-row') : null;
        setHoveredPath(row && list.current?.contains(row) ? row.dataset.filePath ?? null : null);
      });
    };
    const move = (event: PointerEvent) => { pointer.current = { x: event.clientX, y: event.clientY }; update(); };
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) { pointer.current = null; update(); } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerout', leave);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerout', leave);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [files, tree]);
  const render = (items: FileChange[], prefix = ''): React.ReactNode => {
    const groups = new Map<string, FileChange[]>();
    const leaves: FileChange[] = [];
    for (const file of items) {
      const relative = file.path.slice(prefix.length);
      const slash = relative.indexOf('/');
      if (slash < 0) leaves.push(file);
      else { const folder = relative.slice(0, slash); groups.set(folder, [...(groups.get(folder) ?? []), file]); }
    }
    return <>{[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([folder, children]) => <details open key={folder}><summary>{folder}</summary><div className="tree-children">{render(children, prefix + folder + '/')}</div></details>)}{leaves.map(file => <button className={`file-row${hoveredPath === file.path ? " file-hovered" : ""}`} data-file-path={file.path} aria-pressed={file.path === selectedPath} key={file.path} title={file.path} onClick={() => select(file)}><span className={`status status-${file.status}`}>{file.untracked ? '+' : file.status}</span>{file.path.slice(prefix.length)}</button>)}</>;
  };
  if (!files.length) return <p className="muted small">No files</p>;
  return <div className="file-list" ref={list}>{tree ? render(files) : files.map(file => <button className={`file-row${hoveredPath === file.path ? " file-hovered" : ""}`} data-file-path={file.path} aria-pressed={file.path === selectedPath} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} key={file.path} onClick={() => select(file)}><span className={`status status-${file.status}`}>{file.untracked ? '+' : file.status}</span>{file.path}</button>)}</div>;
}

export function RepositoryView({ initial }: { initial: Repository }) {
  const [repo, setRepo] = useState(initial);
  const [selected, setSelected] = useState<Commit | null>(null);
  const [details, setDetails] = useState<{ message: string; files: FileChange[] } | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [diff, setDiff] = useState('');
  const [error, setError] = useState('');
  const [tree, setTree] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(initial.commits.length === 200);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const requestId = useRef(0);
  const toggleFile = (next: Selection) => {
    setSelection(previous => previous?.file.path === next.file.path
      && Boolean(previous.staged) === Boolean(next.staged)
      && previous.hash === next.hash ? null : next);
  };

  useEffect(() => {
    let alive = true;
    if (!selected) { setDetails(null); return; }
    setDetails(null);
    window.gitforge.commitDetails(repo.path, selected.hash).then(value => { if (alive) setDetails(value); }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [selected, repo.path]);
  useEffect(() => {
    const id = ++requestId.current;
    setDiff('');
    if (!selection) return;
    window.gitforge.fileDiff(repo.path, { ...selection.file, staged: selection.staged, hash: selection.hash }).then(value => { if (id === requestId.current) setDiff(value || 'No textual changes.'); }).catch(e => { if (id === requestId.current) setError(String(e)); });
  }, [selection, repo.path]);
  useEffect(() => {
    const close = () => setContext(null);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('click', close); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', key); };
  }, []);
  return <div className="repository">
    <header className="repo-actions"><div className="repo-name" title={repo.path}><strong>{repo.name}</strong><span>{repo.branch}</span></div><div className="repo-buttons">{['Pull', 'Push', 'Branch', 'Fetch'].map(action => <button key={action}>{action}</button>)}</div></header>
    {error && <div className="error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="repo-layout">
      <aside className="repo-sidebar">
        <details className="sidebar-group" open><summary>Local branches</summary><div className="sidebar-items">{repo.local.map(branch => <div className={branch === repo.branch ? 'current-branch' : ''} key={branch}>{branch === repo.branch ? '\u25CF ' : ''}{branch}</div>)}{!repo.local.length && <p className="muted">No local branches</p>}</div></details>
        <details className="sidebar-group"><summary>Remote branches</summary><div className="sidebar-items">{repo.remote.map(branch => <div key={branch}>{branch}</div>)}{!repo.remote.length && <p className="muted">No remote branches</p>}</div></details>
        <details className="sidebar-group"><summary>Stashes</summary><div className="sidebar-items">{repo.stashes.map(stash => <div key={stash}>{stash}</div>)}{!repo.stashes.length && <p className="muted">No stashes</p>}</div></details>
      </aside>
      <main className="repo-center"><section className="history" hidden={selection !== null}><div className="section-heading"><h2>Commit history</h2></div>
        <table><thead><tr><th>Commit</th><th>Author</th><th>Date</th></tr></thead><tbody><tr className={selected === null ? 'selected wip-row' : 'wip-row'}><td colSpan={3}><button className="commit-link wip-link" onClick={() => { setSelected(null); setSelection(null); }}><span className="wip-marker" aria-hidden="true"/>WIP <span className="muted">{new Set([...repo.unstaged, ...repo.staged].map(file => file.path)).size} files changed</span></button></td></tr>{repo.commits.map(commit => <tr key={commit.hash} className={selected?.hash === commit.hash ? 'selected' : ''} onContextMenu={event => { event.preventDefault(); setContext({ x: Math.min(event.clientX, window.innerWidth - 250), y: Math.min(event.clientY, window.innerHeight - 130) }); }}><td><button className="commit-link" onClick={() => { setSelected(commit); setSelection(null); }}><code>{commit.hash.slice(0, 7)}</code> {commit.subject}{commit.refs && <span className="refs">{commit.refs}</span>}</button></td><td>{commit.author}</td><td>{new Date(commit.date).toLocaleDateString()}</td></tr>)}</tbody></table>
        {!repo.commits.length && <p className="muted">This repository has no commits yet.</p>}
        {hasMore && <button disabled={loadingMore} onClick={async () => { setLoadingMore(true); try { const more = await window.gitforge.moreCommits(repo.path, repo.commits.length); setRepo(previous => ({ ...previous, commits: [...previous.commits, ...more] })); setHasMore(more.length === 200); } catch(e) { setError(String(e)); } finally { setLoadingMore(false); } }}>Load more commits</button>}
      </section>
      <section className="detail-panel diff-panel" aria-label="Diff pane" hidden={selection === null}><div className="section-heading"><h2>File diff</h2></div>
        {selection ? <><h3 className="diff-path">{selection.file.path}</h3><pre className="diff" aria-label="File diff">{diff ? parseDiff(diff).map((row, index) => <div className={`diff-row ${row.kind}${row.startsHunk ? ' hunk-start' : ''}`} key={index}><span className="line-number old-line" aria-label="Old line number">{row.oldLine ?? ''}</span><span className="line-number new-line" aria-label="New line number">{row.newLine ?? ''}</span><span className="diff-code">{row.marker ? `${row.marker} ${row.text}` : row.text || ' '}</span></div>) : 'Loading diff…'}</pre></> : <p className="muted">Select a file to view its changes.</p>}
      </section>
      </main>
      {selected ? <section className="commit-information"><div className="section-heading"><h2>Commit information</h2><button aria-pressed={tree} onClick={() => setTree(value => !value)}>{tree ? 'Path view' : 'Tree view'}</button></div>
        <><dl className="commit-metadata"><dt>Hash</dt><dd>{selected.hash}</dd><dt>Parents</dt><dd>{selected.parents.join(', ') || 'None (initial commit)'}</dd><dt>Author</dt><dd>{selected.author}</dd><dt>Date</dt><dd>{new Date(selected.date).toLocaleString()}</dd></dl>{details ? <><pre className="commit-message">{details.message}</pre><p className="summary-counts">{details.files.filter(f => f.status === 'A').length} added · {details.files.filter(f => f.status === 'M').length} changed · {details.files.filter(f => f.status === 'D').length} deleted</p><FileList files={details.files} tree={tree} selectedPath={selection?.hash === selected.hash ? selection.file.path : undefined} select={file => toggleFile({ file, hash: selected.hash })}/></> : <p>Loading commit…</p>}</>
      </section> : 
      <section className="working-changes"><div className="section-heading"><h2>Working changes</h2><button aria-pressed={tree} onClick={() => setTree(value => !value)}>{tree ? 'Path view' : 'Tree view'}</button></div><section className="change-group"><h3>Unstaged files ({repo.unstaged.length})</h3><div className="change-scroll" role="region" aria-label="Unstaged files" tabIndex={0}><FileList files={repo.unstaged} tree={tree} selectedPath={selection && !selection.hash && !selection.staged ? selection.file.path : undefined} select={file => { setSelected(null); toggleFile({ file }); }}/></div></section><section className="change-group"><h3>Staged files ({repo.staged.length})</h3><div className="change-scroll" role="region" aria-label="Staged files" tabIndex={0}><FileList files={repo.staged} tree={tree} selectedPath={selection && !selection.hash && selection.staged ? selection.file.path : undefined} select={file => { setSelected(null); toggleFile({ file, staged: true }); }}/></div></section><div className="commit-form"><label>Commit title<input value={title} onChange={event => setTitle(event.target.value)} placeholder="Commit title"/></label><label>Description<textarea value={description} onChange={event => setDescription(event.target.value)} placeholder="Description (optional)"/></label><button>Commit</button></div></section> }


    </div>
    {context && <div role="menu" className="context-menu" style={{ left: context.x, top: context.y }}>{['Checkout Commit', 'Reset Branch To Commit', 'Create Branch From Commit'].map(action => <button role="menuitem" key={action} onClick={() => setContext(null)}>{action}</button>)}</div>}
  </div>;
}

import { useEffect, useRef, useState } from 'react';
import { parseDiff } from './diff';
import { HistoryBranches, type HistoryLabel } from './history-branches';
import { PushDialog, type PushPlan } from './push';
import { BranchDialog, type BranchAction, type BranchPrompt } from './branch-dialog';

export type FileChange = { path: string; status: string; untracked?: boolean; oldPath?: string };
export type Commit = { hash: string; parents: string[]; author: string; date: string; subject: string; refs: string; labels: HistoryLabel[] };
export type Repository = { path: string; name: string; branch: string; local: string[]; remote: string[]; ahead: Record<string, number>; behind: Record<string, number>; fileVersion: string; unpushed: number; canPush: boolean; remoteBranches: Record<string, { ref: string; remote: string; branch: string }>; stashes: string[]; stashEntries: { ref: string; hash: string; message: string }[]; staged: FileChange[]; unstaged: FileChange[]; commits: Commit[] };
type Selection = { file: FileChange; staged?: boolean; hash?: string };

function FileList({ files, tree, select, selectedPath, markedPaths = [], doubleClick, discard, contextMenu }: { files: FileChange[]; tree: boolean; select: (file: FileChange, event: React.MouseEvent<HTMLButtonElement>) => void; selectedPath?: string; markedPaths?: string[]; doubleClick?: (file: FileChange) => void; discard?: () => void; contextMenu?: (file: FileChange, event: React.MouseEvent<HTMLButtonElement>) => void }) {
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
    return <>{[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([folder, children]) => <details open key={folder}><summary>{folder}</summary><div className="tree-children">{render(children, prefix + folder + '/')}</div></details>)}{leaves.map(file => <button className={`file-row${hoveredPath === file.path ? " file-hovered" : ""}`} data-file-path={file.path} aria-pressed={file.path === selectedPath || markedPaths.includes(file.path)} key={file.path} title={file.path} onClick={event => select(file, event)} onDoubleClick={() => doubleClick?.(file)} onContextMenu={event => contextMenu?.(file, event)}><span className={`status status-${file.status}`}>{file.untracked ? '+' : file.status}</span>{file.path.slice(prefix.length)}</button>)}</>;
  };
  if (!files.length) return <p className="muted small">No files</p>;
  return <div className="file-list" ref={list} onKeyDown={event => { if (event.key === 'Delete' && discard) { event.preventDefault(); discard(); } }}>{tree ? render(files) : files.map(file => <button className={`file-row${hoveredPath === file.path ? " file-hovered" : ""}`} data-file-path={file.path} aria-pressed={file.path === selectedPath || markedPaths.includes(file.path)} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} key={file.path} onClick={event => select(file, event)} onDoubleClick={() => doubleClick?.(file)} onContextMenu={event => contextMenu?.(file, event)}><span className={`status status-${file.status}`}>{file.untracked ? '+' : file.status}</span>{file.path}</button>)}</div>;
}

export function RepositoryView({ initial, updated }: { initial: Repository; updated: (repo: Repository) => void }) {
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
  const [context, setContext] = useState<{ x: number; y: number; kind: 'commit' | 'branch' | 'stash' | 'files'; target: string; paths?: string[]; canReset?: boolean } | null>(null);
  const [prompt, setPrompt] = useState<BranchPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<{ staged: boolean; paths: string[]; anchor?: string }>({ staged: false, paths: [] });
  const [pushMenu, setPushMenu] = useState(false);
  const [pushDialog, setPushDialog] = useState<{ plan: PushPlan; force: boolean } | null>(null);
  const accept = (value: Repository) => { setRepo(value); updated(value); setSelection(null); setPicked({ staged: false, paths: [] }); };
  const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error);
  const change = async (action: string, paths = picked.paths) => {
    if (busy || !paths.length) return;
    setBusy(true); setError('');
    try { accept(await window.gitforge.changeFiles(repo.path, { action, paths })); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const chooseFile = (file: FileChange, staged: boolean, event: React.MouseEvent<HTMLButtonElement>) => {
    if (busy) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      let paths = picked.staged === staged ? [...picked.paths] : [];
      if (event.shiftKey && picked.staged === staged && picked.anchor) {
        const order = Array.from(event.currentTarget.closest('.file-list')!.querySelectorAll<HTMLElement>('.file-row')).map(row => row.dataset.filePath!);
        const a = order.indexOf(picked.anchor), b = order.indexOf(file.path);
        paths = a >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [file.path];
      } else paths = paths.includes(file.path) ? paths.filter(path => path !== file.path) : [...paths, file.path];
      setPicked({ staged, paths, anchor: picked.anchor ?? file.path }); setSelection(null);
    } else {
      const closing = selection?.file.path === file.path && Boolean(selection.staged) === staged && !selection.hash;
      setPicked({ staged, paths: closing ? [] : [file.path], anchor: file.path });
      toggleFile({ file, staged });
    }
  };
  const startPush = async (force: boolean, branch = repo.branch) => {
    if (busy || !repo.local.includes(branch) || (repo.remoteBranches[branch] && !repo.ahead[branch])) return; setBusy(true); setError(''); setPushMenu(false);
    try {
      const plan = await window.gitforge.preparePush(repo.path, branch);
      if (force || plan.needsBranch || plan.needsRepository) setPushDialog({ plan, force });
      else accept(await window.gitforge.pushCommits(repo.path, { force: false, branch }));
    } catch(error) { setError(message(error)); } finally { setBusy(false); }
  };
  const runRemote = async (action: 'fetch' | 'pull', ref?: string) => {
    if (busy) return; setBusy(true); setError('');
    try { accept(await (action === 'fetch' ? window.gitforge.fetchRepository(repo.path, ref) : window.gitforge.pullRepository(repo.path, ref?.slice(11)))); }
    catch(error) { setError(message(error)); } finally { setBusy(false); }
  };
  useEffect(() => {
    setRepo(previous => {
      const sameHistory = initial.commits.every((commit, index) => previous.commits[index]?.hash === commit.hash) && initial.commits.length <= previous.commits.length;
      if (!sameHistory) setHasMore(initial.commits.length === 200);
      return sameHistory ? { ...initial, commits: previous.commits.map(commit => initial.commits.find(fresh => fresh.hash === commit.hash) ?? commit) } : initial;
    });
    setSelection(previous => !previous || previous.hash || (previous.staged ? initial.staged : initial.unstaged).some(file => file.path === previous.file.path) ? previous : null);
    setPicked(previous => ({ ...previous, paths: previous.paths.filter(path => (previous.staged ? initial.staged : initial.unstaged).some(file => file.path === path)) }));
  }, [initial]);
  const executeBranch = async (input: BranchAction) => {
    if (busy) throw new Error('Wait for the current operation to finish.');
    setBusy(true); setError('');
    try { accept(await window.gitforge.branchAction(repo.path, input)); setSelected(null); setSelection(null); setPicked({ staged: false, paths: [] }); }
    finally { setBusy(false); }
  };
  const runBranch = (input: BranchAction) => { void executeBranch(input).catch(error => setError(message(error))); };
  const showMenu = (event: React.MouseEvent, kind: 'commit' | 'branch' | 'stash' | 'files', target: string, paths?: string[]) => {
    event.preventDefault(); if (busy) return;
    setContext({ kind, target, paths, x: Math.min(event.clientX, window.innerWidth - 250), y: Math.min(event.clientY, window.innerHeight - (kind === 'branch' ? 285 : 170)) });
    if (kind === 'commit') void window.gitforge.canResetCommit(repo.path, target).then(canReset => setContext(previous => previous?.kind === 'commit' && previous.target === target ? { ...previous, canReset } : previous)).catch(() => {});
  };
  const switchBranch = (ref: string) => {
    if (busy || ref === `refs/heads/${repo.branch}`) return;
    if (ref.startsWith('refs/remotes/')) setPrompt({ kind: 'checkout-remote', dirty: Boolean(repo.staged.length || repo.unstaged.length), input: { action: 'switch', ref, name: ref.slice(13).split('/').slice(1).join('/') } });
    else if (repo.staged.length || repo.unstaged.length) setPrompt({ kind: 'switch', input: { action: 'switch', ref } });
    else runBranch({ action: 'switch', ref });
  };
  const fileMenu = (staged: boolean, file: FileChange, event: React.MouseEvent<HTMLButtonElement>) => {
    const paths = picked.staged === staged && picked.paths.includes(file.path) ? picked.paths : [file.path];
    setPicked({ staged, paths, anchor: file.path });
    showMenu(event, 'files', file.path, paths);
  };
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
  }, [selection, repo.path, repo.fileVersion]);
  useEffect(() => {
    const close = () => setContext(null);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('click', close); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', key); };
  }, []);
  return <div className="repository">
    <header className="repo-actions"><div className="repo-name" title={repo.path}><strong>{repo.name}</strong><span>{repo.branch}</span></div><div className="repo-buttons"><button disabled={busy} onClick={() => void runRemote('pull')}>Pull</button><div className="push-control"><button disabled={busy || !repo.canPush} onClick={() => void startPush(false)}>Push</button><button disabled={busy || !repo.canPush} aria-label="Push options" onClick={() => setPushMenu(value => !value)}>&#9662;</button>{pushMenu && <div className="profile-menu"><button onClick={() => void startPush(true)}>Force Push</button></div>}</div><button disabled={busy || !repo.local.includes(repo.branch)} onClick={() => setPrompt({ kind: 'create', input: { action: 'create', ref: `refs/heads/${repo.branch}` } })}>Branch</button><button disabled={busy} onClick={() => void runRemote('fetch')}>Fetch</button></div></header>
    {error && <div className="error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="repo-layout">
      <aside className="repo-sidebar">
        <details className="sidebar-group" open><summary>Local branches</summary><div className="sidebar-items">{repo.local.map(branch => <div className={`${branch === repo.branch ? 'current-branch ' : ''}branch-row${repo.remoteBranches[branch] ? '' : ' local-only-branch'}`} title={repo.remoteBranches[branch] ? undefined : 'Local branch: not published to a remote'} key={branch} onDoubleClick={() => switchBranch(`refs/heads/${branch}`)} onContextMenu={event => showMenu(event, 'branch', `refs/heads/${branch}`)}>{branch === repo.branch ? '\u25CF ' : ''}{branch}{repo.remoteBranches[branch] && repo.ahead[branch] > 0 && <span className="ahead-count" aria-label={`${repo.ahead[branch]} commits to push`}> {repo.ahead[branch]} <span aria-hidden="true">&#8593;</span></span>}{repo.behind[branch] > 0 && <span className="behind-count" aria-label={`${repo.behind[branch]} commits to pull`}> {repo.behind[branch]} <span aria-hidden="true">&#8595;</span></span>}</div>)}{!repo.local.length && <p className="muted">No local branches</p>}</div></details>
        <details className="sidebar-group"><summary>Remote branches</summary><div className="sidebar-items">{repo.remote.map(branch => <div className="branch-row" key={branch} onDoubleClick={() => switchBranch(`refs/remotes/${branch}`)} onContextMenu={event => showMenu(event, 'branch', `refs/remotes/${branch}`)}>{branch.split('/').slice(1).join('/')}</div>)}{!repo.remote.length && <p className="muted">No remote branches</p>}</div></details>
        <details className="sidebar-group"><summary>Stashes</summary><div className="sidebar-items">{repo.stashEntries.map(stash => <div className="stash-row" key={stash.ref} onContextMenu={event => showMenu(event, 'stash', stash.hash)}>{stash.message}</div>)}{!repo.stashes.length && <p className="muted">No stashes</p>}</div></details>
      </aside>
      <main className="repo-center"><section className="history" hidden={selection !== null}><div className="section-heading"><h2>Commit history</h2></div>
        <table className="history-table"><thead><tr><th>Branch / Tag</th><th>Commit</th><th>Author</th><th>Date</th></tr></thead><tbody><tr className={selected === null ? 'selected wip-row' : 'wip-row'}><td/><td colSpan={3}><button className="commit-link wip-link" onClick={() => { setSelected(null); setSelection(null); setPicked({ staged: false, paths: [] }); }}><span className="wip-marker" aria-hidden="true"/>WIP <span className="muted">{new Set([...repo.unstaged, ...repo.staged].map(file => file.path)).size} files changed</span></button></td></tr>{repo.commits.map(commit => <tr key={commit.hash} className={selected?.hash === commit.hash ? 'selected' : ''} onContextMenu={event => showMenu(event, 'commit', commit.hash)}><td className="history-branch-cell"><HistoryBranches labels={commit.labels}/></td><td><button className="commit-link" onClick={() => { setSelected(commit); setSelection(null); setPicked({ staged: false, paths: [] }); }}><code>{commit.hash.slice(0, 7)}</code> {commit.subject}</button></td><td>{commit.author}</td><td>{new Date(commit.date).toLocaleDateString()}</td></tr>)}</tbody></table>
        {!repo.commits.length && <p className="muted">This repository has no commits yet.</p>}
        {hasMore && <button disabled={loadingMore} onClick={async () => { setLoadingMore(true); try { const more = await window.gitforge.moreCommits(repo.path, repo.commits.length); setRepo(previous => ({ ...previous, commits: [...previous.commits, ...more] })); setHasMore(more.length === 200); } catch(e) { setError(String(e)); } finally { setLoadingMore(false); } }}>Load more commits</button>}
      </section>
      <section className="detail-panel diff-panel" aria-label="Diff pane" hidden={selection === null}><div className="section-heading"><h2>File diff</h2></div>
        {selection ? <><h3 className="diff-path">{selection.file.path}</h3><pre className="diff" aria-label="File diff">{diff ? parseDiff(diff).map((row, index) => <div className={`diff-row ${row.kind === 'notice' ? 'diff-notice' : row.kind}${row.startsHunk ? ' hunk-start' : ''}`} key={index}><span className="line-number old-line" aria-label="Old line number">{row.oldLine ?? ''}</span><span className="line-number new-line" aria-label="New line number">{row.newLine ?? ''}</span><span className="diff-code">{row.marker ? `${row.marker} ${row.text}` : row.text || ' '}</span></div>) : 'Loading diff…'}</pre></> : <p className="muted">Select a file to view its changes.</p>}
      </section>
      </main>
      {selected ? <section className="commit-information"><div className="section-heading"><h2>Commit information</h2><button aria-pressed={tree} onClick={() => setTree(value => !value)}>{tree ? 'Path view' : 'Tree view'}</button></div>
        <><dl className="commit-metadata"><dt>Hash</dt><dd>{selected.hash}</dd><dt>Parents</dt><dd>{selected.parents.join(', ') || 'None (initial commit)'}</dd><dt>Author</dt><dd>{selected.author}</dd><dt>Date</dt><dd>{new Date(selected.date).toLocaleString()}</dd></dl>{details ? <><pre className="commit-message">{details.message}</pre><p className="summary-counts">{details.files.filter(f => f.status === 'A').length} added · {details.files.filter(f => f.status === 'M').length} changed · {details.files.filter(f => f.status === 'D').length} deleted</p><FileList files={details.files} tree={tree} selectedPath={selection?.hash === selected.hash ? selection.file.path : undefined} select={file => toggleFile({ file, hash: selected.hash })}/></> : <p>Loading commit…</p>}</>
      </section> : 
      <section className="working-changes"><div className="section-heading"><h2>Working changes</h2><button aria-pressed={tree} onClick={() => setTree(value => !value)}>{tree ? 'Path view' : 'Tree view'}</button></div><section className="change-group"><div className="change-heading"><h3>Unstaged files ({repo.unstaged.length})</h3><button disabled={busy || !repo.unstaged.length} onClick={() => void change('stage', repo.unstaged.map(file => file.path))}>Stage All</button></div><div className="change-scroll" role="region" aria-label="Unstaged files" tabIndex={0}><FileList files={repo.unstaged} tree={tree} selectedPath={selection && !selection.hash && !selection.staged ? selection.file.path : undefined} markedPaths={!picked.staged ? picked.paths : []} select={(file, event) => { setSelected(null); chooseFile(file, false, event); }} doubleClick={file => void change('stage', !picked.staged && picked.paths.includes(file.path) ? picked.paths : [file.path])} discard={() => { if (!picked.staged) void change('discard'); }} contextMenu={(file, event) => fileMenu(false, file, event)}/></div></section><section className="change-group"><div className="change-heading"><h3>Staged files ({repo.staged.length})</h3><button disabled={busy || !repo.staged.length} onClick={() => void change('unstage', repo.staged.map(file => file.path))}>Unstage All</button></div><div className="change-scroll" role="region" aria-label="Staged files" tabIndex={0}><FileList files={repo.staged} tree={tree} selectedPath={selection && !selection.hash && selection.staged ? selection.file.path : undefined} markedPaths={picked.staged ? picked.paths : []} select={(file, event) => { setSelected(null); chooseFile(file, true, event); }} doubleClick={file => void change('unstage', picked.staged && picked.paths.includes(file.path) ? picked.paths : [file.path])} contextMenu={(file, event) => fileMenu(true, file, event)}/></div></section><div className="commit-form"><label>Commit title<input value={title} onChange={event => setTitle(event.target.value)} placeholder="Commit title"/></label><label>Description<textarea value={description} onChange={event => setDescription(event.target.value)} placeholder="Description (optional)"/></label><button disabled={busy || !repo.staged.length || !title.trim()} onClick={async () => { if (busy) return; setBusy(true); setError(''); try { accept(await window.gitforge.commitChanges(repo.path, { title, description })); setTitle(''); setDescription(''); } catch(error) { setError(message(error)); } finally { setBusy(false); } }}>Commit</button></div></section> }


    </div>
    {pushDialog && <PushDialog plan={pushDialog.plan} force={pushDialog.force} close={() => setPushDialog(null)} pushed={async input => { const value = await window.gitforge.pushCommits(repo.path, input); accept(value); setPushDialog(null); }}/ >}
    {prompt && <BranchDialog prompt={prompt} close={() => setPrompt(null)} execute={executeBranch}/>}
    {context && <div role="menu" className="context-menu" style={{ left: context.x, top: context.y }}>
      {context.kind === 'commit' && <><button role="menuitem" onClick={() => runBranch({ action: 'checkout', hash: context.target })}>Checkout Commit</button><button role="menuitem" disabled={!context.canReset} onClick={() => setPrompt({ kind: 'reset', input: { action: 'reset', hash: context.target } })}>Reset Branch To Commit</button><button role="menuitem" onClick={() => setPrompt({ kind: 'create', input: { action: 'create', hash: context.target } })}>Create Branch From Commit</button></>}
      {context.kind === 'branch' && <><div role="group" aria-label="Remote actions"><button role="menuitem" disabled={busy || !context.target.startsWith('refs/heads/') || !repo.remoteBranches[context.target.slice(11)] || !repo.behind[context.target.slice(11)] || (context.target === `refs/heads/${repo.branch}` ? Boolean(repo.staged.length || repo.unstaged.length) : Boolean(repo.ahead[context.target.slice(11)]))} onClick={() => void runRemote('pull', context.target)}>Pull</button><button role="menuitem" disabled={busy || (context.target.startsWith('refs/heads/') && !repo.remoteBranches[context.target.slice(11)])} onClick={() => void runRemote('fetch', context.target)}>Fetch</button><button role="menuitem" disabled={busy || !context.target.startsWith('refs/heads/') || Boolean(repo.remoteBranches[context.target.slice(11)] && !repo.ahead[context.target.slice(11)])} onClick={() => void startPush(false, context.target.slice(11))}>Push</button></div><div role="separator" className="context-menu-separator"/><button role="menuitem" disabled={context.target === `refs/heads/${repo.branch}`} onClick={() => runBranch({ action: 'merge', ref: context.target })}>Merge into current branch</button><button role="menuitem" onClick={() => setPrompt({ kind: 'create', input: { action: 'create', ref: context.target } })}>Create Branch</button>{context.target.startsWith('refs/heads/') && context.target !== `refs/heads/${repo.branch}` && <button role="menuitem" onClick={() => setPrompt({ kind: 'delete-branch', input: { action: 'delete-branch', ref: context.target, remoteRef: repo.remoteBranches[context.target.slice(11)]?.ref } })}>Delete Branch</button>}{context.target.startsWith('refs/remotes/') && <button role="menuitem" onClick={() => setPrompt({ kind: 'delete-remote-branch', input: { action: 'delete-remote-branch', ref: context.target } })}>Delete Branch</button>}</>}
      {context.kind === 'files' && <button role="menuitem" onClick={() => setPrompt({ kind: 'stash', input: { action: 'stash', paths: context.paths } })}>Stash</button>}
      {context.kind === 'stash' && <><button role="menuitem" onClick={() => setPrompt({ kind: 'apply-stash', input: { action: 'apply-stash', hash: context.target } })}>Apply Stash</button><button role="menuitem" onClick={() => setPrompt({ kind: 'delete-stash', input: { action: 'delete-stash', hash: context.target } })}>Delete Stash</button></>}
    </div>}
  </div>;
}

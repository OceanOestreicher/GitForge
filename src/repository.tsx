import { buildHistoryGraph } from './commit-graph';
import { GraphCell } from './graph-cell';
import { AbortMergeDialog } from './abort-merge-dialog';
import { Message } from './messages';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseDiff } from './diff';
import { MergeConflicts, type Conflict } from './merge-conflicts';
import { HistoryBranches, type HistoryLabel } from './history-branches';
import { PushDialog, type PushPlan } from './push';
import { BranchDialog, type BranchAction, type BranchPrompt } from './branch-dialog';

function BranchIcon() {
  return <svg className="branch-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="19" r="3"/><path d="M6 8v8m12-7a9 9 0 0 1-9 9"/></svg>;
}
function BranchSpinner() { return <span className="branch-spinner" role="status" aria-label="Branch operation in progress"/>; }

export type FileChange = { path: string; status: string; untracked?: boolean; oldPath?: string };
export type Commit = { hash: string; parents: string[]; author: string; date: string; subject: string; refs: string; labels: HistoryLabel[] };
export type Repository = { path: string; name: string; branch: string; head: string | null; local: string[]; remote: string[]; ahead: Record<string, number>; behind: Record<string, number>; fileVersion: string; unpushed: number; canPush: boolean; mergePending: boolean; conflict: Conflict | null; remoteBranches: Record<string, { ref: string; remote: string; branch: string }>; stashes: string[]; stashEntries: { ref: string; hash: string; message: string }[]; staged: FileChange[]; unstaged: FileChange[]; commits: Commit[] };
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
  const [confirmingAbort, setConfirmingAbort] = useState(false);
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
  const [context, setContext] = useState<{ x: number; y: number; kind: 'commit' | 'branch' | 'stash' | 'files'; target: string; paths?: string[]; staged?: boolean; canReset?: boolean } | null>(null);
  const [prompt, setPrompt] = useState<BranchPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedSidebarItem, setSelectedSidebarItem] = useState<string | null>(null);
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ staged: boolean; paths: string[]; anchor?: string }>({ staged: false, paths: [] });
  const [pushMenu, setPushMenu] = useState(false);
  const [pushDialog, setPushDialog] = useState<{ plan: PushPlan; force: boolean } | null>(null);
  const [filterDraft, setFilterDraft] = useState(''), [filter, setFilter] = useState('');
  const query = filter.toLowerCase();
  const localBranches = repo.local.filter(name => name.toLowerCase().includes(query));
  const remoteBranches = repo.remote.filter(name => name.split('/').slice(1).join('/').toLowerCase().includes(query));
  const filteredStashes = repo.stashEntries.filter(stash => stash.message.toLowerCase().includes(query));
  const hasWorkingChanges = Boolean(repo.staged.length || repo.unstaged.length);
  const graphOffset = hasWorkingChanges ? 1 : 0;
  const graph = useMemo(() => buildHistoryGraph(repo.commits, repo.head, hasWorkingChanges), [repo.commits, repo.head, hasWorkingChanges]);
  const historyElement = useRef<HTMLElement>(null);
  const history = useRef(repo.commits); history.current = repo.commits;
  const remaining = useRef(hasMore); remaining.current = hasMore;
  const pageRequest = useRef<Promise<Commit[]> | null>(null);
  const navigationId = useRef(0);
  const [scrollRequest, setScrollRequest] = useState<{ hash: string; id: number } | null>(null);
  const loadPage = (): Promise<Commit[]> => {
    if (pageRequest.current) return pageRequest.current;
    const base = history.current;
    setLoadingMore(true);
    const request = (async () => {
      const more = await window.gitforge.moreCommits(repo.path, base.length);
      if (history.current[0]?.hash !== base[0]?.hash || history.current.length !== base.length) return history.current;
      const known = new Set(base.map(commit => commit.hash));
      const combined = [...base, ...more.filter(commit => !known.has(commit.hash))];
      history.current = combined; remaining.current = more.length === 200 && combined.length > base.length;
      setRepo(previous => ({ ...previous, commits: combined })); setHasMore(remaining.current);
      return combined;
    })();
    pageRequest.current = request;
    void request.finally(() => { if (pageRequest.current === request) { pageRequest.current = null; setLoadingMore(false); } }).catch(() => {});
    return request;
  };
  const navigateToCommit = async (hash: string, select: boolean) => {
    const id = ++navigationId.current;
    try {
      let loaded = history.current;
      while (!loaded.some(commit => commit.hash === hash) && remaining.current) {
        loaded = await loadPage(); if (id !== navigationId.current) return;
      }
      if (id !== navigationId.current) return;
      const commit = loaded.find(commit => commit.hash === hash);
      if (!commit) { if (select) setError(Message['history.commitUnavailable']); return; }
      if (select) { setSelected(commit); setSelection(null); setPicked({ staged: false, paths: [] }); }
      setScrollRequest({ hash, id });
    } catch (failure) { if (id === navigationId.current) setError(message(failure)); }
  };
  useEffect(() => {
    if (repo.head && !repo.conflict) {
      if (!history.current.some(commit => commit.hash === repo.head) && repo.commits.length >= 200) { remaining.current = true; setHasMore(true); }
      void navigateToCommit(repo.head, false);
    }
    return () => { navigationId.current++; };
  }, [repo.head, repo.branch, Boolean(repo.conflict)]);
  useEffect(() => {
    if (!scrollRequest || selection || repo.conflict) return;
    const frame = requestAnimationFrame(() => {
      const row = historyElement.current?.querySelector<HTMLElement>(`[data-commit-hash="${scrollRequest.hash}"]`);
      if (row) { row.scrollIntoView({ block: 'nearest' }); setScrollRequest(previous => previous?.id === scrollRequest.id ? null : previous); }
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollRequest, repo.commits.length, selection, Boolean(repo.conflict)]);
  const accept = (value: Repository) => { setRepo(value); updated(value); setSelection(null); setPicked({ staged: false, paths: [] }); };
  const fileClickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelFileClick = () => clearTimeout(fileClickTimer.current);
  useEffect(() => cancelFileClick, [selected, Boolean(repo.conflict)]);
  const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error);
  const change = async (action: string, paths = picked.paths) => {
    cancelFileClick();
    if (busy || !paths.length) return;
    setBusy(true); setError('');
    try { accept(await window.gitforge.changeFiles(repo.path, { action, paths })); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const chooseFile = (file: FileChange, staged: boolean, event: React.MouseEvent<HTMLButtonElement>) => {
    if (busy) return;
    cancelFileClick();
    if (event.detail > 1) return;
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
      // Keep selection immediate, but let a double click cancel the diff toggle.
      fileClickTimer.current = setTimeout(() => toggleFile({ file, staged }), 220);
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
    if (busy) throw new Error(Message["operation.inProgress"]);
    setBusy(true); setError('');
    setPendingBranch(input.action === 'merge' ? `refs/heads/${repo.branch}` : input.action === 'switch' ? input.ref ?? null : input.action === 'create' ? `refs/heads/${input.name}` : null);
    try { accept(await window.gitforge.branchAction(repo.path, input)); setSelected(null); setSelection(null); setPicked({ staged: false, paths: [] }); }
    finally { setBusy(false); setPendingBranch(null); }
  };
  const runBranch = (input: BranchAction) => { void executeBranch(input).catch(error => setError(message(error))); };
  const showMenu = (event: React.MouseEvent, kind: 'commit' | 'branch' | 'stash' | 'files', target: string, paths?: string[]) => {
    event.preventDefault(); if (busy || repo.conflict) return;
    if (kind === 'branch' || kind === 'stash') { setSelectedSidebarItem(kind === 'stash' ? `stash:${target}` : target); (event.currentTarget as HTMLElement).focus(); }
    setContext({ kind, target, paths, x: Math.min(event.clientX, window.innerWidth - 250), y: Math.min(event.clientY, window.innerHeight - (kind === 'branch' ? 325 : 170)) });
    if (kind === 'commit') void window.gitforge.canResetCommit(repo.path, target).then(canReset => setContext(previous => previous?.kind === 'commit' && previous.target === target ? { ...previous, canReset } : previous)).catch(() => {});
  };
  const switchBranch = (ref: string) => {
    if (busy || repo.conflict || ref === `refs/heads/${repo.branch}`) return;
    if (ref.startsWith('refs/remotes/')) setPrompt({ kind: 'checkout-remote', dirty: Boolean(repo.staged.length || repo.unstaged.length), input: { action: 'switch', ref, name: ref.slice(13).split('/').slice(1).join('/') } });
    else if (repo.staged.length || repo.unstaged.length) setPrompt({ kind: 'switch', input: { action: 'switch', ref } });
    else runBranch({ action: 'switch', ref });
  };
  const deleteBranch = (ref: string) => {
    if (busy || repo.conflict || prompt || ref === `refs/heads/${repo.branch}`) return;
    setContext(null);
    setPrompt(ref.startsWith('refs/heads/')
      ? { kind: 'delete-branch', input: { action: 'delete-branch', ref, remoteRef: repo.remoteBranches[ref.slice(11)]?.ref } }
      : { kind: 'delete-remote-branch', input: { action: 'delete-remote-branch', ref } });
  };
  const branchSelection = (ref: string) => ({
    role: 'button', tabIndex: 0, 'aria-pressed': selectedSidebarItem === ref,
    onClick: (event: React.MouseEvent<HTMLDivElement>) => { setSelectedSidebarItem(ref); event.currentTarget.focus(); },
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); if (!event.repeat && selectedSidebarItem === ref) deleteBranch(ref); }
    }
  });
  useEffect(() => {
    setSelectedSidebarItem(previous => previous && (previous.startsWith('stash:') ? repo.stashEntries.some(stash => `stash:${stash.hash}` === previous) : previous.startsWith('refs/heads/') ? repo.local.includes(previous.slice(11)) : repo.remote.includes(previous.slice(13))) ? previous : null);
  }, [repo.local, repo.remote, repo.stashEntries]);
  const fileMenu = (staged: boolean, file: FileChange, event: React.MouseEvent<HTMLButtonElement>) => {
    cancelFileClick();
    const paths = picked.staged === staged && picked.paths.includes(file.path) ? picked.paths : [file.path];
    setPicked({ staged, paths, anchor: file.path });
    showMenu(event, 'files', file.path, paths);
    setContext(previous => previous?.kind === 'files' ? { ...previous, staged } : previous);
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
    <header className="repo-actions"><div className="repo-name" title={repo.path}><strong>{repo.name}</strong><span>{repo.branch}</span></div><div className="repo-buttons"><button disabled={busy || Boolean(repo.conflict)} onClick={() => void runRemote('pull')}>Pull</button><div className="push-control"><button disabled={busy || Boolean(repo.conflict) || !repo.canPush} onClick={() => void startPush(false)}>Push</button><button disabled={busy || Boolean(repo.conflict) || !repo.canPush} aria-label="Push options" onClick={() => setPushMenu(value => !value)}>&#9662;</button>{pushMenu && <div className="profile-menu"><button onClick={() => void startPush(true)}>Force Push</button></div>}</div><button disabled={busy || Boolean(repo.conflict) || !repo.local.includes(repo.branch)} onClick={() => setPrompt({ kind: 'create', input: { action: 'create', ref: `refs/heads/${repo.branch}` } })}>Branch</button><button disabled={busy || Boolean(repo.conflict)} onClick={() => void runRemote('fetch')}>Fetch</button></div></header>
    {error && <div className="error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="repo-layout">
      <aside className="repo-sidebar" onPointerDown={event => {
        if (!(event.target as Element).closest('.branch-row,.stash-row')) {
          setSelectedSidebarItem(null);
          const focused = document.activeElement as HTMLElement | null;
          if (focused?.closest('.branch-row,.stash-row') && event.currentTarget.contains(focused)) focused.blur();
        }
      }}>
        <form className="sidebar-filter" onSubmit={event => { event.preventDefault(); setFilter(filterDraft.trim()); }}><input aria-label="Filter branches and stashes" placeholder="Filter" value={filterDraft} onChange={event => setFilterDraft(event.target.value)}/>{filter && <button type="button" aria-label="Clear filter" onClick={() => { setFilter(''); setFilterDraft(''); }}>&#215;</button>}</form>
        <details className="sidebar-group" hidden={Boolean(filter) && !localBranches.length} open><summary>Local branches</summary><div className="sidebar-items">{localBranches.map(branch => <div className={`${branch === repo.branch ? 'current-branch ' : ''}branch-row${repo.remoteBranches[branch] ? '' : ' local-only-branch'}`} title={repo.remoteBranches[branch] ? undefined : 'Local branch: not published to a remote'} key={branch} {...branchSelection(`refs/heads/${branch}`)} onDoubleClick={() => switchBranch(`refs/heads/${branch}`)} onContextMenu={event => showMenu(event, 'branch', `refs/heads/${branch}`)}><BranchIcon/>{branch}{!repo.conflict && pendingBranch === `refs/heads/${branch}` && <BranchSpinner/>}{repo.remoteBranches[branch] && repo.ahead[branch] > 0 && <span className="ahead-count" aria-label={`${repo.ahead[branch]} commits to push`}> {repo.ahead[branch]} <span aria-hidden="true">&#8593;</span></span>}{repo.behind[branch] > 0 && <span className="behind-count" aria-label={`${repo.behind[branch]} commits to pull`}> {repo.behind[branch]} <span aria-hidden="true">&#8595;</span></span>}</div>)}{!repo.local.length && <p className="muted">No local branches</p>}</div></details>
        <details className="sidebar-group" hidden={Boolean(filter) && !remoteBranches.length}><summary>Remote branches</summary><div className="sidebar-items">{remoteBranches.map(branch => <div className="branch-row" key={branch} {...branchSelection(`refs/remotes/${branch}`)} onDoubleClick={() => switchBranch(`refs/remotes/${branch}`)} onContextMenu={event => showMenu(event, 'branch', `refs/remotes/${branch}`)}><BranchIcon/>{branch.split('/').slice(1).join('/')}{!repo.conflict && pendingBranch === `refs/remotes/${branch}` && <BranchSpinner/>}</div>)}{!repo.remote.length && <p className="muted">No remote branches</p>}</div></details>
        <details className="sidebar-group" hidden={Boolean(filter) && !filteredStashes.length}><summary>Stashes</summary><div className="sidebar-items">{filteredStashes.map(stash => <div className="stash-row" key={stash.ref} role="button" tabIndex={0} aria-pressed={selectedSidebarItem === `stash:${stash.hash}`} onClick={event => { setSelectedSidebarItem(`stash:${stash.hash}`); event.currentTarget.focus(); }} onContextMenu={event => showMenu(event, 'stash', stash.hash)}>{stash.message}</div>)}{!repo.stashes.length && <p className="muted">No stashes</p>}</div></details>
      </aside>
      {repo.conflict ? <MergeConflicts conflict={repo.conflict} execute={async input => { accept(await window.gitforge.conflictAction(repo.path, input)); setSelected(null); }}/> : <>
      <main className="repo-center"><section ref={historyElement} className="history" hidden={selection !== null}><div className="section-heading"><h2>Commit history</h2>{selected && !hasWorkingChanges && <button onClick={() => { setSelected(null); setSelection(null); setPicked({ staged: false, paths: [] }); }}>Working changes</button>}</div>
        <table className="history-table"><thead><tr><th>Branch / Tag</th><th className="graph-heading">Graph</th><th>Commit</th><th>Author</th><th>Date</th></tr></thead><tbody>{hasWorkingChanges && <tr className={selected === null ? 'selected wip-row' : 'wip-row'}><td/><GraphCell row={graph.rows[0]} lanes={graph.lanes} wip/><td colSpan={3}><button className="commit-link wip-link" onClick={() => { setSelected(null); setSelection(null); setPicked({ staged: false, paths: [] }); }}><span className="wip-marker" aria-hidden="true"/>WIP <span className="muted">{new Set([...repo.unstaged, ...repo.staged].map(file => file.path)).size} files changed</span></button></td></tr>}{repo.commits.map((commit, index) => <tr key={commit.hash} data-commit-hash={commit.hash} className={`${selected?.hash === commit.hash ? 'selected ' : ''}${commit.hash === repo.head ? 'current-commit' : ''}`} onContextMenu={event => showMenu(event, 'commit', commit.hash)}><td className="history-branch-cell"><HistoryBranches labels={commit.labels} currentBranch={commit.hash === repo.head ? repo.branch : undefined} color={graph.rows[index + graphOffset].color}/></td><GraphCell row={graph.rows[index + graphOffset]} lanes={graph.lanes} current={commit.hash === repo.head}/><td><button className="commit-link" onClick={() => { setSelected(commit); setSelection(null); setPicked({ staged: false, paths: [] }); }}><code>{commit.hash.slice(0, 7)}</code> {commit.subject}</button></td><td>{commit.author}</td><td>{new Date(commit.date).toLocaleDateString()}</td></tr>)}</tbody></table>
        {!repo.commits.length && <p className="muted">This repository has no commits yet.</p>}
        {hasMore && <button disabled={loadingMore} onClick={() => void loadPage().catch(failure => setError(message(failure)))}>Load more commits</button>}
      </section>
      <section className="detail-panel diff-panel" aria-label="Diff pane" hidden={selection === null}><div className="section-heading"><h2>File diff</h2></div>
        {selection ? <><h3 className="diff-path">{selection.file.path}</h3><pre className="diff" aria-label="File diff">{diff ? parseDiff(diff).map((row, index) => <div className={`diff-row ${row.kind === 'notice' ? 'diff-notice' : row.kind}${row.startsHunk ? ' hunk-start' : ''}`} key={index}><span className="line-number old-line" aria-label="Old line number">{row.oldLine ?? ''}</span><span className="line-number new-line" aria-label="New line number">{row.newLine ?? ''}</span><span className="diff-code">{row.marker ? `${row.marker} ${row.text}` : row.text || ' '}</span></div>) : 'Loading diff…'}</pre></> : <p className="muted">Select a file to view its changes.</p>}
      </section>
      </main>
      {selected ? <section className="commit-information"><div className="section-heading"><h2>Commit information</h2><button aria-pressed={tree} onClick={() => setTree(value => !value)}>{tree ? 'Path view' : 'Tree view'}</button></div>
        <><dl className="commit-metadata"><dt>Hash</dt><dd>{selected.hash}</dd><dt>Parents</dt><dd className="parent-commits">{selected.parents.length ? selected.parents.map(parent => <button key={parent} className="parent-commit-link" onClick={() => void navigateToCommit(parent, true)}>{parent}</button>) : 'None (initial commit)'}</dd><dt>Author</dt><dd>{selected.author}</dd><dt>Date</dt><dd>{new Date(selected.date).toLocaleString()}</dd></dl>{details ? <><pre className="commit-message">{details.message}</pre><p className="summary-counts">{details.files.filter(f => f.status === 'A').length} added · {details.files.filter(f => f.status === 'M').length} changed · {details.files.filter(f => f.status === 'D').length} deleted</p><FileList files={details.files} tree={tree} selectedPath={selection?.hash === selected.hash ? selection.file.path : undefined} select={file => toggleFile({ file, hash: selected.hash })}/></> : <p>Loading commit…</p>}</>
      </section> : 
      <section className="working-changes"><div className="section-heading"><h2>Working changes</h2><button aria-pressed={tree} onClick={() => setTree(value => !value)}>{tree ? 'Path view' : 'Tree view'}</button></div><section className="change-group"><div className="change-heading"><h3>Unstaged files ({repo.unstaged.length})</h3><button disabled={busy || !repo.unstaged.length} onClick={() => void change('stage', repo.unstaged.map(file => file.path))}>Stage All</button></div><div className="change-scroll" role="region" aria-label="Unstaged files" tabIndex={0}><FileList files={repo.unstaged} tree={tree} selectedPath={selection && !selection.hash && !selection.staged ? selection.file.path : undefined} markedPaths={!picked.staged ? picked.paths : []} select={(file, event) => { setSelected(null); chooseFile(file, false, event); }} doubleClick={file => void change('stage', !picked.staged && picked.paths.includes(file.path) ? picked.paths : [file.path])} discard={() => { if (!picked.staged) void change('discard'); }} contextMenu={(file, event) => fileMenu(false, file, event)}/></div></section><section className="change-group"><div className="change-heading"><h3>Staged files ({repo.staged.length})</h3><button disabled={busy || !repo.staged.length} onClick={() => void change('unstage', repo.staged.map(file => file.path))}>Unstage All</button></div><div className="change-scroll" role="region" aria-label="Staged files" tabIndex={0}><FileList files={repo.staged} tree={tree} selectedPath={selection && !selection.hash && selection.staged ? selection.file.path : undefined} markedPaths={picked.staged ? picked.paths : []} select={(file, event) => { setSelected(null); chooseFile(file, true, event); }} doubleClick={file => void change('unstage', picked.staged && picked.paths.includes(file.path) ? picked.paths : [file.path])} contextMenu={(file, event) => fileMenu(true, file, event)}/></div></section><div className="commit-form">{repo.mergePending && !repo.conflict && <p className="merge-pending">Commit to complete the pending merge.</p>}<label>Commit title<input value={title} onChange={event => setTitle(event.target.value)} placeholder="Commit title"/></label><label>Description<textarea value={description} onChange={event => setDescription(event.target.value)} placeholder="Description (optional)"/></label><div className="commit-actions"><button className="commit-button" disabled={busy || (!repo.staged.length && !repo.mergePending) || !title.trim()} onClick={async () => { if (busy) return; setBusy(true); setError(''); try { accept(await window.gitforge.commitChanges(repo.path, { title, description })); setTitle(''); setDescription(''); } catch(error) { setError(message(error)); } finally { setBusy(false); } }}>Commit</button>{repo.mergePending && !repo.conflict && <button className="abort-merge" disabled={busy} onClick={() => setConfirmingAbort(true)}>Abort Merge</button>}</div></div></section> }
      </>}

    </div>
    {confirmingAbort && <AbortMergeDialog close={() => setConfirmingAbort(false)} execute={async () => { accept(await window.gitforge.conflictAction(repo.path, { action: 'abort' })); setSelected(null); }}/>}
    {pushDialog && <PushDialog plan={pushDialog.plan} force={pushDialog.force} close={() => setPushDialog(null)} pushed={async input => { const value = await window.gitforge.pushCommits(repo.path, input); accept(value); setPushDialog(null); }}/ >}
    {prompt && <BranchDialog prompt={prompt} close={() => setPrompt(null)} execute={executeBranch}/>}
    {context && <div role="menu" className="context-menu" style={{ left: context.x, top: context.y }}>
      {context.kind === 'commit' && <><button role="menuitem" onClick={() => runBranch({ action: 'checkout', hash: context.target })}>Checkout Commit</button><button role="menuitem" onClick={() => setPrompt({ kind: 'create', input: { action: 'create', hash: context.target } })}>Create Branch From Commit</button><button role="menuitem" disabled={!context.canReset} onClick={() => setPrompt({ kind: 'reset', input: { action: 'reset', hash: context.target } })}>Reset Branch To Commit</button></>}
      {context.kind === 'branch' && <><div role="group" aria-label="Remote actions"><button role="menuitem" disabled={busy || (context.target.startsWith('refs/heads/') && !repo.remoteBranches[context.target.slice(11)])} onClick={() => void runRemote('fetch', context.target)}>Fetch</button><button role="menuitem" disabled={busy || !context.target.startsWith('refs/heads/') || !repo.remoteBranches[context.target.slice(11)] || !repo.behind[context.target.slice(11)] || (context.target === `refs/heads/${repo.branch}` ? Boolean(repo.staged.length || repo.unstaged.length) : Boolean(repo.ahead[context.target.slice(11)]))} onClick={() => void runRemote('pull', context.target)}>Pull</button><button role="menuitem" disabled={busy || !context.target.startsWith('refs/heads/') || Boolean(repo.remoteBranches[context.target.slice(11)] && !repo.ahead[context.target.slice(11)])} onClick={() => void startPush(false, context.target.slice(11))}>Push</button></div><div role="separator" className="context-menu-separator"/><button role="menuitem" disabled={busy || context.target === `refs/heads/${repo.branch}`} onClick={() => switchBranch(context.target)}>Checkout Branch</button><button role="menuitem" onClick={() => setPrompt({ kind: 'create', input: { action: 'create', ref: context.target } })}>Create Branch</button>{context.target.startsWith('refs/heads/') && context.target !== `refs/heads/${repo.branch}` && <button role="menuitem" onClick={() => deleteBranch(context.target)}>Delete Branch</button>}{context.target.startsWith('refs/remotes/') && <button role="menuitem" onClick={() => deleteBranch(context.target)}>Delete Branch</button>}<button role="menuitem" disabled={context.target === `refs/heads/${repo.branch}`} onClick={() => runBranch({ action: 'merge', ref: context.target })}>Merge into current branch</button></>}
      {context.kind === 'files' && <>{!context.staged && <button role="menuitem" onClick={() => void change('discard', context.paths)}>Discard Changes</button>}<button role="menuitem" onClick={() => setPrompt({ kind: 'stash', input: { action: 'stash', paths: context.paths } })}>Stash</button></>}
      {context.kind === 'stash' && <><button role="menuitem" onClick={() => setPrompt({ kind: 'apply-stash', input: { action: 'apply-stash', hash: context.target } })}>Apply Stash</button><button role="menuitem" onClick={() => setPrompt({ kind: 'delete-stash', input: { action: 'delete-stash', hash: context.target } })}>Delete Stash</button></>}
    </div>}
  </div>;
}

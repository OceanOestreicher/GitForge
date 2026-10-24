import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { RepositoryView, type Repository, type Commit, type FileChange } from './repository';
import { CreateRepository } from './create-repository';
import { CloneRepository } from './clone-repository';
import { ProfilesPage, type Profile, type ProfileInput } from './profiles';
import type { PushPlan, PushInput } from './push';

declare global {
  interface Window {
    gitforge: {
      gitStatus(): Promise<boolean>;
      listProfiles(): Promise<Profile[]>;
      createProfile(input: ProfileInput): Promise<Profile[]>;
      editProfile(id: string, input: ProfileInput): Promise<Profile[]>;
      switchProfile(id: string): Promise<Profile[]>;
      deleteProfile(id: string): Promise<Profile[]>;
      restoreSession(): Promise<{ repositories: Repository[]; activeIndex: number }>;
      saveSession(paths: string[], activeIndex: number): Promise<void>;
      openRepository(): Promise<Repository | null>;
      createRepository(input: { name: string; parentPath: string; branch: string }): Promise<Repository>;
      cloneRepository(input: { url: string; parentPath: string }): Promise<Repository>;
      changeFiles(root: string, input: { action: string; paths: string[] }): Promise<Repository>;
      commitChanges(root: string, input: { title: string; description: string }): Promise<Repository>;
      preparePush(root: string): Promise<PushPlan>;
      pushCommits(root: string, input: PushInput): Promise<Repository>;
      fetchRepository(root: string): Promise<Repository>;
      pullRepository(root: string): Promise<Repository>;
      onRepositoryChanged(callback: (repo: Repository) => void): () => void;
      onRefreshError(callback: (error: { path: string; message: string }) => void): () => void;
      chooseParentDirectory(): Promise<string | null>;
      snapshot(root: string): Promise<Repository>;
      commitDetails(root: string, hash: string): Promise<{ message: string; files: FileChange[] }>;
      fileDiff(root: string, request: { path: string; hash?: string; staged?: boolean; untracked?: boolean }): Promise<string>;
      moreCommits(root: string, skip: number): Promise<Commit[]>;
      setTabActive(active: boolean): void;
      onMenuAction(callback: (action: string) => void): () => void;
    };
  }
}

function App() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const activeProfile = profiles.find(profile => profile.active);
  const profileRequired = profiles.length === 0;
  const [tabs, setTabs] = useState<number[]>([1]);
  const [repositories, setRepositories] = useState<Record<number, Repository>>({});
  const [openError, setOpenError] = useState('');
  const [opening, setOpening] = useState(false);
  const [createTarget, setCreateTarget] = useState<{ tab: number | null } | null>(null);
  const [cloneTarget, setCloneTarget] = useState<{ tab: number | null } | null>(null);
  const [active, setActive] = useState<number | null>(1);
  const [preferences, setPreferences] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const tabNavigation = useRef<HTMLDivElement>(null);
  const nextId = useRef(2);
  const tabStrip = useRef<HTMLDivElement>(null);
  useEffect(() => window.gitforge.onRepositoryChanged(repo => {
    setRepositories(previous => Object.fromEntries(Object.entries(previous).map(([id, value]) => [id, value.path === repo.path ? repo : value])));
  }), []);
  useEffect(() => window.gitforge.onRefreshError(error => setOpenError(error.message)), []);
  const openRepository = async (newWindow: boolean) => {
    if (opening) return;
    setOpening(true); setOpenError('');
    try {
      const repo = await window.gitforge.openRepository();
      if (!repo) return;
      const id = newWindow || active === null ? nextId.current++ : active;
      if (newWindow || active === null) setTabs(previous => [...previous, id]);
      setRepositories(previous => ({ ...previous, [id]: repo }));
      setActive(id); setPreferences(false);
    } catch (error) { setOpenError(String(error)); }
    finally { setOpening(false); }
  };
  const newTab = () => {
    const id = nextId.current++;
    setTabs(previous => [...previous, id]); setActive(id); setPreferences(false);
  };
  const closeTab = (id: number) => {
    const index = tabs.indexOf(id);
    const remaining = tabs.filter(tab => tab !== id);
    setTabs(remaining);
    setRepositories(previous => { const next = { ...previous }; delete next[id]; return next; });
    if (active === id) setActive(remaining[Math.min(index, remaining.length - 1)] ?? null);
  };
  useEffect(() => {
    let alive = true;
    const restore = async () => {
      const available = await window.gitforge.gitStatus();
      if (!alive) return;
      if (!available) { setReady(false); return; }
      try {
        const values = await window.gitforge.listProfiles();
        if (!alive) return;
        setProfiles(values);
        const saved = await window.gitforge.restoreSession();
        if (!alive) return;
        if (saved.repositories.length) {
          const ids = saved.repositories.map((_, index) => index + 1);
          setTabs(ids);
          setRepositories(Object.fromEntries(saved.repositories.map((repo, index) => [ids[index], repo])));
          setActive(ids[saved.activeIndex] ?? ids[0]);
          nextId.current = ids.length + 1;
        }
      } catch (error) { if (alive) setOpenError(String(error)); }
      if (alive) { setSessionReady(true); setReady(true); }
    };
    void restore().catch(() => { if (alive) setReady(false); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!sessionReady) return;
    const repositoryTabs = tabs.filter(id => repositories[id]);
    void window.gitforge.saveSession(repositoryTabs.map(id => repositories[id].path), active === null ? -1 : repositoryTabs.indexOf(active)).catch(error => setOpenError(String(error)));
  }, [sessionReady, tabs, repositories, active]);
  useEffect(() => window.gitforge.onMenuAction(action => {
    if (ready !== true || profileRequired) return;
    if (cloneTarget) return;
    if (action === 'new-tab') newTab();
    if (action === 'open-repo') void openRepository(true);
    if (action === 'init-repo' && !createTarget) setCreateTarget({ tab: null });
    if (action === 'clone-repo' && !createTarget) setCloneTarget({ tab: null });
    if (action === 'close-tab' && active !== null) closeTab(active);
  }), [ready, tabs, active, opening, createTarget, cloneTarget, profileRequired]);
  useEffect(() => { window.gitforge.setTabActive(ready === true && active !== null); }, [ready, active]);
  useEffect(() => {
    const navigation = tabNavigation.current;
    const strip = tabStrip.current;
    if (!navigation || !strip) return;
    // Measure against the space available without arrows, so their own width
    // cannot keep them visible after enough tabs have been closed.
    const measure = () => setOverflowing(strip.scrollWidth > navigation.clientWidth - 40);
    const observer = new ResizeObserver(measure);
    observer.observe(navigation);
    measure();
    return () => observer.disconnect();
  }, [ready, tabs]);
  useEffect(() => { tabStrip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [active]);

  if (ready !== true) return <main className="notice" role="status"><h1>{ready === null ? 'Starting GitForge…' : 'Git is required'}</h1>{ready === false && <p>Install Git for Windows and ensure it is available on PATH, then restart GitForge.</p>}</main>;
  return <div className="app">
    <header className="tabbar">
      <div className="tab-navigation" ref={tabNavigation} inert={profileRequired}>
      {overflowing && <button className="icon scroll" aria-label="Scroll tabs left" onClick={() => tabStrip.current?.scrollBy({ left: -240, behavior: 'smooth' })}>‹</button>}
      <div className="tabs" ref={tabStrip} role="tablist" aria-label="Repository tabs">
        {tabs.map(id => <div className={`tab ${active === id ? 'active' : ''}`} key={id}>
          <button role="tab" aria-selected={active === id} onClick={() => { setActive(id); setPreferences(false); }}>{Boolean(repositories[id]?.unpushed) && <span className="unpushed-dot" aria-label="Unpushed commits"/>}{repositories[id]?.name ?? 'New Tab'}</button>
          <button className="close" aria-label={`Close tab ${id}`} onClick={() => closeTab(id)}>×</button>
        </div>)}
      </div>
      {overflowing && <button className="icon scroll" aria-label="Scroll tabs right" onClick={() => tabStrip.current?.scrollBy({ left: 240, behavior: 'smooth' })}>›</button>}
      <button className="icon" aria-label="New Tab" title="New Tab (Ctrl+T)" onClick={newTab}>+</button>
      </div>
      {activeProfile && <span className="active-profile-name" aria-label="Active profile name" title={activeProfile.name}>{activeProfile.name}</span>}
      <button className={`icon settings ${preferences ? 'selected' : ''}`} disabled={profileRequired} aria-label="Preferences" aria-pressed={preferences || profileRequired} title="Preferences" onClick={() => { setPreferences(previous => !previous); }}>⚙</button>
    </header>
    {openError && <div role="alert" className="error">{openError}<button onClick={() => setOpenError('')}>Dismiss</button></div>}
    {opening && <div role="status" className="opening">Opening repository…</div>}
    {preferences || profileRequired ? <div className="preferences">
      <aside><button className="back" disabled={profileRequired} onClick={() => setPreferences(false)}>← Exit Preferences</button>
        <nav aria-label="Preferences pages"><button aria-current="page" className="selected">Profiles</button></nav>
      </aside><main className="preference-page"><ProfilesPage profiles={profiles} updated={values => { setProfiles(values); setPreferences(true); }}/></main>
    </div> : active !== null && repositories[active] ? <RepositoryView key={active} initial={repositories[active]} updated={repo => setRepositories(previous => ({ ...previous, [active]: repo }))}/> : active !== null ? <main className="welcome"><h1>Repositories</h1><div className="actions">
      <button disabled={opening} onClick={() => void openRepository(false)}><span aria-hidden="true">▰</span> Open</button>
      <button onClick={() => setCloneTarget({ tab: active })}><span aria-hidden="true">↓</span> Clone</button>
      <button onClick={() => setCreateTarget({ tab: active })}><span aria-hidden="true">⊞</span> Create</button>
    </div></main> : <main className="empty"><h1>GitForge</h1><p>Open a new tab to get started.</p><button onClick={newTab}>New Tab</button></main>}
    {cloneTarget && <CloneRepository onClose={() => setCloneTarget(null)} onCloned={repo => {
      const target = cloneTarget.tab;
      const id = target !== null && tabs.includes(target) ? target : nextId.current++;
      if (id !== target) setTabs(previous => [...previous, id]);
      setRepositories(previous => ({ ...previous, [id]: repo }));
      setActive(id); setPreferences(false); setCloneTarget(null);
    }}/>}
    {createTarget && <CreateRepository onClose={() => setCreateTarget(null)} onCreated={repo => {
      const target = createTarget.tab;
      const id = target !== null && tabs.includes(target) ? target : nextId.current++;
      if (id !== target) setTabs(previous => [...previous, id]);
      setRepositories(previous => ({ ...previous, [id]: repo }));
      setActive(id); setPreferences(false); setCreateTarget(null);
    }}/>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

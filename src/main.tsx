import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

declare global {
  interface Window {
    gitforge: {
      gitStatus(): Promise<boolean>;
      setTabActive(active: boolean): void;
      onMenuAction(callback: (action: string) => void): () => void;
    };
  }
}

function App() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [tabs, setTabs] = useState<number[]>([1]);
  const [active, setActive] = useState<number | null>(1);
  const [preferences, setPreferences] = useState(false);
  const [page, setPage] = useState('General');
  const [overflowing, setOverflowing] = useState(false);
  const tabNavigation = useRef<HTMLDivElement>(null);
  const nextId = useRef(2);
  const tabStrip = useRef<HTMLDivElement>(null);
  const newTab = () => {
    const id = nextId.current++;
    setTabs(previous => [...previous, id]); setActive(id); setPreferences(false);
  };
  const closeTab = (id: number) => {
    const index = tabs.indexOf(id);
    const remaining = tabs.filter(tab => tab !== id);
    setTabs(remaining);
    if (active === id) setActive(remaining[Math.min(index, remaining.length - 1)] ?? null);
  };
  useEffect(() => { window.gitforge.gitStatus().then(setReady).catch(() => setReady(false)); }, []);
  useEffect(() => window.gitforge.onMenuAction(action => {
    if (ready !== true) return;
    if (action === 'new-tab') newTab();
    if (action === 'close-tab' && active !== null) closeTab(active);
  }), [ready, tabs, active]);
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
      <div className="tab-navigation" ref={tabNavigation}>
      {overflowing && <button className="icon scroll" aria-label="Scroll tabs left" onClick={() => tabStrip.current?.scrollBy({ left: -240, behavior: 'smooth' })}>‹</button>}
      <div className="tabs" ref={tabStrip} role="tablist" aria-label="Repository tabs">
        {tabs.map(id => <div className={`tab ${active === id ? 'active' : ''}`} key={id}>
          <button role="tab" aria-selected={active === id} onClick={() => { setActive(id); setPreferences(false); }}>New Tab</button>
          <button className="close" aria-label={`Close tab ${id}`} onClick={() => closeTab(id)}>×</button>
        </div>)}
      </div>
      {overflowing && <button className="icon scroll" aria-label="Scroll tabs right" onClick={() => tabStrip.current?.scrollBy({ left: 240, behavior: 'smooth' })}>›</button>}
      <button className="icon" aria-label="New Tab" title="New Tab (Ctrl+T)" onClick={newTab}>+</button>
      </div>
      <button className={`icon settings ${preferences ? 'selected' : ''}`} aria-label="Preferences" aria-pressed={preferences} title="Preferences" onClick={() => { if (!preferences) setPage('General'); setPreferences(previous => !previous); }}>⚙</button>
    </header>
    {preferences ? <div className="preferences">
      <aside><button className="back" onClick={() => setPreferences(false)}>← Exit Preferences</button>
        <nav aria-label="Preferences pages">{['General', 'Profiles'].map(name => <button key={name} aria-current={page === name ? 'page' : undefined} className={page === name ? 'selected' : ''} onClick={() => setPage(name)}>{name}</button>)}</nav>
      </aside><main className="preference-page"><h1>{page}</h1></main>
    </div> : active !== null ? <main className="welcome"><h1>Repositories</h1><div className="actions">
      <button><span aria-hidden="true">▰</span> Open</button>
      <button><span aria-hidden="true">↓</span> Clone</button>
      <button><span aria-hidden="true">⊞</span> Create</button>
    </div></main> : <main className="empty"><h1>GitForge</h1><p>Open a new tab to get started.</p><button onClick={newTab}>New Tab</button></main>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

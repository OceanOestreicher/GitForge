import type { CSSProperties } from 'react';
export type HistoryLabel = { name: string; local: boolean; remote: boolean; tag: boolean; head: boolean };

function Label({ label, current = false }: { label: HistoryLabel; current?: boolean }) {
  return <span className={`history-branch-label${label.head ? ' detached-label' : ''}`}>
    {current && <svg className="history-current-check" role="img" aria-label="Checked out branch" viewBox="0 0 20 20"><path d="m3 10 4 4L17 4"/></svg>}<span>{label.name}</span>
    {label.local && <svg role="img" aria-label="Local branch" viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="10" rx="1"/><path d="M7 17h6M10 13v4"/></svg>}
    {label.remote && <svg role="img" aria-label="Remote branch" viewBox="0 0 20 20"><ellipse cx="10" cy="4" rx="6" ry="2.5"/><path d="M4 4v11c0 3.3 12 3.3 12 0V4M4 9c0 3.3 12 3.3 12 0"/></svg>}
    {label.tag && <svg role="img" aria-label="Tag" viewBox="0 0 20 20"><path d="M3 3h7l7 7-7 7-7-7Z"/><circle cx="7" cy="7" r="1"/></svg>}
  </span>;
}

export function HistoryBranches({ labels: original, currentBranch, color }: { labels: HistoryLabel[]; currentBranch?: string; color?: string }) {
  const isCurrent = (label: HistoryLabel) => Boolean(currentBranch && label.local && (label.name === currentBranch || label.head));
  const labels = [...original].sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)));
  if (!labels.length) return null;
  return <div className="history-branches" style={{ "--branch-color": color } as CSSProperties} tabIndex={labels.length > 1 ? 0 : undefined} aria-label="Branches and tags">
    <span className="branch-summary"><Label label={labels[0]} current={isCurrent(labels[0])}/>{labels.length > 1 && <span className="branch-extra-count">+{labels.length - 1}</span>}</span>
    {labels.length > 1 && <div className="branch-hover-list">{labels.map((label, index) => <Label key={index} label={label} current={isCurrent(label)}/>)}</div>}
  </div>;
}

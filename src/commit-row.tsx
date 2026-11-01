import { memo, type MouseEvent } from 'react';
import type { Commit } from './repository';
import type { GraphRow } from './commit-graph';
import { GraphCell } from './graph-cell';
import { HistoryBranches } from './history-branches';

export const CommitRow = memo(function CommitRow({ commit, graph, lanes, selected, current, branch, select, context }: {
  commit: Commit; graph: GraphRow; lanes: number; selected: boolean; current: boolean; branch?: string;
  select: (commit: Commit) => void; context: (event: MouseEvent, hash: string) => void;
}) {
  return <tr data-commit-hash={commit.hash} className={`${selected ? 'selected ' : ''}${current ? 'current-commit' : ''}`} onContextMenu={event => context(event, commit.hash)}>
    <td className="history-branch-cell"><HistoryBranches labels={commit.labels} currentBranch={branch} color={graph.color}/></td>
    <GraphCell row={graph} lanes={lanes} current={current}/>
    <td><button className="commit-link" onClick={() => select(commit)}><code>{commit.hash.slice(0, 7)}</code> {commit.subject}</button></td>
    <td>{commit.author}</td><td>{new Date(commit.date).toLocaleDateString()}</td>
  </tr>;
});

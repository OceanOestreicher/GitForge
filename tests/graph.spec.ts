import { test, expect } from '@playwright/test';
import { buildCommitGraph, buildHistoryGraph, graphColors, withWorkingChanges } from '../src/commit-graph';

test('graph connects a merge to both branch histories and rejoins their shared ancestor', () => {
  const commits = [{ hash: 'merge', parents: ['main', 'feature'] }, { hash: 'feature', parents: ['base'] }, { hash: 'main', parents: ['base'] }, { hash: 'base', parents: [] }];
  const { rows, lanes } = buildCommitGraph(commits);
  expect(lanes).toBe(2);
  expect(rows[0].edges.filter(edge => edge.parent).map(edge => edge.parent)).toEqual(['main', 'feature']);
  expect(rows[1].color).not.toBe(rows[2].color);
  expect(rows[1].lane).not.toBe(rows[2].lane);
  expect(rows[2].edges.find(edge => edge.parent === 'base')?.to).toBe(rows[3].lane);
  expect(rows[1].edges.find(edge => edge.parent === 'base')?.to).toBe(rows[1].lane);
  expect(rows[3].edges.some(edge => edge.start === 'top' && edge.end === 'node' && edge.from === rows[1].lane && edge.to === rows[3].lane)).toBe(true);
  expect(rows[3].color).toBe(rows[2].color);
});

test('graph maintains continuation colors, rotates fork colors, and retains paths across pagination', () => {
  const tips = Array.from({ length: graphColors.length + 2 }, (_, index) => ({ hash: `tip-${index}`, parents: ['base'] }));
  const graph = buildCommitGraph([...tips, { hash: 'base', parents: [] }]);
  expect(graph.rows.slice(0, graphColors.length).map(row => row.color)).toEqual(graphColors);
  expect(graph.rows[graphColors.length].color).toBe(graphColors[0]);
  const commits = [{ hash: 'tip', parents: ['middle'] }, { hash: 'other', parents: ['base'] }, { hash: 'middle', parents: ['base'] }, { hash: 'base', parents: [] }];
  const prefix = buildCommitGraph(commits.slice(0, 2));
  expect(buildCommitGraph(commits).rows.slice(0, 2)).toEqual(prefix.rows);
  expect(buildCommitGraph(commits).rows[2].color).toBe(prefix.rows[0].color);
});

test('graph supports octopus merges, unrelated roots, and working changes attached to an older HEAD', () => {
  const committed = buildCommitGraph([{ hash: 'merge', parents: ['a', 'b', 'c'] }, { hash: 'a', parents: [] }, { hash: 'b', parents: [] }, { hash: 'c', parents: [] }, { hash: 'head', parents: [] }]);
  const graph = withWorkingChanges(committed, 'head');
  expect(graph.rows[1].edges.filter(edge => edge.parent)).toHaveLength(3);
  expect(new Set(graph.rows.slice(2, 5).map(row => row.color)).size).toBe(3);
  expect(graph.rows[5].color).toBe(graph.rows[0].color);
  expect(graph.rows[5].edges.some(edge => edge.dashed && edge.from === graph.rows[0].lane && edge.to === graph.rows[5].lane && edge.end === 'node')).toBe(true);
  expect(buildCommitGraph([])).toEqual({ rows: [], lanes: 1 });
});

test('checkout never recolors or reroutes the committed main, development and merged side paths', () => {
  const base = '28e23321638b2b78696f1a6aa7110d51780ff654';
  const commits = [
    { hash: 'main', parents: ['main-previous'] },
    { hash: 'development', parents: [base] },
    { hash: 'test-merge', parents: ['test-first', 'test-second'] },
    { hash: 'test-first', parents: [base] },
    { hash: 'test-second', parents: ['test-older'] },
    { hash: 'main-previous', parents: [base] },
    { hash: 'test-older', parents: [base] },
    { hash: base, parents: ['root'] }, { hash: 'root', parents: [] }
  ];
  const graph = buildCommitGraph(commits);
  expect(graph.rows[0].color).toBe(graphColors[0]);
  expect(graph.rows[1].color).not.toBe(graphColors[0]);
  for (const head of ['main', 'development', base, null]) {
    const decorated = withWorkingChanges(graph, head);
    expect(decorated.rows.slice(1).map(row => ({ ...row, edges: row.edges.filter(edge => !edge.dashed) }))).toEqual(graph.rows);
  }
  const ancestor = graph.rows.find(row => row.hash === base)!;
  expect(ancestor.edges.filter(edge => edge.end === 'node')).toHaveLength(4);
  expect(ancestor.edges.every(edge => edge.start !== 'top' || edge.to === ancestor.lane)).toBe(true);
  for (const row of graph.rows.slice(0, -2)) {
    for (const edge of row.edges) {
      if (edge.parent === base) expect(edge.to).toBe(row.lane);
      if (edge.start === 'top' && edge.end === 'bottom') expect(edge.to).toBe(edge.from);
    }
  }
});

test('WIP follows HEAD beyond a history page without changing colors when the page is extended', () => {
  const first = buildCommitGraph([{ hash: 'newest', parents: ['base'] }]);
  const pending = withWorkingChanges(first, 'old');
  expect(pending.rows[1].color).toBe(graphColors[0]);
  const complete = buildCommitGraph([{ hash: 'newest', parents: ['base'] }, { hash: 'old', parents: ['base'] }, { hash: 'base', parents: [] }]);
  expect(complete.rows[0]).toEqual(first.rows[0]);
  const resolved = withWorkingChanges(complete, 'old');
  expect(resolved.rows[0].color).toBe(complete.rows[1].color);
  expect(resolved.rows[0].color).not.toBe(graphColors[0]);
  expect(withWorkingChanges(buildCommitGraph([]), null).rows[0].edges).toEqual([]);
});

test('real uncommitted work takes the base color and still rejoins only at the common ancestor', () => {
  const commits = [{ hash: 'main', parents: ['main-older'] }, { hash: 'development', parents: ['base'] }, { hash: 'main-older', parents: ['base'] }, { hash: 'base', parents: [] }];
  const clean = buildHistoryGraph(commits, 'development', false);
  const dirty = buildHistoryGraph(commits, 'development', true);
  expect(clean.rows[1].color).toBe(graphColors[0]);
  expect(clean.rows[2].color).not.toBe(graphColors[0]);
  expect(dirty.rows[0].color).toBe(graphColors[0]);
  expect(dirty.rows[2].color).toBe(graphColors[0]);
  expect(dirty.rows[1].color).not.toBe(graphColors[0]);
  expect(dirty.rows[2].edges.find(edge => edge.parent === 'base')?.to).toBe(dirty.rows[2].lane);
  expect(dirty.rows.at(-1)!.edges.filter(edge => edge.end === 'node')).toHaveLength(2);
  expect(buildHistoryGraph(commits, 'development', false)).toEqual(clean);
  expect(buildHistoryGraph([], null, true).rows[0].color).toBe(graphColors[0]);
});

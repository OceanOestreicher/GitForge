import { test, expect } from '@playwright/test';
import { buildCommitGraph, buildHistoryGraph, graphColors } from '../src/commit-graph';

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
  const graph = buildHistoryGraph([{ hash: 'merge', parents: ['a', 'b', 'c'] }, { hash: 'a', parents: [] }, { hash: 'b', parents: [] }, { hash: 'c', parents: [] }, { hash: 'head', parents: [] }], 'head', true);
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
    expect(buildHistoryGraph(commits, head, false)).toEqual(graph);
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

test('clean histories have no WIP, including old HEAD, missing HEAD and empty repositories', () => {
  const commits = [{ hash: 'newest', parents: ['base'] }, { hash: 'old', parents: ['base'] }, { hash: 'base', parents: [] }];
  for (const head of ['newest', 'old', 'not-loaded', null]) {
    const graph = buildHistoryGraph(commits, head, false);
    expect(graph).toEqual(buildCommitGraph(commits));
    expect(graph.rows.some(row => row.hash === 'gitforge-wip')).toBe(false);
    expect(graph.rows.flatMap(row => row.edges).some(edge => edge.dashed)).toBe(false);
  }
  expect(buildHistoryGraph([], null, false)).toEqual({ rows: [], lanes: 1 });
});

test('real uncommitted work takes the base color and still rejoins only at the common ancestor', () => {
  const commits = [{ hash: 'main', parents: ['main-older'] }, { hash: 'development', parents: ['base'] }, { hash: 'main-older', parents: ['base'] }, { hash: 'base', parents: [] }];
  const clean = buildHistoryGraph(commits, 'development', false);
  const dirty = buildHistoryGraph(commits, 'development', true);
  expect(clean.rows[0].color).toBe(graphColors[0]);
  expect(clean.rows[1].color).not.toBe(graphColors[0]);
  expect(dirty.rows[0].color).toBe(graphColors[0]);
  expect(dirty.rows[2].color).toBe(graphColors[0]);
  expect(dirty.rows[1].color).toBe(clean.rows[1].color);
  expect(dirty.rows[2].edges.find(edge => edge.parent === 'base')?.to).toBe(dirty.rows[2].lane);
  expect(dirty.rows.at(-1)!.edges.filter(edge => edge.end === 'node')).toHaveLength(2);
  expect(buildHistoryGraph(commits, 'development', false)).toEqual(clean);
  expect(buildHistoryGraph([], null, true).rows[0].color).toBe(graphColors[0]);
});


test('WIP on a third path swaps only that path and the base, retaining other fork colors and blue shared ancestry', () => {
  const commits = [
    { hash: 'main', parents: ['main-older'] }, { hash: 'development', parents: ['base'] },
    { hash: 'third', parents: ['third-older', 'side'] }, { hash: 'third-older', parents: ['base'] },
    { hash: 'side', parents: ['base'] }, { hash: 'main-older', parents: ['base'] }, { hash: 'base', parents: [] }
  ];
  const clean = buildHistoryGraph(commits, 'third', false), dirty = buildHistoryGraph(commits, 'third', true);
  const before = new Map(clean.rows.map(row => [row.hash, row]));
  const after = new Map(dirty.rows.map(row => [row.hash, row]));
  expect(after.get('third')!.color).toBe(graphColors[0]);
  expect(after.get('main')!.color).toBe(before.get('third')!.color);
  expect(after.get('main-older')!.color).toBe(before.get('third')!.color);
  for (const hash of ['development', 'side']) expect(after.get(hash)!.color).toBe(before.get(hash)!.color);
  expect(after.get('base')!.color).toBe(graphColors[0]);
  expect(buildHistoryGraph(commits, 'third', false)).toEqual(clean);
});

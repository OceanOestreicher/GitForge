import { test, expect } from '@playwright/test';
import { buildCommitGraph, graphColors } from '../src/commit-graph';

test('graph connects a merge to both branch histories and rejoins their shared ancestor', () => {
  const commits = [{ hash: 'merge', parents: ['main', 'feature'] }, { hash: 'feature', parents: ['base'] }, { hash: 'main', parents: ['base'] }, { hash: 'base', parents: [] }];
  const { rows, lanes } = buildCommitGraph(commits);
  expect(lanes).toBe(2);
  expect(rows[0].edges.filter(edge => edge.parent).map(edge => edge.parent)).toEqual(['main', 'feature']);
  expect(rows[1].color).not.toBe(rows[2].color);
  expect(rows[1].lane).not.toBe(rows[2].lane);
  expect(rows[2].edges.find(edge => edge.parent === 'base')?.to).toBe(rows[3].lane);
  expect(rows[1].edges.find(edge => edge.parent === 'base')?.to).toBe(rows[1].lane);
  expect(rows[2].edges.some(edge => edge.start === 'top' && edge.from === rows[1].lane && edge.to === rows[3].lane)).toBe(true);
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
  const graph = buildCommitGraph([{ hash: 'wip', parents: ['head'] }, { hash: 'merge', parents: ['a', 'b', 'c'] }, { hash: 'a', parents: [] }, { hash: 'b', parents: [] }, { hash: 'c', parents: [] }, { hash: 'head', parents: [] }]);
  expect(graph.rows[1].edges.filter(edge => edge.parent)).toHaveLength(3);
  expect(new Set(graph.rows.slice(2, 5).map(row => row.color)).size).toBe(3);
  expect(graph.rows[5].color).toBe(graph.rows[0].color);
  expect(graph.rows[5].lane).toBe(graph.rows[0].lane);
  expect(buildCommitGraph([])).toEqual({ rows: [], lanes: 1 });
});

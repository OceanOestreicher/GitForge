import { test, expect } from '@playwright/test';
import { DiffCache } from '../src/diff-cache';

test('diff requests share work, obey a two-request limit and prioritize the latest foreground file', async () => {
  const started: string[] = [], release = new Map<string, (value: string) => void>();
  const cache = new DiffCache((_root, request) => new Promise(resolve => { started.push(request.path); release.set(request.path, resolve); }));
  const first = cache.load('repo', { path: 'a' }, 'v1', 2), second = cache.load('repo', { path: 'b' }, 'v1', 2);
  const third = cache.load('repo', { path: 'c' }, 'v1', 2), fourth = cache.load('repo', { path: 'd' }, 'v1', 2);
  await expect.poll(() => started).toEqual(['a', 'b']);
  expect(cache.load('repo', { path: 'd' }, 'v1')).toBe(fourth);
  release.get('a')!('a'); await first;
  await expect.poll(() => started).toEqual(['a', 'b', 'd']);
  release.get('d')!('d'); await fourth;
  await expect.poll(() => started).toEqual(['a', 'b', 'd', 'c']);
  release.get('b')!('b'); release.get('c')!('c'); await Promise.all([second, third]);
  await expect(cache.load('repo', { path: 'd' }, 'v1')).resolves.toBe('d');
  expect(started).toHaveLength(4);
});

test('memory eviction protects the displayed diff and prefers inactive repositories', async () => {
  const cache = new DiffCache(async (_root, request) => request.path, 12);
  cache.activate('active');
  const release = cache.pin('active', { path: 'aaa' }, 'v1');
  await cache.load('active', { path: 'aaa' }, 'v1');
  await cache.load('inactive', { path: 'bbb' }, 'v1');
  await cache.load('active', { path: 'ccc' }, 'v1');
  expect(cache.peek('active', { path: 'aaa' }, 'v1')).toBe('aaa');
  expect(cache.peek('inactive', { path: 'bbb' }, 'v1')).toBeUndefined();
  expect(cache.peek('active', { path: 'ccc' }, 'v1')).toBe('ccc');
  release(); release();
  await cache.load('active', { path: 'ddd' }, 'v1');
  expect(cache.peek('active', { path: 'aaa' }, 'v1')).toBeUndefined();
});

test('staged/unstaged and file versions have separate cache entries and failures can be retried', async () => {
  let calls = 0;
  const cache = new DiffCache(async (_root, request) => { if (++calls === 1) throw new Error('Temporary failure'); return `${request.staged}:${calls}`; });
  await expect(cache.load('repo', { path: 'file' }, 'v1')).rejects.toThrow('Temporary failure');
  await expect(cache.load('repo', { path: 'file' }, 'v1')).resolves.toBe('undefined:2');
  await cache.load('repo', { path: 'file', staged: true }, 'v1');
  await cache.load('repo', { path: 'file' }, 'v2');
  expect(calls).toBe(4);
});

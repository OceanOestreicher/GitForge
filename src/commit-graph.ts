export const graphColors = ['#38bcd4', '#a679eb', '#e5b852', '#60bd86', '#e87b8e', '#648fe4'];
type CommitNode = { hash: string; parents: string[] };
type Lane = { hash: string; color: string; path: number };
export type GraphEdge = { from: number; to: number; start: 'top' | 'node'; end: 'node' | 'bottom'; color: string; parent?: string; dashed?: boolean; path: number };
export type GraphRow = { hash: string; lane: number; color: string; path: number; edges: GraphEdge[] };
type Graph = { rows: GraphRow[]; lanes: number };

/** Keep first-parent paths in their lane; allocate a distinct lane for each fork. */
export function buildCommitGraph(commits: CommitNode[]): Graph {
  const lanes: (Lane | null)[] = []; let nextColor = 0, width = 1;
  const newPath = (hash: string): Lane => { const path = nextColor++; return { hash, path, color: graphColors[path % graphColors.length] }; };
  const freeLane = () => { const free = lanes.indexOf(null); return free < 0 ? lanes.length : free; };
  const rows = commits.map(commit => {
    const incoming = lanes.flatMap((item, index) => item?.hash === commit.hash ? [index] : []);
    let lane = incoming[0] ?? -1;
    if (lane < 0) { lane = freeLane(); lanes[lane] = newPath(commit.hash); }
    const ownPath = lanes[lane]!;
    const ownColor = ownPath.color;
    const edges: GraphEdge[] = [];
    lanes.forEach((item, index) => {
      if (!item) return;
      if (incoming.includes(index)) edges.push({ from: index, to: lane, start: 'top', end: 'node', color: item.color, path: item.path });
      else if (index !== lane) edges.push({ from: index, to: index, start: 'top', end: 'bottom', color: item.color, path: item.path });
    });
    // Multiple paths may wait for the same ancestor. Keep them separate until
    // that ancestor is actually drawn, then join them at its node.
    for (const index of incoming) lanes[index] = null;
    lanes[lane] = null;
    [...new Set(commit.parents)].forEach((parent, index) => {
      const target = index === 0 ? lane : freeLane();
      lanes[target] = index === 0 ? { ...ownPath, hash: parent } : newPath(parent);
      edges.push({ from: lane, to: target, start: 'node', end: 'bottom', color: lanes[target]!.color, path: lanes[target]!.path, parent });
    });
    width = Math.max(width, lanes.length, lane + 1);
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { hash: commit.hash, lane, color: ownColor, path: ownPath.path, edges };
  });
  return { rows, lanes: width };
}

/** Only real working changes create WIP. Promote its path by swapping colors with the original base path. */
export function buildHistoryGraph(commits: CommitNode[], head: string | null, hasChanges: boolean): Graph {
  const clean = buildCommitGraph(commits);
  if (!hasChanges) return clean;
  const graph = buildCommitGraph([{ hash: 'gitforge-wip', parents: head ? [head] : [] }, ...commits]);
  const cleanByHash = new Map(clean.rows.map(row => [row.hash, row]));
  const waitingForHead = clean.rows.flatMap(row => row.edges.filter(edge => edge.parent === head)).sort((a, b) => a.to - b.to);
  const previousColor = cleanByHash.get(head || '')?.color ?? waitingForHead[0]?.color ?? graphColors[1];
  const colors = new Map<number, string>([[0, graphColors[0]]]);
  const assign = (path: number, original: { path: number; color: string } | undefined) => {
    if (!colors.has(path) && original) colors.set(path, original.path === 0 ? previousColor : original.color);
  };
  for (const row of graph.rows) {
    const original = cleanByHash.get(row.hash);
    assign(row.path, original);
    for (const edge of row.edges) {
      if (edge.parent) assign(edge.path, original?.edges.find(candidate => candidate.parent === edge.parent));
    }
  }
  const headIndex = graph.rows.findIndex(row => row.hash === head);
  return { ...graph, rows: graph.rows.map((row, index) => ({
    ...row, color: colors.get(row.path) ?? row.color,
    edges: row.edges.map(edge => ({ ...edge, color: colors.get(edge.path) ?? edge.color,
      ...((headIndex < 0 || index <= headIndex) && edge.path === 0 && (index === 0 || edge.start === 'top') ? { dashed: true } : {})
    }))
  })) };
}

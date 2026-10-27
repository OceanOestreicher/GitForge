export const graphColors = ['#38bcd4', '#a679eb', '#e5b852', '#60bd86', '#e87b8e', '#648fe4'];
type CommitNode = { hash: string; parents: string[] };
type Lane = { hash: string; color: string };
export type GraphEdge = { from: number; to: number; start: 'top' | 'node'; end: 'node' | 'bottom'; color: string; parent?: string; dashed?: boolean };
export type GraphRow = { hash: string; lane: number; color: string; edges: GraphEdge[] };
type Graph = { rows: GraphRow[]; lanes: number };

/** Keep first-parent paths in their lane; allocate a distinct lane for each fork. */
export function buildCommitGraph(commits: CommitNode[]): Graph {
  const lanes: (Lane | null)[] = []; let nextColor = 0, width = 1;
  const color = () => graphColors[nextColor++ % graphColors.length];
  const freeLane = () => { const free = lanes.indexOf(null); return free < 0 ? lanes.length : free; };
  const rows = commits.map(commit => {
    const incoming = lanes.flatMap((item, index) => item?.hash === commit.hash ? [index] : []);
    let lane = incoming[0] ?? -1;
    if (lane < 0) { lane = freeLane(); lanes[lane] = { hash: commit.hash, color: color() }; }
    const ownColor = lanes[lane]!.color;
    const edges: GraphEdge[] = [];
    lanes.forEach((item, index) => {
      if (!item) return;
      if (incoming.includes(index)) edges.push({ from: index, to: lane, start: 'top', end: 'node', color: item.color });
      else if (index !== lane) edges.push({ from: index, to: index, start: 'top', end: 'bottom', color: item.color });
    });
    // Multiple paths may wait for the same ancestor. Keep them separate until
    // that ancestor is actually drawn, then join them at its node.
    for (const index of incoming) lanes[index] = null;
    lanes[lane] = null;
    [...new Set(commit.parents)].forEach((parent, index) => {
      const target = index === 0 ? lane : freeLane();
      lanes[target] = { hash: parent, color: index === 0 ? ownColor : color() };
      edges.push({ from: lane, to: target, start: 'node', end: 'bottom', color: index === 0 ? ownColor : lanes[target]!.color, parent });
    });
    width = Math.max(width, lanes.length, lane + 1);
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { hash: commit.hash, lane, color: ownColor, edges };
  });
  return { rows, lanes: width };
}

/** Attach WIP without letting checkout change committed lanes or colors. */
export function withWorkingChanges(graph: Graph, head: string | null): Graph {
  const headIndex = graph.rows.findIndex(row => row.hash === head);
  const headRow = graph.rows[headIndex];
  const lane = headIndex === 0 ? headRow.lane : head ? graph.lanes : 0;
  const color = headRow?.color ?? (head ? '#929eae' : graphColors[0]);
  const wip: GraphRow = { hash: 'gitforge-wip', lane, color, edges: head ? [{ from: lane, to: lane, start: 'node', end: 'bottom', color, dashed: true, parent: head }] : [] };
  return {
    lanes: Math.max(graph.lanes, lane + 1),
    rows: [wip, ...graph.rows.map((row, index) => {
      if (!head || (headIndex >= 0 && index > headIndex)) return row;
      const connection: GraphEdge = { from: lane, to: index === headIndex ? row.lane : lane, start: 'top', end: index === headIndex ? 'node' : 'bottom', color, dashed: true };
      return { ...row, edges: [...row.edges, connection] };
    })]
  };
}

/** Real working changes are the newest node; a clean placeholder is only an overlay. */
export function buildHistoryGraph(commits: CommitNode[], head: string | null, hasChanges: boolean): Graph {
  if (!hasChanges) return withWorkingChanges(buildCommitGraph(commits), head);
  const graph = buildCommitGraph([{ hash: 'gitforge-wip', parents: head ? [head] : [] }, ...commits]);
  const headIndex = graph.rows.findIndex(row => row.hash === head);
  const wipLane = graph.rows[0].lane;
  return { ...graph, rows: graph.rows.map((row, index) => {
    if (headIndex >= 0 && index > headIndex) return row;
    return { ...row, edges: row.edges.map(edge => edge.from === wipLane && (index === 0 || edge.start === 'top') ? { ...edge, dashed: true } : edge) };
  }) };
}

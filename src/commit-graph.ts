export const graphColors = ['#38bcd4', '#a679eb', '#e5b852', '#60bd86', '#e87b8e', '#648fe4'];
type CommitNode = { hash: string; parents: string[] };
type Lane = { hash: string; color: string };
export type GraphEdge = { from: number; to: number; start: 'top' | 'node'; end: 'node' | 'bottom'; color: string; parent?: string };
export type GraphRow = { hash: string; lane: number; color: string; edges: GraphEdge[] };

/** Keep first-parent paths in their lane; allocate a distinct lane for each fork. */
export function buildCommitGraph(commits: CommitNode[]): { rows: GraphRow[]; lanes: number } {
  const lanes: (Lane | null)[] = []; let nextColor = 0, width = 1;
  const color = () => graphColors[nextColor++ % graphColors.length];
  const freeLane = () => { const free = lanes.indexOf(null); return free < 0 ? lanes.length : free; };
  const rows = commits.map(commit => {
    let lane = lanes.findIndex(item => item?.hash === commit.hash);
    const continued = lane >= 0;
    if (lane < 0) { lane = freeLane(); lanes[lane] = { hash: commit.hash, color: color() }; }
    const ownColor = lanes[lane]!.color;
    const edges: GraphEdge[] = [];
    lanes.forEach((item, index) => {
      if (item && index !== lane) edges.push({ from: index, to: index, start: 'top', end: 'bottom', color: item.color });
    });
    if (continued) edges.push({ from: lane, to: lane, start: 'top', end: 'node', color: ownColor });
    lanes[lane] = null;
    [...new Set(commit.parents)].forEach((parent, index) => {
      let target = lanes.findIndex(item => item?.hash === parent);
      if (index === 0 && target > lane) {
        // Rejoin a side path into the earlier first-parent lane, preserving its color.
        const joining = edges.find(edge => edge.from === target && edge.start === 'top' && edge.end === 'bottom');
        if (joining) joining.to = lane;
        lanes[target] = null; target = lane;
        lanes[target] = { hash: parent, color: ownColor };
      }
      if (target < 0) {
        target = index === 0 ? lane : freeLane();
        lanes[target] = { hash: parent, color: index === 0 ? ownColor : color() };
      }
      edges.push({ from: lane, to: target, start: 'node', end: 'bottom', color: index === 0 ? ownColor : lanes[target]!.color, parent });
    });
    width = Math.max(width, lanes.length, lane + 1);
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { hash: commit.hash, lane, color: ownColor, edges };
  });
  return { rows, lanes: width };
}

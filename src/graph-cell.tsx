import type { GraphRow } from './commit-graph';

export function GraphCell({ row, lanes, current, wip = false }: { row: GraphRow; lanes: number; current?: boolean; wip?: boolean }) {
  const width = lanes * 18 + 18, x = (lane: number) => 18 + lane * 18;
  return <td className="commit-graph-cell" style={{ width, minWidth: width }}>
    <svg className="commit-graph" viewBox={`0 0 ${width} 32`} preserveAspectRatio="none" aria-label={wip ? 'Working changes graph' : 'Commit graph'}>
      {row.edges.map((edge, index) => {
        const start = edge.start === 'top' ? 0 : 16, end = edge.end === 'node' ? 16 : 32;
        return <path key={index} data-parent-hash={edge.parent} d={`M${x(edge.from)} ${start} C${x(edge.from)} ${start + (end - start) / 2} ${x(edge.to)} ${start + (end - start) / 2} ${x(edge.to)} ${end}`} stroke={edge.color} strokeWidth="2" strokeDasharray={edge.dashed ? '3 3' : undefined} fill="none"/>;
      })}
      <circle className={wip ? 'graph-wip-node' : 'graph-commit-node'} cx={x(row.lane)} cy="16" r={current ? 5 : 4} fill={wip ? '#24272e' : row.color} stroke={row.color} strokeWidth={current ? 2 : 1} data-lane={row.lane} data-color={row.color}/>
      {current && <circle cx={x(row.lane)} cy="16" r="2" fill="#fff"/>}
    </svg>
  </td>;
}

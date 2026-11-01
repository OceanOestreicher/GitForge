import { memo, useMemo } from 'react';
import { parseDiff } from './diff';

export const DiffContent = memo(function DiffContent({ text }: { text: string }) {
  const rows = useMemo(() => parseDiff(text), [text]);
  return <pre className="diff" aria-label="File diff">{text ? rows.map((row, index) => <div className={`diff-row ${row.kind === 'notice' ? 'diff-notice' : row.kind}${row.startsHunk ? ' hunk-start' : ''}`} key={index}><span className="line-number old-line" aria-label="Old line number">{row.oldLine ?? ''}</span><span className="line-number new-line" aria-label="New line number">{row.newLine ?? ''}</span><span className="diff-code">{row.marker ? `${row.marker} ${row.text}` : row.text || ' '}</span></div>) : 'Loading diff…'}</pre>;
});

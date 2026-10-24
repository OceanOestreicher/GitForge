export type DiffRow = {
  oldLine?: number;
  newLine?: number;
  marker: string;
  text: string;
  kind: 'addition' | 'deletion' | 'context' | 'notice';
  startsHunk?: boolean;
};

export function parseDiff(diff: string): DiffRow[] {
  const lines = diff.split('\n');
  const patch = lines.some(line => line.startsWith('diff --git '));
  let oldLine = 1, newLine = 1, inHunk = !patch, startsHunk = false;
  const rows: DiffRow[] = [];
  for (const line of lines) {
    if (patch && line.startsWith('diff --git ')) { inHunk = false; continue; }
    const header = patch ? /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line) : null;
    if (header) {
      oldLine = Number(header[1]); newLine = Number(header[2]);
      inHunk = true; startsHunk = rows.length > 0;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') rows.push({ marker: '', text: 'Binary file', kind: 'notice' });
      continue;
    }
    if (line.startsWith('+')) rows.push({ newLine: newLine++, marker: '+', text: line.slice(1), kind: 'addition', startsHunk });
    else if (line.startsWith('-')) rows.push({ oldLine: oldLine++, marker: '-', text: line.slice(1), kind: 'deletion', startsHunk });
    else if (patch && line.startsWith(' ')) rows.push({ oldLine: oldLine++, newLine: newLine++, marker: ' ', text: line.slice(1), kind: 'context', startsHunk });
    else if (line) rows.push({ marker: '', text: line, kind: 'notice', startsHunk });
    else continue;
    startsHunk = false;
  }
  return rows;
}

export type MergeRegion = { id: number; ours: string; theirs: string; canBoth: boolean; choice: string | null };
export type SourceLine = { text: string; number: number | null; region?: number; line?: number };
export type MergeFile = { index: number; total: number; regions: MergeRegion[]; parts: { text?: string; region?: number }[]; oursRows: SourceLine[]; theirsRows: SourceLine[]; editable: boolean; oursDeleted: boolean; theirsDeleted: boolean };
export type Selections = Record<number, { ours: boolean[]; theirs: boolean[]; touched: boolean }>;
type Row = { key: string; text: string; conflict: boolean; manual: boolean };
export type Output = { rows: Row[]; ending: boolean; endingEdited: boolean; removed: string[]; nextId: number };

export function splitLines(text: string): { lines: string[]; ending: boolean } {
  const value = text.replace(/\r\n/g, '\n'), lines = value ? value.split('\n') : [];
  const ending = value.endsWith('\n');
  if (ending) lines.pop();
  return { lines, ending };
}
export function initialSelections(file: MergeFile): Selections {
  return Object.fromEntries(file.regions.map(region => [region.id, {
    ours: Array(Math.max(1, splitLines(region.ours).lines.length)).fill(['ours', 'both'].includes(region.choice || '')),
    theirs: Array(Math.max(1, splitLines(region.theirs).lines.length)).fill(['theirs', 'both'].includes(region.choice || '')),
    touched: Boolean(region.choice)
  }]));
}
export function generateOutput(file: MergeFile, selections: Selections): Output {
  const rows: Row[] = []; let ending = false;
  for (const [index, part] of file.parts.entries()) {
    if (part.text !== undefined) {
      const value = splitLines(part.text);
      rows.push(...value.lines.map((text, line) => ({ key: `context:${index}:${line}`, text, conflict: false, manual: false })));
      if (value.lines.length) ending = value.ending;
    } else {
      const region = file.regions.find(region => region.id === part.region)!;
      for (const side of ['ours', 'theirs'] as const) {
        if (file.parts.length === 1 && (side === 'ours' ? file.oursDeleted : file.theirsDeleted)) continue;
        const value = splitLines(region[side]);
        value.lines.forEach((text, line) => {
          if (!selections[region.id][side][line]) return;
          rows.push({ key: `${side}:${region.id}:${line}`, text, conflict: true, manual: false });
          ending = line < value.lines.length - 1 || value.ending;
        });
      }
    }
  }
  return { rows, ending, endingEdited: false, removed: [], nextId: 0 };
}
export function outputText(output: Output): string { return output.rows.map(row => row.text).join('\n') + (output.ending && output.rows.length ? '\n' : ''); }

/** Track edited line identities so later source selections preserve manual text. */
export function editOutput(output: Output, text: string): Output {
  const next = splitLines(text); let prefix = 0, suffix = 0, nextId = output.nextId;
  while (prefix < output.rows.length && prefix < next.lines.length && output.rows[prefix].text === next.lines[prefix]) prefix++;
  while (suffix < output.rows.length - prefix && suffix < next.lines.length - prefix && output.rows[output.rows.length - suffix - 1].text === next.lines[next.lines.length - suffix - 1]) suffix++;
  const replaced = output.rows.slice(prefix, output.rows.length - suffix);
  const additions = next.lines.slice(prefix, next.lines.length - suffix).map((text, index) => ({
    key: replaced[index]?.key ?? `manual:${nextId++}`, text, manual: true,
    conflict: replaced[index]?.conflict ?? output.rows[prefix - 1]?.conflict ?? output.rows[prefix]?.conflict ?? false
  }));
  const retained = new Set(additions.map(row => row.key));
  return {
    rows: [...output.rows.slice(0, prefix), ...additions, ...output.rows.slice(output.rows.length - suffix)],
    ending: next.ending, endingEdited: output.endingEdited || output.ending !== next.ending,
    removed: [...new Set([...output.removed, ...replaced.filter(row => !retained.has(row.key)).map(row => row.key)])], nextId
  };
}

/** Reconcile checkbox changes around manual edits, without replacing the document. */
export function updateSelections(output: Output, generated: Output): Output {
  const keys = new Set(generated.rows.map(row => row.key)), overrides = new Map<string, Row>(), buckets = new Map<string | null, Row[]>();
  let anchor: string | null = null;
  for (const row of output.rows) {
    if (keys.has(row.key)) { anchor = row.key; if (row.manual) overrides.set(row.key, row); }
    else if (row.manual) { const bucket = buckets.get(anchor) || []; bucket.push(row); buckets.set(anchor, bucket); }
  }
  const removed = new Set(output.removed), rows = [...(buckets.get(null) || [])];
  for (const row of generated.rows) {
    if (!removed.has(row.key)) rows.push(overrides.get(row.key) || row);
    rows.push(...(buckets.get(row.key) || []));
  }
  return { ...output, rows, ending: output.endingEdited || rows.at(-1)?.manual ? output.ending : generated.ending };
}

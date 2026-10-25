function textLines(text) {
  const result = text.replace(/\r\n/g, '\n').split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}

function fileView(session, fileIndex) {
  const file = session.files[fileIndex];
  const indexed = session.steps.map((step, index) => ({ ...step, id: index })).filter(step => step.fileIndex === fileIndex);
  const regions = indexed.map(step => ({ id: step.id, ours: !file.parts.length && file.sources.ours.readable ? file.sources.ours.text : step.ours, theirs: !file.parts.length && file.sources.theirs.readable ? file.sources.theirs.text : step.theirs, canBoth: step.canBoth, choice: session.choices[step.id] || null }));
  const parts = file.parts.length ? file.parts.map((part, partIndex) => part.text !== undefined ? { text: part.text } : { region: indexed.find(step => step.partIndex === partIndex).id }) : [{ region: indexed[0].id }];
  const sourceRows = side => {
    const source = file.sources[side];
    const rows = textLines(source.text).map((text, index) => ({ text, number: source.readable ? index + 1 : null }));
    const numbered = new Map(rows.filter(row => row.number !== null).map(row => [row.number, row]));
    for (const step of indexed) {
      const highlighted = step[side + 'Lines'].filter(line => line.conflict);
      highlighted.forEach((line, index) => {
        if (line.number !== null && numbered.has(line.number)) Object.assign(numbered.get(line.number), { region: step.id, line: index });
      });
      if (!file.parts.length) rows.forEach((row, index) => Object.assign(row, { region: step.id, line: index }));
      else if (!highlighted.some(line => line.number !== null)) {
        const following = step[side + 'Lines'].find((line, index, values) => !line.conflict && values.slice(0, index).some(previous => previous.conflict));
        const position = following ? rows.findIndex(row => row.number === following.number) : rows.length;
        rows.splice(position < 0 ? rows.length : position, 0, { text: '(No lines)', number: null, region: step.id, line: 0 });
      }
    }
    if (!rows.length) rows.push({ text: file.stages[side === 'ours' ? 2 : 3] ? '(No lines)' : '(Deleted)', number: null, region: indexed[0].id, line: 0 });
    return rows;
  };
  return { index: fileIndex, total: session.files.length, regions, parts, oursRows: sourceRows('ours'), theirsRows: sourceRows('theirs'), editable: file.sources.editable, oursDeleted: !file.stages[2], theirsDeleted: !file.stages[3] };
}
module.exports = { fileView };

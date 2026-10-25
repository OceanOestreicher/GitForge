const contextSize = 3;
function lines(text) {
  if (!text) return [];
  const result = text.replace(/\r\n/g, '\n').split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}

function preview(source, chunk, before, after, cursor) {
  const content = lines(chunk), prefix = lines(before).slice(-contextSize), suffix = lines(after).slice(0, contextSize);
  const expected = cursor + lines(before).length;
  let start = -1, best = -1;
  for (let index = cursor; index <= source.length - content.length; index++) {
    if (!content.every((text, offset) => text === source[index + offset])) continue;
    let score = 0;
    for (let offset = 1; offset <= prefix.length; offset++) {
      if (prefix.at(-offset) !== source[index - offset]) break;
      score++;
    }
    for (let offset = 0; offset < suffix.length; offset++) {
      if (suffix[offset] !== source[index + content.length + offset]) break;
      score++;
    }
    if (score > best || (score === best && Math.abs(index - expected) < Math.abs(start - expected))) { best = score; start = index; }
  }
  const found = start >= 0;
  if (!found) start = Math.min(expected, source.length);
  const end = found ? start + content.length : start;
  const row = (text, number, conflict = false) => ({ text, number, conflict });
  const contextBefore = source.slice(Math.max(0, start - contextSize), start).map((text, index) => row(text, Math.max(0, start - contextSize) + index + 1));
  const conflict = content.length ? content.map((text, index) => row(text, found ? start + index + 1 : null, true)) : [row('(No lines)', null, true)];
  const contextAfter = source.slice(end, end + contextSize).map((text, index) => row(text, end + index + 1));
  return { rows: [...contextBefore, ...conflict, ...contextAfter], cursor: end };
}

function buildPreviews(parts, steps, ours, theirs) {
  const result = steps.map(() => ({}));
  for (const side of ['ours', 'theirs']) {
    const buffer = side === 'ours' ? ours : theirs;
    const readable = buffer && !buffer.includes(0) && buffer.length <= 8 * 1024 * 1024;
    const source = readable ? lines(buffer.toString('utf8')) : [];
    let cursor = 0;
    steps.forEach((step, index) => {
      if (!parts.length || !readable) {
        result[index][side + 'Lines'] = (lines(step[side]).length ? lines(step[side]) : ['(No lines)']).map((text, offset) => ({ text, number: readable && source.length ? offset + 1 : null, conflict: true }));
        return;
      }
      const before = parts[step.partIndex - 1]?.text || '', after = parts[step.partIndex + 1]?.text || '';
      const value = preview(source, step[side], before, after, cursor);
      result[index][side + 'Lines'] = value.rows;
      cursor = value.cursor;
    });
  }
  return result;
}
module.exports = { buildPreviews };

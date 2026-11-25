const libraryCollator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const librarySearchText = (text) => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');

function libraryMatches(query, ...fields) {
  const text = librarySearchText(fields.join(' '));
  return librarySearchText(query).trim().split(/\s+/).every((word) => text.includes(word));
}

function libraryPage(prefix, items, page, size) {
  const last = Math.max(0, Math.ceil(items.length / size) - 1);
  const current = Math.min(last, Math.max(0, page));
  const start = current * size;
  const end = Math.min(start + size, items.length);
  document.getElementById(prefix + '-pagination').hidden = last === 0;
  document.getElementById(prefix + '-range').textContent = items.length ? (start + 1) + '–' + end + ' sur ' + items.length : '';
  document.getElementById(prefix + '-prev').disabled = current === 0;
  document.getElementById(prefix + '-next').disabled = current === last;
  return { current, items: items.slice(start, end) };
}

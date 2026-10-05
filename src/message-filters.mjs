// Read-only filters always compose with the caller's existing custody scope.
export function searchTerm(url, fail) {
  const value = url.searchParams.get('q') ?? '';
  if (value.length > 200) fail(422, 'INVALID_SEARCH', 'Search is limited to 200 characters.');
  return value.trim();
}

export function messageFilters(url, fail, canViewOwnerInbox) {
  const clauses = [], values = [], q = searchTerm(url, fail);
  const scope = url.searchParams.get('scope');
  if (scope !== null) {
    if (scope !== 'owner') fail(422, 'INVALID_SCOPE', 'Use owner for the human owner inbox.');
    if (!canViewOwnerInbox) fail(403, 'OWNER_INBOX_DENIED', 'Owner questions require owner or project observer access.');
    clauses.push("m.to_session_id IS NULL AND m.kind='QUESTION'");
  }
  if (q) { clauses.push('instr(lower(m.body),lower(?))>0'); values.push(q); }
  return { clauses, values };
}

export function selectOrderPage(selected, rows, checked) {
  const next = new Set(selected);
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (checked) next.add(id);
    else next.delete(id);
  }
  return next;
}

export function retainSelectedOrders(previous, rows, selected) {
  const next = new Map([...previous].filter(([id]) => selected.has(id)));
  for (const row of rows) if (selected.has(Number(row.id))) next.set(Number(row.id), row);
  return next;
}

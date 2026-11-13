export function dashboardTrendRows(rows = [], endDate = '', days = 7) {
  const end = Date.parse(`${endDate}T00:00:00+08:00`);
  if (!Number.isFinite(end)) return [];
  const start = end - (days - 1) * 86400000;
  const byDate = new Map(rows.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date_key)).map(row => [row.date_key, row]));
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(start + i * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
    return { date_key: date, ...(byDate.get(date) || {}) };
  });
}
export function dashboardTrendGeometry(rows, financial = false) {
  const value = item => item !== null && item !== undefined && item !== '' && Number.isFinite(Number(item)) ? Number(item) : null;
  const series = financial ? ['revenue', 'profit'] : ['revenue'];
  const values = rows.flatMap(row => series.map(key => value(row[key]))).filter(n => n !== null);
  const min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
  const x = i => 58 + i / Math.max(rows.length - 1, 1) * 630;
  const y = n => 115 - (n - min) / span * 98;
  const paths = Object.fromEntries(series.map(key => {
    let previous = false;
    const path = rows.map((row, i) => {
      const n = value(row[key]);
      if (n === null) { previous = false; return ''; }
      const command = `${previous ? 'L' : 'M'}${x(i).toFixed(2)},${y(n).toFixed(2)}`;
      previous = true;
      return command;
    }).filter(Boolean).join(' ');
    return [key, path];
  }));
  return { paths, min, max, hasData: values.length > 0, x, y, value };
}

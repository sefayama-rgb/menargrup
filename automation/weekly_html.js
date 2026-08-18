const fs = require('fs');
const path = require('path');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else {
      if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(r => r.some(v => v !== ''));
}

function makeHtml(title, csvPath, htmlPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const [head = [], ...body] = rows;
  const th = head.map(x => `<th>${escapeHtml(x)}</th>`).join('');
  const trs = body.map(r => `<tr>${head.map((_, i) => `<td>${escapeHtml(r[i] ?? '')}</td>`).join('')}</tr>`).join('\n');
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:Arial,sans-serif;margin:12px}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:4px 6px;white-space:nowrap}th{background:#eaf6f4}</style></head><body><table id="data"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
  fs.writeFileSync(htmlPath, html, 'utf8');
}

const dataDir = path.join(process.cwd(), 'data');
makeHtml('MENAR Haftalık KPI', path.join(dataDir, 'weekly_kpi.csv'), path.join(dataDir, 'weekly_kpi_table.html'));
makeHtml('MENAR Bitrix Görevleri', path.join(dataDir, 'tasks_latest.csv'), path.join(dataDir, 'tasks_latest_table.html'));
console.log('HTML veri tabloları üretildi.');

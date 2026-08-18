const fs = require('fs');
const path = require('path');

const META_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || '1521138858696042';
const BITRIX_WEBHOOK = (process.env.BITRIX_WEBHOOK || '').replace(/\/$/, '');
const BITRIX_PORTAL = BITRIX_WEBHOOK ? new URL(BITRIX_WEBHOOK).origin : '';
const TZ = 'Europe/Istanbul';

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error?.message || data.error_description || data.error || `HTTP ${response.status}`);
  }
  return data;
}

function dateInTimeZone(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = type => parts.find(x => x.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const day = d.getUTCDay();
  return addDays(dateStr, day === 0 ? -6 : 1 - day);
}

function buildQuery(params = {}, start = 0) {
  const q = new URLSearchParams();
  q.set('start', String(start));
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach(v => q.append(`${key}[]`, v));
    else if (value && typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value)) q.append(`${key}[${subKey}]`, subValue);
    } else if (value !== undefined && value !== null) {
      q.set(key, String(value));
    }
  }
  return q.toString();
}

async function getAllBitrix(method, params = {}) {
  if (!BITRIX_WEBHOOK) throw new Error('BITRIX_WEBHOOK eksik');
  const rows = [];
  let start = 0;
  while (true) {
    const data = await getJson(`${BITRIX_WEBHOOK}/${method}.json?${buildQuery(params, start)}`);
    const result = Array.isArray(data.result) ? data.result : [];
    rows.push(...result);
    if (data.next === undefined) break;
    start = data.next;
  }
  return rows;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath, rows, columns) {
  const header = columns.map(c => csvEscape(c.label)).join(',');
  const body = rows.map(row => columns.map(c => csvEscape(row[c.key])).join(',')).join('\n');
  fs.writeFileSync(filePath, `${header}\n${body}${body ? '\n' : ''}`, 'utf8');
}

function field(obj, ...keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return null;
}

function number(value) {
  return Number(value || 0);
}

async function getWeeklyMeta(weekStart, today) {
  if (!META_TOKEN) return { status: 'META_ACCESS_TOKEN eksik', spend: 0, messages: 0, costPerMessage: null };
  const params = new URLSearchParams({
    access_token: META_TOKEN,
    fields: 'campaign_name,spend,actions,date_start,date_stop',
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since: weekStart, until: today }),
    limit: '500'
  });
  const payload = await getJson(`https://graph.facebook.com/v23.0/act_${META_AD_ACCOUNT_ID}/insights?${params}`);
  let spend = 0;
  let messages = 0;
  const messageKeys = [
    'onsite_conversion.messaging_conversation_started_7d',
    'onsite_conversion_messaging_conversation_started_7d',
    'messaging_conversation_started_7d',
    'messaging_first_reply',
    'onsite_conversion.messaging_first_reply'
  ];
  for (const row of payload.data || []) {
    spend += number(row.spend);
    const actions = Object.fromEntries((row.actions || []).map(x => [x.action_type, number(x.value)]));
    messages += messageKeys.reduce((max, key) => Math.max(max, actions[key] || 0), 0);
  }
  return { status: 'aktif', spend, messages, costPerMessage: messages ? spend / messages : null };
}

async function getWeeklyCrm(weekStart, today) {
  const endExclusive = `${addDays(today, 1)}T00:00:00+03:00`;
  const startIso = `${weekStart}T00:00:00+03:00`;

  const created = await getAllBitrix('crm.lead.list', {
    SELECT: ['ID', 'DATE_CREATE'],
    ORDER: { DATE_CREATE: 'DESC' },
    FILTER: { '>=DATE_CREATE': startIso, '<DATE_CREATE': endExclusive }
  });

  const closed = await getAllBitrix('crm.lead.list', {
    SELECT: ['ID', 'STATUS_SEMANTIC_ID', 'DATE_CLOSED'],
    ORDER: { DATE_CLOSED: 'DESC' },
    FILTER: { '>=DATE_CLOSED': startIso, '<DATE_CLOSED': endExclusive }
  });

  const won = closed.filter(x => String(x.STATUS_SEMANTIC_ID || '').toUpperCase() === 'S').length;
  const rejected = closed.filter(x => String(x.STATUS_SEMANTIC_ID || '').toUpperCase() === 'F').length;
  const meaningful = won + rejected;
  return {
    status: 'aktif',
    newLeads: created.length,
    wonClosed: won,
    rejectedClosed: rejected,
    closeConversionRate: meaningful ? (won / meaningful) * 100 : 0
  };
}

async function getAllTasksRaw() {
  if (!BITRIX_WEBHOOK) throw new Error('BITRIX_WEBHOOK eksik');
  const rows = [];
  let start = 0;
  while (true) {
    const data = await getJson(`${BITRIX_WEBHOOK}/tasks.task.list.json?${buildQuery({
      select: ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'DEADLINE', 'CREATED_DATE', 'CLOSED_DATE', 'GROUP_ID'],
      order: { ID: 'DESC' }
    }, start)}`);
    const items = Array.isArray(data.result) ? data.result : (Array.isArray(data.result?.tasks) ? data.result.tasks : []);
    rows.push(...items);
    if (data.next === undefined) break;
    start = data.next;
  }
  return rows;
}

async function getUserMap() {
  try {
    const users = await getAllBitrix('user.get', {});
    return Object.fromEntries(users.map(u => {
      const id = String(field(u, 'ID', 'id') || '');
      const name = [field(u, 'NAME', 'name'), field(u, 'LAST_NAME', 'lastName')].filter(Boolean).join(' ').trim();
      return [id, name || `#${id}`];
    }));
  } catch {
    return {};
  }
}

function inRange(value, startDate, endExclusive) {
  if (!value) return false;
  const d = new Date(value);
  return d >= new Date(`${startDate}T00:00:00+03:00`) && d < new Date(`${endExclusive}T00:00:00+03:00`);
}

function taskStatus(statusCode, deadline) {
  if (statusCode === '5') return 'Tamamlandı';
  if (deadline && new Date(deadline) < new Date()) return 'Gecikmiş';
  if (statusCode === '3') return 'Devam Ediyor';
  return 'Bekliyor';
}

async function getTasksBundle(weekStart, today) {
  const [rawTasks, userMap] = await Promise.all([getAllTasksRaw(), getUserMap()]);
  const endExclusive = addDays(today, 1);
  const summary = {
    total: 0, open: 0, waiting: 0, inProgress: 0,
    completed: 0, overdue: 0, createdThisWeek: 0, completedThisWeek: 0
  };

  const tasks = rawTasks.map(t => {
    const id = String(field(t, 'id', 'ID') || '');
    const responsibleId = String(field(t, 'responsibleId', 'RESPONSIBLE_ID') || '');
    const statusCode = String(field(t, 'status', 'STATUS') || '');
    const deadline = field(t, 'deadline', 'DEADLINE');
    const createdDate = field(t, 'createdDate', 'CREATED_DATE');
    const closedDate = field(t, 'closedDate', 'CLOSED_DATE');
    const status = taskStatus(statusCode, deadline);
    const row = {
      id,
      title: field(t, 'title', 'TITLE') || '',
      responsibleId,
      responsibleName: userMap[responsibleId] || `#${responsibleId}`,
      status,
      statusCode,
      deadline: deadline || null,
      createdDate: createdDate || null,
      closedDate: closedDate || null,
      overdue: status === 'Gecikmiş',
      groupId: String(field(t, 'groupId', 'GROUP_ID') || ''),
      url: BITRIX_PORTAL && responsibleId && id ? `${BITRIX_PORTAL}/company/personal/user/${responsibleId}/tasks/task/view/${id}/` : ''
    };

    summary.total++;
    if (status === 'Tamamlandı') summary.completed++;
    else {
      summary.open++;
      if (status === 'Gecikmiş') summary.overdue++;
      else if (status === 'Devam Ediyor') summary.inProgress++;
      else summary.waiting++;
    }
    if (inRange(createdDate, weekStart, endExclusive)) summary.createdThisWeek++;
    if (statusCode === '5' && inRange(closedDate, weekStart, endExclusive)) summary.completedThisWeek++;
    return row;
  });

  return { generatedAt: new Date().toISOString(), status: 'aktif', summary, tasks };
}

function saveTasks(bundle) {
  const dataDir = path.join(process.cwd(), 'data');
  fs.writeFileSync(path.join(dataDir, 'tasks_latest.json'), JSON.stringify(bundle, null, 2), 'utf8');
  writeCsv(path.join(dataDir, 'tasks_latest.csv'), bundle.tasks || [], [
    { key: 'id', label: 'Bitrix Görev ID' },
    { key: 'title', label: 'Görev' },
    { key: 'responsibleId', label: 'Sorumlu ID' },
    { key: 'responsibleName', label: 'Sorumlu' },
    { key: 'status', label: 'Durum' },
    { key: 'statusCode', label: 'Durum Kodu' },
    { key: 'deadline', label: 'Son Tarih' },
    { key: 'createdDate', label: 'Oluşturma Tarihi' },
    { key: 'closedDate', label: 'Kapanış Tarihi' },
    { key: 'overdue', label: 'Gecikmiş' },
    { key: 'groupId', label: 'Grup ID' },
    { key: 'url', label: 'Bitrix Link' }
  ]);
}

function saveWeekly(record) {
  const dataDir = path.join(process.cwd(), 'data');
  const jsonPath = path.join(dataDir, 'weekly_kpi.json');
  const csvPath = path.join(dataDir, 'weekly_kpi.csv');
  let weeks = [];
  if (fs.existsSync(jsonPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      weeks = Array.isArray(old) ? old : (Array.isArray(old.weeks) ? old.weeks : []);
    } catch {
      weeks = [];
    }
  }

  const index = weeks.findIndex(x => x.weekStart === record.weekStart);
  if (index >= 0) weeks[index] = record;
  else weeks.push(record);
  weeks.sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart)));
  if (weeks.length > 104) weeks = weeks.slice(-104);

  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), weeks }, null, 2), 'utf8');
  writeCsv(csvPath, weeks, [
    { key: 'weekStart', label: 'Hafta Başlangıcı' },
    { key: 'weekEnd', label: 'Hafta Bitişi' },
    { key: 'asOfDate', label: 'Veri Tarihi' },
    { key: 'generatedAt', label: 'Güncelleme Zamanı' },
    { key: 'metaSpend', label: 'Meta Harcama' },
    { key: 'metaMessages', label: 'Meta Mesaj' },
    { key: 'metaCostPerMessage', label: 'Mesaj Maliyeti' },
    { key: 'crmNewLeads', label: 'Yeni Lead' },
    { key: 'crmWonClosed', label: 'Olumlu Kapanan' },
    { key: 'crmRejectedClosed', label: 'Olumsuz Kapanan' },
    { key: 'crmCloseConversionRate', label: 'Kapanış Dönüşüm %' },
    { key: 'crmTotal', label: 'CRM Toplam' },
    { key: 'crmActivePipeline', label: 'Aktif Pipeline' },
    { key: 'crmPriority', label: 'Öncelikli Takip' },
    { key: 'crmHot', label: 'Sıcak Müşteri' },
    { key: 'crmOffer', label: 'Teklif Bekleyen' },
    { key: 'taskTotal', label: 'Toplam Görev' },
    { key: 'taskOpen', label: 'Açık Görev' },
    { key: 'taskWaiting', label: 'Bekleyen Görev' },
    { key: 'taskInProgress', label: 'Devam Eden Görev' },
    { key: 'taskOverdue', label: 'Gecikmiş Görev' },
    { key: 'taskCreatedThisWeek', label: 'Bu Hafta Açılan Görev' },
    { key: 'taskCompletedThisWeek', label: 'Bu Hafta Tamamlanan Görev' },
    { key: 'metaStatus', label: 'Meta Durumu' },
    { key: 'bitrixStatus', label: 'Bitrix Durumu' },
    { key: 'tasksStatus', label: 'Görev Durumu' }
  ]);
}

async function main() {
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const today = dateInTimeZone();
  const weekStart = mondayOf(today);
  const weekEnd = addDays(weekStart, 6);

  let latest = {};
  try { latest = JSON.parse(fs.readFileSync(path.join(dataDir, 'latest.json'), 'utf8')); } catch {}
  const crmCurrent = latest.crm || {};

  let meta;
  try { meta = await getWeeklyMeta(weekStart, today); }
  catch (e) { meta = { status: `hata: ${e.message}`, spend: 0, messages: 0, costPerMessage: null }; }

  let crmWeek;
  try { crmWeek = await getWeeklyCrm(weekStart, today); }
  catch (e) { crmWeek = { status: `hata: ${e.message}`, newLeads: 0, wonClosed: 0, rejectedClosed: 0, closeConversionRate: 0 }; }

  let tasks;
  try { tasks = await getTasksBundle(weekStart, today); }
  catch (e) {
    tasks = {
      generatedAt: new Date().toISOString(),
      status: `hata: ${e.message}`,
      summary: { total: 0, open: 0, waiting: 0, inProgress: 0, completed: 0, overdue: 0, createdThisWeek: 0, completedThisWeek: 0 },
      tasks: []
    };
  }
  saveTasks(tasks);

  const s = tasks.summary || {};
  saveWeekly({
    weekStart,
    weekEnd,
    asOfDate: today,
    generatedAt: new Date().toISOString(),
    metaSpend: number(meta.spend),
    metaMessages: number(meta.messages),
    metaCostPerMessage: meta.costPerMessage,
    crmNewLeads: number(crmWeek.newLeads),
    crmWonClosed: number(crmWeek.wonClosed),
    crmRejectedClosed: number(crmWeek.rejectedClosed),
    crmCloseConversionRate: number(crmWeek.closeConversionRate),
    crmTotal: number(crmCurrent.total),
    crmActivePipeline: number(crmCurrent.activePipeline),
    crmPriority: number(crmCurrent.priority),
    crmHot: number(crmCurrent.hot),
    crmOffer: number(crmCurrent.offer),
    taskTotal: number(s.total),
    taskOpen: number(s.open),
    taskWaiting: number(s.waiting),
    taskInProgress: number(s.inProgress),
    taskOverdue: number(s.overdue),
    taskCreatedThisWeek: number(s.createdThisWeek),
    taskCompletedThisWeek: number(s.completedThisWeek),
    metaStatus: meta.status,
    bitrixStatus: crmWeek.status,
    tasksStatus: tasks.status
  });

  console.log('Haftalik raporlar yazildi: weekly_kpi.json/csv ve tasks_latest.json/csv');
}

main().catch(error => { console.error(error); process.exit(1); });

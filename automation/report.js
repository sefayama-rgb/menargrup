const fs = require('fs');
const path = require('path');

const META_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || '1521138858696042';
const BITRIX_WEBHOOK = (process.env.BITRIX_WEBHOOK || '').replace(/\/$/, '');

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.message || data.error_description || `HTTP ${response.status}`);
  return data;
}

const isoDate = d => d.toISOString().slice(0, 10);

async function getMeta() {
  if (!META_TOKEN) return { campaigns: [], status: 'META_ACCESS_TOKEN eksik' };
  const until = new Date();
  const since = new Date();
  since.setDate(until.getDate() - 1);
  const params = new URLSearchParams({
    access_token: META_TOKEN,
    fields: 'campaign_name,spend,actions,date_start,date_stop',
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since: isoDate(since), until: isoDate(until) }),
    limit: '500'
  });
  const payload = await getJson(`https://graph.facebook.com/v23.0/act_${META_AD_ACCOUNT_ID}/insights?${params}`);
  const campaigns = (payload.data || []).map(row => {
    const actions = Object.fromEntries((row.actions || []).map(x => [x.action_type, Number(x.value || 0)]));
    const messages = actions.onsite_conversion_messaging_conversation_started_7d || actions.messaging_conversation_started_7d || actions.messaging_first_reply || 0;
    const spend = Number(row.spend || 0);
    return { campaign: row.campaign_name || 'İsimsiz kampanya', spend, messages, costPerMessage: messages ? spend / messages : null, dateStart: row.date_start, dateStop: row.date_stop };
  });
  return { campaigns, status: 'aktif' };
}

function buildBitrixQuery(params = {}, start = 0) {
  const q = new URLSearchParams();
  q.set('start', String(start));
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach(v => q.append(`${key}[]`, v));
    else if (value && typeof value === 'object') for (const [sk, sv] of Object.entries(value)) q.append(`${key}[${sk}]`, sv);
    else q.set(key, value);
  }
  return q.toString();
}

async function getAllBitrix(method, params) {
  let start = 0, rows = [];
  while (true) {
    const data = await getJson(`${BITRIX_WEBHOOK}/${method}.json?${buildBitrixQuery(params, start)}`);
    rows.push(...(data.result || []));
    if (data.next === undefined) break;
    start = data.next;
  }
  return rows;
}

async function getBitrix() {
  if (!BITRIX_WEBHOOK) return { total: 0, new: 0, inProgress: 0, won: 0, rejected: 0, status: 'BITRIX_WEBHOOK eksik' };
  const since = new Date();
  since.setDate(since.getDate() - 1);
  const leads = await getAllBitrix('crm.lead.list', {
    SELECT: ['ID', 'TITLE', 'STATUS_ID', 'SOURCE_ID', 'DATE_CREATE', 'ASSIGNED_BY_ID'],
    ORDER: { DATE_CREATE: 'DESC' },
    FILTER: { '>=DATE_CREATE': `${isoDate(since)}T00:00:00` }
  });
  const work = new Set(['IN_PROCESS', 'PROCESSED', 'UC_SE8TXL', 'UC_G68KST', 'UC_5DM063']);
  const rejected = new Set(['JUNK', 'UC_SCX727']);
  return {
    total: leads.length,
    new: leads.filter(x => x.STATUS_ID === 'NEW').length,
    inProgress: leads.filter(x => work.has(x.STATUS_ID)).length,
    won: leads.filter(x => x.STATUS_ID === 'CONVERTED').length,
    rejected: leads.filter(x => rejected.has(x.STATUS_ID)).length,
    status: 'aktif'
  };
}

function decision(cost) {
  if (cost === null) return { label: 'Veri yetersiz', level: 'watch' };
  if (cost <= 25) return { label: 'Bütçeyi artır', level: 'good' };
  if (cost <= 55) return { label: 'Takip et', level: 'watch' };
  return { label: 'Durdur / değiştir', level: 'bad' };
}

function advice(campaigns, crm, metaStatus, crmStatus) {
  const measurable = campaigns.filter(x => x.costPerMessage !== null).sort((a, b) => a.costPerMessage - b.costPerMessage);
  const parts = [];
  if (measurable[0]) parts.push(`${measurable[0].campaign} en verimli kampanya.`);
  if (measurable.length > 1) parts.push(`${measurable.at(-1).campaign} yeniden değerlendirilmeli.`);
  parts.push(`Son 24 saatte ${crm.total} lead, ${crm.inProgress} işlemde ve ${crm.won} olumlu sonuç var.`);
  if (metaStatus !== 'aktif' || crmStatus !== 'aktif') parts.push(`Kurulum durumu: Meta ${metaStatus}; Bitrix24 ${crmStatus}.`);
  return parts.join(' ');
}

async function main() {
  let meta, crm;
  try { meta = await getMeta(); } catch (e) { meta = { campaigns: [], status: `hata: ${e.message}` }; }
  try { crm = await getBitrix(); } catch (e) { crm = { total: 0, new: 0, inProgress: 0, won: 0, rejected: 0, status: `hata: ${e.message}` }; }
  const campaigns = meta.campaigns;
  const totalSpend = campaigns.reduce((s, x) => s + x.spend, 0);
  const totalMessages = campaigns.reduce((s, x) => s + x.messages, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    period: 'Son 24 saat',
    setupComplete: meta.status === 'aktif' && crm.status === 'aktif',
    connections: { meta: meta.status, bitrix24: crm.status },
    meta: { adAccountId: META_AD_ACCOUNT_ID, totalSpend, totalMessages, costPerMessage: totalMessages ? totalSpend / totalMessages : null, campaigns: campaigns.map(x => ({ ...x, decision: decision(x.costPerMessage) })) },
    crm,
    advice: advice(campaigns, crm, meta.status, crm.status)
  };
  const output = path.join(process.cwd(), 'data', 'latest.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Rapor yazıldı: ${output}`);
}

main().catch(error => { console.error(error); process.exit(1); });

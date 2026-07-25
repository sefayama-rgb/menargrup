const fs = require('fs');
const path = require('path');

const META_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || '1521138858696042';
const BITRIX_WEBHOOK = (process.env.BITRIX_WEBHOOK || '').replace(/\/$/, '');

if (!META_TOKEN) throw new Error('META_ACCESS_TOKEN tanımlı değil.');
if (!BITRIX_WEBHOOK) throw new Error('BITRIX_WEBHOOK tanımlı değil.');

const trMoney = new Intl.NumberFormat('tr-TR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error?.message || data.error_description || `HTTP ${response.status}`);
  }
  return data;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function getMeta() {
  const until = new Date();
  const since = new Date();
  since.setDate(until.getDate() - 1);

  const fields = [
    'campaign_name',
    'spend',
    'actions',
    'date_start',
    'date_stop'
  ].join(',');

  const params = new URLSearchParams({
    access_token: META_TOKEN,
    fields,
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since: isoDate(since), until: isoDate(until) }),
    limit: '500'
  });

  const url = `https://graph.facebook.com/v23.0/act_${META_AD_ACCOUNT_ID}/insights?${params}`;
  const payload = await getJson(url);

  return (payload.data || []).map(row => {
    const actions = Object.fromEntries((row.actions || []).map(x => [x.action_type, Number(x.value || 0)]));
    const messages =
      actions.onsite_conversion_messaging_conversation_started_7d ||
      actions.messaging_conversation_started_7d ||
      actions.messaging_first_reply ||
      0;

    const spend = Number(row.spend || 0);
    return {
      campaign: row.campaign_name || 'İsimsiz kampanya',
      spend,
      messages,
      costPerMessage: messages ? spend / messages : null,
      dateStart: row.date_start,
      dateStop: row.date_stop
    };
  });
}

function buildBitrixQuery(params = {}, start = 0) {
  const q = new URLSearchParams();
  q.set('start', String(start));
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach(v => q.append(`${key}[]`, v));
    else if (value && typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value)) q.append(`${key}[${subKey}]`, subValue);
    } else q.set(key, value);
  }
  return q.toString();
}

async function getAllBitrix(method, params) {
  let start = 0;
  const rows = [];
  while (true) {
    const data = await getJson(`${BITRIX_WEBHOOK}/${method}.json?${buildBitrixQuery(params, start)}`);
    rows.push(...(data.result || []));
    if (data.next === undefined) break;
    start = data.next;
  }
  return rows;
}

async function getBitrix() {
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
    rejected: leads.filter(x => rejected.has(x.STATUS_ID)).length
  };
}

function decision(cost) {
  if (cost === null) return { label: 'Veri yetersiz', level: 'watch' };
  if (cost <= 25) return { label: 'Bütçeyi artır', level: 'good' };
  if (cost <= 55) return { label: 'Takip et', level: 'watch' };
  return { label: 'Durdur / değiştir', level: 'bad' };
}

function buildAdvice(campaigns, crm) {
  const measurable = campaigns.filter(x => x.costPerMessage !== null).sort((a, b) => a.costPerMessage - b.costPerMessage);
  const best = measurable[0];
  const worst = measurable.at(-1);
  const parts = [];

  if (best) parts.push(`${best.campaign} kampanyası ${trMoney.format(best.costPerMessage)} TL mesaj maliyetiyle en verimli kampanya.`);
  if (worst && worst !== best) parts.push(`${worst.campaign} kampanyası ${trMoney.format(worst.costPerMessage)} TL mesaj maliyetiyle yeniden düzenlenmeli veya durdurulmalı.`);
  parts.push(`Bitrix24'te son 24 saatte ${crm.total} yeni lead, ${crm.inProgress} işlemde lead ve ${crm.won} olumlu sonuç bulunuyor.`);
  parts.push('Bütçe kararını kesin kayıt kalitesi ve satış dönüşümüyle birlikte değerlendir.');
  return parts.join(' ');
}

async function main() {
  const [campaigns, crm] = await Promise.all([getMeta(), getBitrix()]);
  const totalSpend = campaigns.reduce((sum, x) => sum + x.spend, 0);
  const totalMessages = campaigns.reduce((sum, x) => sum + x.messages, 0);

  const report = {
    generatedAt: new Date().toISOString(),
    period: 'Son 24 saat',
    meta: {
      adAccountId: META_AD_ACCOUNT_ID,
      totalSpend,
      totalMessages,
      costPerMessage: totalMessages ? totalSpend / totalMessages : null,
      campaigns: campaigns.map(x => ({ ...x, decision: decision(x.costPerMessage) }))
    },
    crm,
    advice: buildAdvice(campaigns, crm)
  };

  const output = path.join(process.cwd(), 'data', 'latest.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Rapor yazıldı: ${output}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

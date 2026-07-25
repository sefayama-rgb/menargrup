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
const normalize = value => String(value || '').toLocaleLowerCase('tr-TR');

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
    const messageKeys = [
      'onsite_conversion.messaging_conversation_started_7d',
      'onsite_conversion_messaging_conversation_started_7d',
      'messaging_conversation_started_7d',
      'messaging_first_reply',
      'onsite_conversion.messaging_first_reply'
    ];
    const messages = messageKeys.reduce((max, key) => Math.max(max, actions[key] || 0), 0);
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
  return { campaigns, status: 'aktif' };
}

function buildBitrixQuery(params = {}, start = 0) {
  const q = new URLSearchParams();
  q.set('start', String(start));
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach(v => q.append(`${key}[]`, v));
    else if (value && typeof value === 'object') {
      for (const [sk, sv] of Object.entries(value)) q.append(`${key}[${sk}]`, sv);
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

async function getBitrixTotalByStatus(statusId) {
  const data = await getJson(`${BITRIX_WEBHOOK}/crm.lead.list.json?${buildBitrixQuery({
    SELECT: ['ID'],
    FILTER: { STATUS_ID: statusId }
  }, 0)}`);
  return Number(data.total || (data.result || []).length || 0);
}

function classifyStage(name, semantics) {
  const n = normalize(name);
  if (semantics === 'S' || n.includes('olumlu müşteri') || n.includes('başarılı')) return 'won';
  if (
    semantics === 'F' ||
    ['olumsuz', 'ulaşılamadı', 'ulaşılmadı', 'tarih uymadı', 'fiyat yüksek', 'otel uymadı', 'kararsız', 'rakip firma', 'bütçe yetersiz', 'diğer'].some(x => n.includes(x))
  ) return 'rejected';
  if (n.includes('yeni potansiyel') || n === 'yeni') return 'new';
  if (n.includes('sıcak müşteri')) return 'hot';
  if (n.includes('teklif bekleyen')) return 'offer';
  if (n.includes('bilgi veriliyor')) return 'info';
  if (n.includes('instagram')) return 'instagram';
  if (n.includes('yeni sezon')) return 'waiting';
  return 'inProgress';
}

async function getBitrix() {
  if (!BITRIX_WEBHOOK) {
    return { total: 0, new: 0, inProgress: 0, hot: 0, offer: 0, won: 0, rejected: 0, stages: [], status: 'BITRIX_WEBHOOK eksik' };
  }

  const statuses = await getAllBitrix('crm.status.list', {
    FILTER: { ENTITY_ID: 'STATUS' },
    ORDER: { SORT: 'ASC' }
  });

  const stageRows = [];
  for (const status of statuses) {
    const count = await getBitrixTotalByStatus(status.STATUS_ID);
    stageRows.push({
      id: status.STATUS_ID,
      name: status.NAME || status.STATUS_ID,
      sort: Number(status.SORT || 0),
      semantics: status.SEMANTICS || '',
      group: classifyStage(status.NAME, status.SEMANTICS),
      count
    });
  }

  const grouped = stageRows.reduce((acc, row) => {
    acc[row.group] = (acc[row.group] || 0) + row.count;
    return acc;
  }, {});

  const since = new Date();
  since.setDate(since.getDate() - 1);
  const recent = await getAllBitrix('crm.lead.list', {
    SELECT: ['ID', 'STATUS_ID', 'DATE_CREATE'],
    ORDER: { DATE_CREATE: 'DESC' },
    FILTER: { '>=DATE_CREATE': `${isoDate(since)}T00:00:00` }
  });

  return {
    total: stageRows.reduce((sum, row) => sum + row.count, 0),
    dailyTotal: recent.length,
    new: grouped.new || 0,
    info: grouped.info || 0,
    instagram: grouped.instagram || 0,
    hot: grouped.hot || 0,
    offer: grouped.offer || 0,
    waiting: grouped.waiting || 0,
    inProgress: (grouped.inProgress || 0) + (grouped.info || 0) + (grouped.instagram || 0) + (grouped.hot || 0) + (grouped.offer || 0) + (grouped.waiting || 0),
    won: grouped.won || 0,
    rejected: grouped.rejected || 0,
    stages: stageRows.sort((a, b) => a.sort - b.sort),
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
  parts.push(`Son 24 saatte ${crm.dailyTotal || 0} yeni lead oluştu. Şu anda ${crm.hot || 0} sıcak müşteri, ${crm.offer || 0} teklif bekleyen ve ${crm.won || 0} olumlu müşteri var.`);
  if (metaStatus !== 'aktif' || crmStatus !== 'aktif') parts.push(`Kurulum durumu: Meta ${metaStatus}; Bitrix24 ${crmStatus}.`);
  return parts.join(' ');
}

async function main() {
  let meta, crm;
  try { meta = await getMeta(); } catch (e) { meta = { campaigns: [], status: `hata: ${e.message}` }; }
  try { crm = await getBitrix(); } catch (e) {
    crm = { total: 0, dailyTotal: 0, new: 0, info: 0, instagram: 0, hot: 0, offer: 0, waiting: 0, inProgress: 0, won: 0, rejected: 0, stages: [], status: `hata: ${e.message}` };
  }
  const campaigns = meta.campaigns;
  const totalSpend = campaigns.reduce((s, x) => s + x.spend, 0);
  const totalMessages = campaigns.reduce((s, x) => s + x.messages, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    period: 'Son 24 saat reklam / güncel CRM',
    setupComplete: meta.status === 'aktif' && crm.status === 'aktif',
    connections: { meta: meta.status, bitrix24: crm.status },
    meta: {
      adAccountId: META_AD_ACCOUNT_ID,
      totalSpend,
      totalMessages,
      costPerMessage: totalMessages ? totalSpend / totalMessages : null,
      campaigns: campaigns.map(x => ({ ...x, decision: decision(x.costPerMessage) }))
    },
    crm,
    advice: advice(campaigns, crm, meta.status, crm.status)
  };
  const output = path.join(process.cwd(), 'data', 'latest.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Rapor yazıldı: ${output}`);
}

main().catch(error => { console.error(error); process.exit(1); });

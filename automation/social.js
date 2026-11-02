// Menar sosyal medya takibi: Facebook sayfası ve bağlı Instagram hesaplarının
// takipçi sayısı ve son paylaşım zamanı. Sonuç: data/social.json
// Mevcut META_ACCESS_TOKEN ile çalışır. Token sayfa iznine sahip değilse
// hata dosyaya yazılır, diğer raporlar etkilenmez.
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.META_ACCESS_TOKEN || '';
const API = 'https://graph.facebook.com/v23.0';
const OUT = path.join(__dirname, '..', 'data', 'social.json');

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const msg = (body.error && body.error.message) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

function q(params) {
  return new URLSearchParams(params).toString();
}

async function pageInfo(page) {
  const out = {
    platform: 'facebook',
    id: page.id,
    name: page.name,
    handle: page.username ? '@' + page.username : page.name,
    followers: page.followers_count ?? page.fan_count ?? null,
    lastPost: null,
    lastPostUrl: null,
    error: null,
  };
  try {
    const posts = await getJson(`${API}/${page.id}/published_posts?${q({ fields: 'created_time,permalink_url', limit: '1', access_token: page.access_token || TOKEN })}`);
    const p = (posts.data || [])[0];
    if (p) { out.lastPost = p.created_time; out.lastPostUrl = p.permalink_url || null; }
  } catch (e) {
    out.error = 'Son paylaşım okunamadı: ' + e.message;
  }
  return out;
}

async function igInfo(ig, token) {
  const out = {
    platform: 'instagram',
    id: ig.id,
    name: ig.name || ig.username,
    handle: '@' + ig.username,
    followers: ig.followers_count ?? null,
    mediaCount: ig.media_count ?? null,
    lastPost: null,
    lastPostUrl: null,
    error: null,
  };
  try {
    const media = await getJson(`${API}/${ig.id}/media?${q({ fields: 'timestamp,permalink', limit: '1', access_token: token })}`);
    const m = (media.data || [])[0];
    if (m) { out.lastPost = m.timestamp; out.lastPostUrl = m.permalink || null; }
  } catch (e) {
    out.error = 'Son paylaşım okunamadı: ' + e.message;
  }
  return out;
}

async function main() {
  const result = { generatedAt: new Date().toISOString(), accounts: [], error: null };
  if (!TOKEN) {
    result.error = 'META_ACCESS_TOKEN eksik';
  } else {
    try {
      const pages = await getJson(`${API}/me/accounts?${q({
        fields: 'id,name,username,fan_count,followers_count,access_token,instagram_business_account{id,username,name,followers_count,media_count}',
        limit: '50',
        access_token: TOKEN,
      })}`);
      for (const page of pages.data || []) {
        result.accounts.push(await pageInfo(page));
        const ig = page.instagram_business_account;
        if (ig && ig.username) result.accounts.push(await igInfo(ig, page.access_token || TOKEN));
      }
      if (!result.accounts.length) result.error = 'Token hiçbir Facebook sayfasına erişemiyor (pages_show_list / pages_read_engagement izni gerekli).';
    } catch (e) {
      result.error = 'Sayfa listesi alınamadı: ' + e.message;
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`social.json: ${result.accounts.length} hesap${result.error ? ' · hata: ' + result.error : ''}`);
}

main().catch((e) => {
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), accounts: [], error: String(e && e.message || e) }, null, 2));
  console.log('social.json yazıldı (hata ile): ' + e.message);
});

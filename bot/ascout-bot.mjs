// aSCOUT Telegram bot v1.0 - runs the REAL aSCOUT page (GitHub Pages) in headless Chromium.
// Every build you commit is picked up on the next full scan: zero porting, same logic as the phone.
// Cycle per 15m bar:  close-PRE_MIN -> full scan (shortlist)  |  close+DELAY_SEC -> CLEAN15 on the
// just-closed bar -> A/B alerts (+ Setups v2 GO/WATCH gate via suGate).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

// ---------- ENV ----------
const DIR = path.dirname(new URL(import.meta.url).pathname);
(function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})(path.join(DIR, '.env'));

const CFG = {
  token: process.env.BOT_TOKEN || '',
  chatId: process.env.CHAT_ID || '',
  pageUrl: process.env.PAGE_URL || 'https://criptoluny.github.io/alpha-scout-/',
  preMin: +(process.env.PRE_MIN || 7),            // full scan starts this many min before the close
  delaySec: +(process.env.DELAY_SEC || 15),       // CLEAN15 runs this many sec after the close
  cooldownMin: +(process.env.COOLDOWN_MIN || 60), // same coin+side silence
  scanTimeoutMin: +(process.env.SCAN_TIMEOUT_MIN || 12),
};
if (!CFG.token) { console.error('BOT_TOKEN missing in .env'); process.exit(1); }
const BAR = 15 * 60e3;

// ---------- STATE ----------
const STATE_FILE = path.join(DIR, 'state.json');
const state = Object.assign({ offset: 0, chatId: '', muteUntil: 0, strict: false, sent: {}, lastFull: null, lastClean: null, errNotified: false },
  (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } })());
if (CFG.chatId) state.chatId = CFG.chatId;
const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { console.error('state', e.message); } };

// ---------- UTILS ----------
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hhmm = (ts = Date.now()) => new Date(ts).toLocaleTimeString('mk-MK', { timeZone: 'Europe/Skopje', hour: '2-digit', minute: '2-digit' });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timeout')), ms))]);

// one page job at a time (scan, clean, commands never overlap inside the page)
let queue = Promise.resolve(), queueLen = 0;
function job(fn) {
  queueLen++;
  const p = queue.then(fn, fn).finally(() => queueLen--);
  queue = p.catch(() => {});
  return p;
}

// ---------- BROWSER ----------
let ctx = null, page = null, pageInfo = null;
async function ensureBrowser() {
  if (page && !page.isClosed()) return;
  try { await ctx?.close(); } catch {}
  ctx = await chromium.launchPersistentContext(path.join(DIR, 'profile'), {
    headless: true, locale: 'mk-MK', timezoneId: 'Europe/Skopje', viewport: { width: 430, height: 900 },
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
  page = ctx.pages()[0] || await ctx.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  page.on('pageerror', e => log('pageerror', e.message));
  page.on('crash', () => { log('page crash'); page = null; });
}
async function loadPage() {
  await ensureBrowser();
  await page.goto(CFG.pageUrl + (CFG.pageUrl.includes('?') ? '&' : '?') + 'bot=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => typeof doScan === 'function' && typeof evalClean15 === 'function' && typeof suGate === 'function', null, { timeout: 60000 });
  pageInfo = await page.evaluate(() => {
    startBuildClean = function () {};   // the bot drives CLEAN15 itself, on the closed bar
    S.tf = '15m'; S.filters.clear(); S.srch = ''; S.srchList = []; S.abort = false;
    return { ver: APP_VER, code: APP_CODENAME, build: APP_BUILD };
  });
}
async function inPage(fn, arg) {
  try { return await page.evaluate(fn, arg); }
  catch (e) { if (/closed|crash|Target|detached/i.test(e.message)) { page = null; await loadPage(); return page.evaluate(fn, arg); } throw e; }
}

// ---------- SCANS ----------
async function fullScan() {
  const t0 = Date.now();
  await loadPage();   // fresh page every bar = always your latest commit
  const r = await withTimeout(inPage(async () => { await doScan(); return { n: S.signals.length, uni: Object.keys(_tMap).length }; }), CFG.scanTimeoutMin * 60e3, 'full scan');
  if (!r.n) throw new Error('scan returned 0 signals (Binance API?)');
  state.lastFull = { ts: Date.now(), dur: Date.now() - t0, ...r, ...pageInfo }; save();
  log('full', state.lastFull);
  return r;
}

async function cleanCycle() {
  const t0 = Date.now();
  if (!state.lastFull || !page) await fullScan();
  const r = await withTimeout(inPage(async () => {
    S.abort = false;
    await buildClean();
  const f = x => x == null ? '—' : fmt(x);
  const rows = [];
  for (const r of Object.values(_clean)) {
    if (r.grade === 'WAIT') continue;
    const L = r.best === 'L', sd = L ? r.L : r.S, g = suGate(r, L ? 'bull' : 'bear');
    const sig = S.signals.find(s => s.coin === r.coin);
    rows.push({ coin: r.coin, grade: r.grade, side: r.best, mode: sd.mode, entry: f(sd.entry), et: sd.entryType, sl: f(sd.sl), slAtr: sd.slAtr,
      tp1: f(sd.tp1), rr: sd.rr, tp2: f(sd.tp2), lev: sd.maxLev, flags: sd.flags || [], go: g.status, why: g.why || [],
      trend: r.st?.trend || '', votes: r.st?.votes ?? '', loc: r.st?.loc || '', closeT: r.barT + 15 * 60e3,
      score: sig?.score ?? null, alpha: isAlpha(r.coin), fav: isFav(r.coin) });
  }
  return { rows, k: cleanCounts() };
  }), 5 * 60e3, 'CLEAN15');
  r.rows.sort((a, b) => (a.go === 'GO' ? 0 : 1) - (b.go === 'GO' ? 0 : 1) || a.grade.localeCompare(b.grade) || b.rr - a.rr);
  state.lastClean = { ts: Date.now(), dur: Date.now() - t0, ...r.k }; save();
  log('clean', state.lastClean);
  return r;
}

// ---------- FORMAT ----------
function card(x) {
  const L = x.side === 'L';
  const tags = [x.alpha ? '🅐' : '', x.fav ? '⭐' : ''].filter(Boolean).join('');
  let t = `✅${x.grade} ${L ? '▲ LONG' : '▼ SHORT'} · <b>${esc(x.coin)}.P</b> · ${x.go === 'GO' ? '🟢GO' : '👁WATCH'}\n` +
    `${esc(x.mode)} · E <b>${esc(x.entry)}</b> ${esc(x.et)}\n` +
    `SL ${esc(x.sl)} (${(+x.slAtr).toFixed(1)}ATR) · TP1 ${esc(x.tp1)} (${(+x.rr).toFixed(1)}R) · TP2 ${esc(x.tp2)} · ≤${x.lev}x\n` +
    `📐 ${esc(x.trend)} ${x.votes > 0 ? '+' : ''}${esc(x.votes)} · ${esc(x.loc)}${x.score != null ? ' · S' + x.score : ''} ${tags}`;
  if (x.flags.length) t += `\n🚩 ${esc(x.flags.join(' · '))}`;
  if (x.go !== 'GO' && x.why.length) t += `\n⛔ ${esc(x.why.join(' · '))}`;
  t += `\n<a href="https://www.binance.com/en/futures/${x.coin}USDT">Binance</a> · <a href="https://www.coinglass.com/tv/Binance_${x.coin}USDT">CoinGlass</a>`;
  return t;
}
const head = r => `<b>αSCOUT ${esc(state.lastFull?.ver || '')} ${esc(state.lastFull?.code || '')}</b> · 15m ${hhmm(r.rows[0]?.closeT || Date.now())} · A${r.k.A} B${r.k.B} / ${r.k.n}`;

function fresh(rows) {
  const now = Date.now(), out = [];
  for (const x of rows) {
    if (state.strict && x.go !== 'GO') continue;
    const k = x.coin + ':' + x.side, p = state.sent[k];
    const better = p && ((p.grade === 'B' && x.grade === 'A') || (p.go !== 'GO' && x.go === 'GO'));
    if (p && now - p.ts < CFG.cooldownMin * 60e3 && !better) continue;
    state.sent[k] = { ts: now, grade: x.grade, go: x.go }; out.push(x);
  }
  for (const k in state.sent) if (now - state.sent[k].ts > 24 * 3600e3) delete state.sent[k];
  return out;
}

// ---------- TELEGRAM ----------
const TG = `https://api.telegram.org/bot${CFG.token}`;
async function tg(method, body, ms = 15000) {
  try {
    const r = await fetch(`${TG}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    return await r.json();
  } catch { return null; }
}
function chunk(t, n = 3900) {
  const out = []; let cur = '';
  for (const b of t.split('\n\n')) { if (cur && (cur + '\n\n' + b).length > n) { out.push(cur); cur = b; } else cur = cur ? cur + '\n\n' + b : b; }
  if (cur) out.push(cur); return out;
}
async function send(text, chat = state.chatId) {
  if (!chat) return;
  for (const part of chunk(text)) await tg('sendMessage', { chat_id: chat, text: part, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}
async function sendDoc(name, text, caption) {
  const fd = new FormData();
  fd.append('chat_id', state.chatId); fd.append('caption', caption || '');
  fd.append('document', new Blob([text], { type: 'text/plain' }), name);
  try { await fetch(`${TG}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) }); } catch (e) { log('sendDoc', e.message); }
}

const HELP = [
  '<b>αSCOUT бот</b> · CLEAN15 A/B на затворена 15m свеќа',
  '/scan — цел скен + CLEAN15 сега',
  '/coin XYZ — CLEAN15 за еден коин',
  '/digest — DIGEST како .txt',
  '/fav XYZ — додај/тргни favorite · /favs — листа',
  '/strict — само 🟢GO (on/off)',
  '/mute 60 · /unmute',
  '/status',
].join('\n');

async function handle(text) {
  const [cmdRaw, argRaw] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().split('@')[0];
  const coinArg = String(argRaw || '').toUpperCase().replace(/\.P$/, '').replace(/USDT$/, '');
  const busy = () => queueLen ? send(`⏳ Во ред (${queueLen} задачи пред тебе)...`) : null;
  switch (cmd) {
    case '/start': case '/help': return send(HELP);
    case '/scan': {
      await busy(); await send('⏳ Цел скен + CLEAN15 (неколку минути)...');
      const r = await job(async () => { await fullScan(); return cleanCycle(); });
      return send(r.rows.length ? head(r) + '\n\n' + r.rows.map(card).join('\n\n') : head(r) + '\nНема A/B во моментов.');
    }
    case '/coin': {
      if (!coinArg) return send('Пример: /coin ARK');
      await busy();
      const r = await job(async () => {
        if (!page) await loadPage();
        return inPage(async (c) => {
          const r = await evalClean15Cached(c, true);
          if (!r) return null;
          const f = x => x == null ? '—' : fmt(x);
          const side = (sd, a) => sd.pass
            ? `${a} ${sd.flags.length ? 'B' : 'A'} ${sd.mode} · E ${f(sd.entry)} ${sd.entryType} · SL ${f(sd.sl)} · TP1 ${f(sd.tp1)} (${sd.rr.toFixed(1)}R) · ≤${sd.maxLev}x`
            : `${a} ${sd.gates.filter(g => g.ok).length}/${sd.gates.length} ✗ ` + sd.gates.filter(g => !g.ok).map(g => g.id + ' ' + g.note).join('; ');
          const g = r.grade === 'WAIT' ? null : suGate(r, r.best === 'L' ? 'bull' : 'bear');
          return { head: `${r.grade === 'WAIT' ? '⏳ WAIT' : '✅' + r.grade + (r.best === 'L' ? ' ▲' : ' ▼')}${g ? ' · ' + (g.status === 'GO' ? '🟢GO' : '👁WATCH') : ''}`,
            trnd: clnTrendTxt(r.st), loc: clnLocTxt(r.st), L: side(r.L, '▲'), S: side(r.S, '▼'), why: g?.why || [], ctx: clnFundTxt(c, r.fr) + ' | ' + clnTopTxt(r.top) + ' | ' + clnLegTxt(r.leg, r.price) };
        }, coinArg);
      });
      if (!r) return send(`❌ ${esc(coinArg)}USDT — нема 15m податоци / не постои / delist`);
      return send(`<b>${esc(coinArg)}.P</b> · ${r.head}\n📐 ${esc(r.trnd)}\n📍 ${esc(r.loc)}\n${esc(r.L)}\n${esc(r.S)}` +
        (r.why.length ? `\n⛔ ${esc(r.why.join(' · '))}` : '') + `\n<i>${esc(r.ctx)}</i>`);
    }
    case '/digest': {
      await busy();
      const txt = await job(async () => {
        if (!state.lastFull || !page) { await fullScan(); await cleanCycle(); }
        return inPage(async () => { buildDigest(); await refreshOi24ForDigest().catch(() => {}); if (typeof refreshRp4ForDigest === 'function') await refreshRp4ForDigest().catch(() => {}); return buildDigest(); });
      });
      return sendDoc(`ascout-digest-${hhmm().replace(':', '')}.txt`, txt, `αSCOUT DIGEST · ${hhmm()}`);
    }
    case '/fav': {
      if (!coinArg) return send('Пример: /fav ARK');
      const on = await job(async () => { if (!page) await loadPage(); return inPage(c => { S.favorites.has(c) ? S.favorites.delete(c) : S.favorites.add(c); saveFavs(); return S.favorites.has(c); }, coinArg); });
      return send(on ? `⭐ ${esc(coinArg)} додаден (секогаш во CLEAN15 shortlist)` : `${esc(coinArg)} тргнат од favorites`);
    }
    case '/favs': {
      const l = await job(async () => { if (!page) await loadPage(); return inPage(() => [...S.favorites].sort()); });
      return send(l.length ? '⭐ ' + esc(l.join(', ')) : 'Нема favorites');
    }
    case '/strict': state.strict = !state.strict; save(); return send(`Само 🟢GO: ${state.strict ? 'ON' : 'OFF'}`);
    case '/mute': { const m = parseInt(argRaw) || 60; state.muteUntil = Date.now() + m * 60e3; save(); return send(`🔕 Тишина до ${hhmm(state.muteUntil)}`); }
    case '/unmute': state.muteUntil = 0; save(); return send('🔔 Алармите се вклучени');
    case '/status': {
      const f = state.lastFull, c = state.lastClean;
      return send([
        f ? `Build ${esc(f.ver)} ${esc(f.code)} · ${esc(f.build)}` : 'Build: уште не е вчитан',
        f ? `Цел скен ${hhmm(f.ts)} · ${f.uni} коини · ${f.n} сигнали · ${(f.dur / 1000).toFixed(0)}s` : 'Цел скен: —',
        c ? `CLEAN15 ${hhmm(c.ts)} · A${c.A} B${c.B} WAIT${c.W} · ${(c.dur / 1000).toFixed(0)}s` : 'CLEAN15: —',
        `Strict ${state.strict ? 'ON' : 'OFF'} · ${state.muteUntil > Date.now() ? '🔕 до ' + hhmm(state.muteUntil) : '🔔 активен'} · ред ${queueLen}`,
      ].join('\n'));
    }
  }
}

async function pollLoop() {
  for (;;) {
    const r = await tg('getUpdates', { offset: state.offset, timeout: 30, allowed_updates: ['message'] }, 40000);
    if (!r?.ok) { await sleep(3000); continue; }
    for (const u of r.result) {
      state.offset = u.update_id + 1;
      const m = u.message; if (!m?.text) continue;
      const chat = String(m.chat.id);
      if (!state.chatId) {
        if (m.text.startsWith('/start')) { state.chatId = chat; save(); await send(`✅ Поврзано. CHAT_ID=${chat}\nВнеси го во .env за заклучување.\n\n` + HELP, chat); }
        continue;
      }
      if (chat !== state.chatId) continue;   // ignore strangers
      handle(m.text.trim()).catch(e => send('⚠️ ' + esc(e.message)));
    }
    save();
  }
}

// ---------- SCHEDULER ----------
function nextEvent() {
  const now = Date.now(), base = Math.floor(now / BAR) * BAR, ev = [];
  for (const k of [0, 1, 2]) {
    const close = base + k * BAR;
    ev.push({ t: close + CFG.delaySec * 1000, type: 'clean' });
    ev.push({ t: close - CFG.preMin * 60e3, type: 'full' });
  }
  return ev.filter(e => e.t > now).sort((a, b) => a.t - b.t)[0];
}
async function onError(e) {
  log('ERR', e.message);
  if (!state.errNotified) { state.errNotified = true; save(); await send('⚠️ αSCOUT грешка: ' + esc(e.message)); }
}
async function schedLoop() {
  for (;;) {
    const ev = nextEvent();
    await sleep(ev.t - Date.now());
    if (!state.chatId) continue;
    try {
      if (ev.type === 'full') { await job(fullScan); }
      else {
        const r = await job(cleanCycle);
        state.errNotified = false;
        const out = fresh(r.rows); save();
        if (out.length && Date.now() >= state.muteUntil) await send(head(r) + '\n\n' + out.map(card).join('\n\n'));
      }
    } catch (e) { await onError(e); page = null; }
  }
}

// ---------- MAIN ----------
log('aSCOUT bot starting, chat', state.chatId || '(waiting /start)');
pollLoop();
job(fullScan).then(() => send(`🟢 αSCOUT бот стартуван · ${esc(state.lastFull.ver)} ${esc(state.lastFull.code)} · ${esc(state.lastFull.build)}`)).catch(onError);
schedLoop();

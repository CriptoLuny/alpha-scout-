// aSCOUT Telegram bot v1.6 (🔥⚡🧯 ALARM + /igstats with R trade sims, /why, /near, /nearstats, quiet hours) - runs the REAL aSCOUT page (GitHub Pages) in headless Chromium.
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
  trackBars: +(process.env.TRACK_BARS || 16),
  alarmReloadH: +(process.env.ALARM_RELOAD_H || 6),  // the ALARM tab keeps its 90-min ticker memory; reload only this often or on a new build     // forward window for 9/10 + A/B tracking (16 x 15m = 4h)
  quiet: process.env.QUIET ?? 'off',               // e.g. 01:00-08:30 (Europe/Skopje) = no alerts in that window
};
if (!CFG.token) { console.error('BOT_TOKEN missing in .env'); process.exit(1); }
const BAR = 15 * 60e3;

// ---------- STATE ----------
const STATE_FILE = path.join(DIR, 'state.json');
const state = Object.assign({ offset: 0, chatId: '', muteUntil: 0, strict: false, near: false, alarm: true, alarmBoth: false, igSent: {}, igLog: {}, igTrack: [], sent: {}, nearSent: {}, diag: [], track: [], trackSeen: {}, lastFull: null, lastClean: null, errNotified: false },
  (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } })());
if (CFG.chatId) state.chatId = CFG.chatId;
if (state.quiet === undefined) state.quiet = /^off$/i.test(CFG.quiet) ? null : CFG.quiet;
const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { console.error('state', e.message); } };

// ---------- UTILS ----------
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hhmm = (ts = Date.now()) => new Date(ts).toLocaleTimeString('mk-MK', { timeZone: 'Europe/Skopje', hour: '2-digit', minute: '2-digit' });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// quiet hours, local Europe/Skopje time, window may cross midnight
function skMin(ts = Date.now()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Skopje', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ts);
  return +p.find(x => x.type === 'hour').value * 60 + +p.find(x => x.type === 'minute').value;
}
function parseQuiet(q) {
  const m = /^(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})$/.exec(String(q || '').trim());
  if (!m) return null;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return (a < 1440 && b < 1440 && a !== b) ? { a, b } : null;
}
function inQuiet(ts = Date.now()) {
  const w = parseQuiet(state.quiet); if (!w) return false;
  const t = skMin(ts);
  return w.a < w.b ? (t >= w.a && t < w.b) : (t >= w.a || t < w.b);
}
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
let ctx = null, page = null, apage = null, pageInfo = null, ctxAlive = false;
function hookPage(p, tag) {
  p.on('dialog', d => d.dismiss().catch(() => {}));
  p.on('pageerror', e => log(tag + ' pageerror', e.message));
  p.on('crash', () => { log(tag + ' crash'); if (p === page) page = null; if (p === apage) apage = null; });
}
async function ensureBrowser() {
  if (!ctx || !ctxAlive) {
    try { await ctx?.close(); } catch {}
    ctx = await chromium.launchPersistentContext(path.join(DIR, 'profile'), {
      headless: true, locale: 'mk-MK', timezoneId: 'Europe/Skopje', viewport: { width: 430, height: 900 },
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    ctxAlive = true; page = null; apage = null;
    ctx.on('close', () => { ctxAlive = false; page = null; apage = null; });
    const first = ctx.pages()[0];
    if (first) { page = first; hookPage(page, 'main'); }
  }
  if (!page || page.isClosed()) { page = await ctx.newPage(); hookPage(page, 'main'); }
}
async function loadPage() {
  await ensureBrowser();
  await page.goto(CFG.pageUrl + (CFG.pageUrl.includes('?') ? '&' : '?') + 'bot=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => typeof doScan === 'function' && typeof evalClean15 === 'function' && typeof suGate === 'function', null, { timeout: 60000 });
  pageInfo = await page.evaluate(() => {
    startBuildClean = function () {};   // the bot drives CLEAN15 itself, on the closed bar
    S.tf = '15m'; S.filters.clear(); S.srch = ''; S.srchList = []; S.abort = false;
    if (typeof IGA === 'object') IGA.on = false;   // ALARM runs only in its own tab (not reloaded every bar)
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
  try { const mk = await page.evaluate(() => typeof _ignMkt === 'object' ? _ignMkt : null); if (mk && apage && !apage.isClosed()) await apage.evaluate(m => { _ignMkt = m; }, mk); } catch {}
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
  // gate diagnostics for every evaluated coin and side (WAIT included)
  const diag = [];
  for (const r of Object.values(_clean)) {
    for (const sd of [r.L, r.S]) {
      if (!sd || !sd.gates) continue;
      diag.push({ coin: r.coin, side: sd.dir === 'long' ? 'L' : 'S', mode: sd.mode || null, closeT: r.barT + 15 * 60e3,
        entry: sd.entry ?? null, et: sd.entryType || null, sl: sd.sl ?? null, tp1: sd.tp1 ?? null, tp2: sd.tp2 ?? null,
        rr: sd.rr ?? null, nflags: (sd.flags || []).length, flags: (sd.flags || []).map(f => String(f).slice(0, 60)),
        ok: sd.gates.map(g => g.ok ? 1 : 0),
        na: sd.gates.filter(g => /n\/a/.test(g.note || '')).map(g => g.id),
        fails: sd.gates.filter(g => !g.ok).map(g => ({ id: g.id, note: String(g.note || '').slice(0, 70) })) });
    }
  }
  return { rows, k: cleanCounts(), diag };
  }), 5 * 60e3, 'CLEAN15');
  r.rows.sort((a, b) => (a.go === 'GO' ? 0 : 1) - (b.go === 'GO' ? 0 : 1) || a.grade.localeCompare(b.grade) || b.rr - a.rr);
  state.lastClean = { ts: Date.now(), dur: Date.now() - t0, ...r.k };
  recordDiag(r);
  save();
  log('clean', state.lastClean);
  return r;
}

// ---------- DIAGNOSTICS ----------
const GNAME = ['Тренд 1h', 'Локација', 'Тригер', 'OI◆', 'CVD/Taker', 'Моментум', 'Компресија', 'Crowding', 'Ризик', 'Замка'];
function recordDiag(r) {
  const closeT = r.rows[0]?.closeT || Math.floor(Date.now() / BAR) * BAR;
  const fail = Array(10).fill(0), single = Array(10).fill(0), na = Array(10).fill(0), pc = Array(11).fill(0);
  const near = [];
  for (const d of r.diag || []) {
    const pass = d.ok.reduce((a, b) => a + b, 0);
    pc[pass]++;
    d.ok.forEach((v, j) => { if (!v) fail[j]++; });
    d.na.forEach(id => { const j = +id.slice(1) - 1; if (j >= 0 && j < 10) na[j]++; });
    if (pass === 9) single[d.ok.indexOf(0)]++;
    if (pass >= 8) near.push({ coin: d.coin, side: d.side, mode: d.mode, pass, fails: d.fails });
  }
  near.sort((a, b) => b.pass - a.pass);
  // forward tracking: every 9/10 and every A/B side with a complete geometry
  const now = Date.now();
  for (const d of r.diag || []) {
    const pass = d.ok.reduce((a, b) => a + b, 0);
    if (pass < 9 || d.entry == null || d.sl == null || d.tp1 == null) continue;
    const L = d.side === 'L';
    if (L ? !(d.sl < d.entry && d.tp1 > d.entry) : !(d.sl > d.entry && d.tp1 < d.entry)) continue;
    const k = d.coin + ':' + d.side, p = state.trackSeen[k];
    if (p && now - p < CFG.cooldownMin * 60e3) continue;
    state.trackSeen[k] = now;
    const softFlush = (d.flags || []).some(f => /мал flush/i.test(f));
    const gate = pass === 10 ? (d.nflags ? (softFlush ? 'B·мал flush' : 'B') : 'A') : d.fails[0].id;
    state.track.push({ coin: d.coin, side: d.side, mode: d.mode || '—', gate, note: pass === 10 ? '' : d.fails[0].note,
      t0: d.closeT, entry: d.entry, et: d.et, sl: d.sl, tp1: d.tp1, tp2: d.tp2, rr: d.rr, res: null });
  }
  for (const k in state.trackSeen) if (now - state.trackSeen[k] > 24 * 3600e3) delete state.trackSeen[k];
  state.track = state.track.filter(x => now - x.t0 < 7 * 24 * 3600e3);
  state.diag.push({ t: closeT, n: (r.diag || []).length, A: r.k.A, B: r.k.B, fail, single, na, pc, near: near.slice(0, 12) });
  const cut = Date.now() - 72 * 3600e3;
  state.diag = state.diag.filter(x => x.t >= cut);
  r.near9 = near.filter(x => x.pass === 9);
}
function whyReport(hours) {
  const cut = Date.now() - hours * 3600e3, D = state.diag.filter(x => x.t >= cut);
  if (!D.length) return 'Уште нема податоци. Дијагнозата собира од ажурирањето наваму (секоја 15m свеќа).';
  const fail = Array(10).fill(0), single = Array(10).fill(0), na = Array(10).fill(0), pc = Array(11).fill(0);
  let n = 0, A = 0, B = 0; const near = [];
  for (const x of D) {
    n += x.n; A += x.A; B += x.B;
    x.fail.forEach((v, j) => fail[j] += v); x.single.forEach((v, j) => single[j] += v);
    x.na.forEach((v, j) => na[j] += v); (x.pc || []).forEach((v, j) => pc[j] += v);
    x.near.forEach(z => near.push({ ...z, t: x.t }));
  }
  const pct = v => n ? Math.round(v / n * 100) : 0;
  const order = [...Array(10).keys()].sort((a, b) => fail[b] - fail[a]);
  let t = `<b>🔎 CLEAN15 дијагноза · ${hours}h</b>\n${D.length} свеќи · ${n} проверки (коин×страна) · A${A} B${B}\n\n`;
  t += '<b>Колку често паѓа секој гејт</b>\n' + order.map(j => `G${j + 1} ${GNAME[j]} ${pct(fail[j])}%`).join('\n');
  t += '\n\n<b>Колку гејтови поминуваат</b>\n' + [10, 9, 8, 7, 6].map(k => `${k}/10: ${pc[k]}`).join(' · ') + ` · ≤5: ${pc.slice(0, 6).reduce((a, b) => a + b, 0)}`;
  const sg = order.filter(j => single[j]).map(j => `G${j + 1}×${single[j]}`);
  t += '\n\n<b>9/10 — единствен блокер</b>\n' + (sg.length ? sg.join(' · ') : 'нема');
  const nas = [...Array(10).keys()].filter(j => na[j]).map(j => `G${j + 1} ${pct(na[j])}%`);
  t += '\n\n<b>Податоци n/a</b> ' + (nas.length ? '⚠️ ' + nas.join(' · ') : '✅ нема');
  const top = near.filter(z => z.pass === 9).sort((a, b) => b.t - a.t).slice(0, 8);
  if (top.length) t += '\n\n<b>Најблиску (9/10)</b>\n' + top.map(z =>
    `${hhmm(z.t)} ${esc(z.coin)} ${z.side === 'L' ? '▲' : '▼'} ✗${esc(z.fails[0].id)} ${esc(z.fails[0].note)}`).join('\n');
  return t;
}
function nearCard(z) {
  return `👀 9/10 · ${esc(z.coin)}.P ${z.side === 'L' ? '▲ LONG' : '▼ SHORT'}${z.mode ? ' · ' + esc(z.mode) : ''}\n✗ ${esc(z.fails[0].id)} ${esc(z.fails[0].note)}`;
}

// ---------- FORWARD TRACKING ----------
async function bklines(sym, start, limit) {
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&startTime=${start}&limit=${limit}`, { signal: AbortSignal.timeout(10000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
// first touch inside the window; a bar that touches both SL and TP counts as SL (conservative)
function judge(x, kl) {
  const L = x.side === 'L', risk = Math.abs(x.entry - x.sl);
  let filled = x.et !== 'LIMIT', res = 'NONE', tp2 = false, mfe = 0, mae = 0, last = null;
  for (const k of kl) {
    const hi = +k[2], lo = +k[3], cl = +k[4];
    if (!filled) { if (L ? lo <= x.entry : hi >= x.entry) filled = true; else continue; }
    mfe = Math.max(mfe, (L ? hi - x.entry : x.entry - lo) / risk);
    mae = Math.max(mae, (L ? x.entry - lo : hi - x.entry) / risk);
    last = cl;
    const hitSL = L ? lo <= x.sl : hi >= x.sl, hitTP1 = L ? hi >= x.tp1 : lo <= x.tp1;
    const hitTP2 = x.tp2 != null && (L ? hi >= x.tp2 : lo <= x.tp2);
    if (res === 'NONE') { if (hitSL) { res = 'SL'; break; } if (hitTP1) { res = 'TP1'; if (hitTP2) { tp2 = true; break; } continue; } }
    if (res === 'TP1') { if (hitTP2) { tp2 = true; break; } if (L ? lo <= x.entry : hi >= x.entry) break; }   // back to BE after TP1
  }
  if (!filled) return { res: 'NOFILL', tp2: false, mfe: 0, mae: 0, R: 0 };
  const endR = last == null ? 0 : (L ? last - x.entry : x.entry - last) / risk;
  const R = res === 'SL' ? -1 : res === 'TP1' ? (tp2 ? (Math.abs(x.tp2 - x.entry) / risk) : (x.rr || 1)) : endR;
  return { res, tp2, mfe: +mfe.toFixed(2), mae: +mae.toFixed(2), R: +R.toFixed(2) };
}
let tracking = false;
async function resolveTracks() {
  if (tracking) return; tracking = true;
  try {
    const due = state.track.filter(x => !x.res && Date.now() >= x.t0 + CFG.trackBars * BAR + 60e3).slice(0, 40);
    for (const x of due) {
      const kl = await bklines(x.coin + 'USDT', x.t0, CFG.trackBars);
      if (!kl) continue;
      if (!kl.length) { x.res = { res: 'NODATA', R: 0 }; continue; }
      x.res = judge(x, kl);
      await sleep(150);
    }
    if (due.length) save();
  } finally { tracking = false; }
}
function nearStats(hours) {
  const cut = Date.now() - hours * 3600e3;
  const T = state.track.filter(x => x.t0 >= cut && x.res && x.res.res !== 'NODATA');
  const open = state.track.filter(x => x.t0 >= cut && !x.res).length;
  if (!T.length) return `Уште нема завршени случаи (${open} се следат). Секој 9/10 и A/B се проценува ${CFG.trackBars * 15 / 60}h по свеќата.`;
  const g = {};
  for (const x of T) {
    const key = /^(A|B)/.test(x.gate) ? '✅' + x.gate + '·' + x.mode : x.gate + '·' + x.mode;
    (g[key] ||= []).push(x);
  }
  const keys = Object.keys(g).sort((a, b) => g[b].length - g[a].length);
  let t = `<b>📊 Следење 9/10 и A/B · ${hours}h</b>\n${T.length} завршени · ${open} отворени · прозорец ${CFG.trackBars * 15 / 60}h · SL и TP во иста свеќа = SL\n`;
  for (const k of keys) {
    const a = g[k], sl = a.filter(x => x.res.res === 'SL').length, tp = a.filter(x => x.res.res === 'TP1').length;
    const tp2 = a.filter(x => x.res.tp2).length, none = a.filter(x => x.res.res === 'NONE').length, nf = a.filter(x => x.res.res === 'NOFILL').length;
    const filled = a.filter(x => x.res.res !== 'NOFILL'), exp = filled.length ? filled.reduce((s, x) => s + x.res.R, 0) / filled.length : 0;
    const dec = sl + tp;
    let v = 'премалку примери';
    if (dec >= 8) v = k.startsWith('✅') ? (exp > 0 ? 'сетапот носи ✅' : 'сетапот губи ❌')
      : exp > 0.2 ? 'гејтот ЧИНИ ❌ (блокира добитници)' : exp < -0.2 ? 'гејтот ШТИТИ ✅' : 'неутрално ➖';
    t += `\n<b>${esc(k)}</b> · ${a.length}\nSL прв ${sl} · TP1 прв ${tp}${tp2 ? ' (TP2 ' + tp2 + ')' : ''} · ништо ${none}${nf ? ' · непополнет ' + nf : ''}\nПросек ${exp >= 0 ? '+' : ''}${exp.toFixed(2)}R → ${v}\n`;
  }
  const last = [...T].sort((a, b) => b.t0 - a.t0).slice(0, 8);
  t += '\n<b>Последни</b>\n' + last.map(x => `${hhmm(x.t0)} ${esc(x.coin)} ${x.side === 'L' ? '▲' : '▼'} ${esc(x.gate)}·${esc(x.mode)} → ${x.res.res}${x.res.tp2 ? '+TP2' : ''} ${x.res.R >= 0 ? '+' : ''}${x.res.R}R`).join('\n');
  return t;
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

// ---------- 🔥 ALARM (the page's own IGNITION ALARM, in a second tab) ----------
let aInfo = null, aLoadedAt = 0, aBusy = false, aLastSweep = 0;
async function loadAlarmPage() {
  await ensureBrowser();
  if (!apage || apage.isClosed()) { apage = await ctx.newPage(); hookPage(apage, 'alarm'); }
  await apage.goto(CFG.pageUrl + (CFG.pageUrl.includes('?') ? '&' : '?') + 'alarm=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await apage.waitForFunction(() => typeof igSweep === 'function' && typeof IGA === 'object' && typeof igShow === 'function', null, { timeout: 60000 });
  aInfo = await apage.evaluate((both) => {
    IGA.on = true; IGA.both = both; IGA.mute = true; IGA.notif = false;
    window.__igQ = [];
    const orig = igShow;
    igShow = function (list, isStatus) {   // igSweep calls igShow(ev,false) for every new 🔥 / ⚡ event
      try {
        if (!isStatus) (list || []).forEach(r => {
          const g = r.g || {}, ch = (typeof chaseInfo === 'function') ? chaseInfo(r.chg24) : null;
          window.__igQ.push({ kind: g.phase === 'EARLY' ? 'EARLY' : g.phase === 'RUN' ? 'RUN' : 'IGNITE', coin: r.coin, d5: r.d5, d15: r.d15, chg24: r.chg24, t: r.t,
            px: fmt(r.px), lo: fmt(g.baseLo), hi: fmt(g.baseHi), pxN: r.px, loN: g.baseLo, hiN: g.baseHi,
            phase: g.phase, score: g.score, dir: g.dir, volX: g.volX, barX: g.barX, lastX: g.lastX, brk: g.brk, mv: g.mv, oi: g.oi, taker: g.taker,
            obv: !!g.obvOk, ad: !!g.adOk, chase: ch ? ch.tag : '' });
        });
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    if (typeof gaShow === 'function') {   // 🧯 ГАСИ (scanner 2026-11-09-a+)
      const og = gaShow;
      gaShow = function (list) {
        try {
          (list || []).forEach(r => {
            const g = r.g || {};
            window.__igQ.push({ kind: 'GASI', coin: r.coin, t: r.t, chg24: r.chg24, px: fmt(r.px), pxN: r.px, score: g.score,
              peak: fmt(g.peak), peakN: g.peak, legLowN: g.legLow, leg: g.leg, dd: g.dd, ddAtr: g.ddAtr, retr: g.retr, sp: g.sp, taker: g.taker,
              obvDiv: !!g.obvDiv, adDiv: !!g.adDiv, oiChg: g.oiChg, trapped: !!g.trapped, unwind: !!g.unwind, mom: !!g.mom, wick: g.wick,
              f236: fmt(g.f236), f382: fmt(g.f382), f5: fmt(g.f5), f382N: g.f382, f5N: g.f5 });
          });
        } catch (e) {}
        return og.apply(this, arguments);
      };
    }
    _igLast = 0;
    return { build: APP_BUILD, gasi: typeof gaShow === 'function' };
  }, !!state.alarmBoth);
  aLoadedAt = Date.now(); aLastSweep = 0;
  log('alarm tab loaded', aInfo);
}
const pc = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
const binLinks = c => `<a href="https://www.binance.com/en/futures/${c}USDT">Binance</a> · <a href="https://www.coinglass.com/tv/Binance_${c}USDT">CoinGlass</a>`;
function leadTxt(e) {
  const L = state.igLog[e.coin]?.first;
  if (!L || !(L.px > 0) || !(e.pxN > 0)) return '';
  const mins = Math.round((e.t - L.t) / 60000);
  return mins >= 3 ? `\n👀 прв кандидат ${hhmm(L.t)} (${L.ph || '—'}) · ${mins} мин · цена од тогаш ${pc(e.pxN / L.px - 1)}` : '';
}
function igMsg(e) {
  if (e.kind === 'GASI') {
    const yn = b => b ? '✔' : '✗';
    return `🧯 <b>ГАСИ · ${esc(e.coin)}.P · ${e.score}</b>\n` +
      `PX ${esc(e.px)} · врв ${esc(e.peak)} (${pc(-e.dd)}, −${(+e.ddAtr).toFixed(1)} ATR) · 24h ${(+e.chg24 >= 0 ? '+' : '') + (+e.chg24).toFixed(1)}%\n` +
      `потег ${pc(e.leg)} · ${e.sp} свеќи без нов врв · retrace ${(e.retr * 100).toFixed(0)}% · taker ${(e.taker * 100).toFixed(0)}%B\n` +
      `OBV↓ ${yn(e.obvDiv)} A/D↓ ${yn(e.adDiv)} · OI од врвот ${e.oiChg == null ? 'n/a' : (e.oiChg >= 0 ? '+' : '') + (+e.oiChg).toFixed(1) + '%'}${e.trapped ? ' (заробени лонгови)' : e.unwind ? ' (squeeze се одмотува)' : ''} · мом ${yn(e.mom)} · фитил ${yn(e.wick >= 0.5)}\n` +
      `➡ Крај на тренд: без нов лонг / заштити профит. Шорт само по план: ретест .236 ${esc(e.f236)}, SL над ${esc(e.peak)}, цели .382 ${esc(e.f382)} / .5 ${esc(e.f5)}\n` + binLinks(e.coin);
  }
  const up = e.dir > 0, run = e.kind === 'RUN', early = e.kind === 'EARLY';
  const plan = early ? '➡ Најрана фаза (една силна свеќа), уште не е потврдено. Следи: план = повлекување / CLEAN15'
    : run ? '⚠ Веќе трча (≥25% за 1.5h): CHASE ризик, само план за повлекување'
    : up ? '➡ Не е влез: план = повлекување .5/.618 + CLEAN15' : '➡ Паѓа со волумен: провери дали е дамп/ликвидации, шорт само по план';
  const head = early ? `⚡ <b>РАНО ПАЛЕЊЕ · ${esc(e.coin)}.P ${up ? '▲' : '▼'} EARLY ${e.score}</b>` : `🔥 <b>${run ? 'RUN' : 'ПАЛЕЊЕ'} · ${esc(e.coin)}.P ${up ? '▲' : '▼'} ${esc(e.phase)} ${e.score}</b>`;
  return head + '\n' +
    `PX ${esc(e.px)} · 5m ${pc(e.d5)} · 15m ${pc(e.d15)} · 24h ${(+e.chg24 >= 0 ? '+' : '') + (+e.chg24).toFixed(1)}%\n` +
    `vol ×${(+e.volX).toFixed(1)} (bar ×${(+e.barX).toFixed(0)}${early && e.lastX != null ? ', последна ×' + (+e.lastX).toFixed(0) : ''}) · пробив ${pc(e.brk)} · OI◆ ${e.oi == null ? 'n/a' : (e.oi >= 0 ? '+' : '') + (+e.oi).toFixed(1) + '%'} · taker ${(e.taker * 100).toFixed(0)}%B · OBV ${e.obv ? '✔' : '✗'} A/D ${e.ad ? '✔' : '✗'}\n` +
    `база ${esc(e.lo)}–${esc(e.hi)}${e.chase ? ' · ⚠' + esc(e.chase) : ''}${leadTxt(e)}\n${plan}\n` + binLinks(e.coin);
}
// candidate log: first time each coin shows up in the ALARM sweep (any phase) -> how early could we have known
function logCands(cands, t) {
  for (const r of cands) {
    const L = state.igLog[r.c];
    if (!L || t - L.last > 6 * 3600e3) state.igLog[r.c] = { first: { t, px: r.px, ph: r.ph || '', sc: r.sc }, ph: {}, last: t };
    const M = state.igLog[r.c]; M.last = t;
    if (r.ph && !M.ph[r.ph]) M.ph[r.ph] = { t, px: r.px, sc: r.sc };
  }
  for (const k in state.igLog) if (t - state.igLog[k].last > 24 * 3600e3) delete state.igLog[k];
}
function trackAlarm(e) {
  const L = state.igLog[e.coin];
  state.igTrack.push({ kind: e.kind, coin: e.coin, t: e.t || Date.now(), px: e.pxN, score: e.score, lo: e.loN ?? null,
    peak: e.peakN ?? null, legLow: e.legLowN ?? null, f382: e.f382N ?? null, f5: e.f5N ?? null,
    first: L?.first ? { t: L.first.t, px: L.first.px, ph: L.first.ph } : null, res: null });
  state.igTrack = state.igTrack.filter(x => Date.now() - x.t < 10 * 24 * 3600e3);
}
async function alarmPoll() {
  if (aBusy) return; aBusy = true;
  try {
    if (!state.alarm || !state.chatId) {
      if (apage && !apage.isClosed()) await apage.evaluate(() => { IGA.on = false; }).catch(() => {});
      return;
    }
    const stale = Date.now() - aLoadedAt > CFG.alarmReloadH * 3600e3;
    const newBuild = state.lastFull?.build && aInfo?.build && aInfo.build !== state.lastFull.build;
    if (!apage || apage.isClosed() || stale || newBuild) { await loadAlarmPage(); return; }
    const snap = await apage.evaluate((since) => {
      IGA.on = true;
      const out = { ev: (window.__igQ || []).splice(0), last: _igLast, cands: null };
      if (_igLast && _igLast !== since) out.cands = (_igRes || []).map(r => ({ c: r.coin, ph: r.g && r.g.phase, sc: r.g && r.g.score, px: r.px }));
      return out;
    }, aLastSweep);
    if (snap.cands) { aLastSweep = snap.last; logCands(snap.cands, snap.last); }
    const ev = snap.ev;
    if (!ev.length) { if (snap.cands) save(); return; }
    const now = Date.now(), key = e => e.coin + '#' + (e.kind === 'EARLY' ? 'E' : e.kind === 'GASI' ? 'G' : 'I');
    const out = ev.filter(e => !(state.igSent[key(e)] && now - state.igSent[key(e)] < 4 * 3600e3));
    out.forEach(e => { state.igSent[key(e)] = now; trackAlarm(e); });
    for (const k in state.igSent) if (now - state.igSent[k] > 24 * 3600e3) delete state.igSent[k];
    save();
    if (!out.length || inQuiet() || now < state.muteUntil) return;
    await send(out.slice(0, 5).map(igMsg).join('\n\n'));
  } catch (e) {
    log('alarm', e.message);
    if (/closed|crash|Target|detached/i.test(e.message)) apage = null;
  } finally { aBusy = false; }
}
async function alarmStatus() {
  if (!state.alarm) return '🔥 ALARM: OFF';
  if (!apage || apage.isClosed()) return '🔥 ALARM: ON · се вчитува';
  try {
    const a = await apage.evaluate(() => ({ last: _igLast, cand: _igCand, warm: _igSnaps.length ? Date.now() - _igSnaps[0].t < 15 * 60000 : true, ga: typeof _gaRes !== 'undefined' ? _gaRes.length : null }));
    return `🔥 ALARM: ON${state.alarmBoth ? ' ▲▼' : ' ▲'} · проверка ${a.last ? hhmm(a.last) : '—'} · кандидати ${a.cand}${a.ga != null ? ' · 🧯 следи ' + a.ga : ''}${a.warm ? ' · ⏳ загревање' : ''}`;
  } catch { return '🔥 ALARM: ON · ?'; }
}
// ---------- /igstats: what happened after each 🔥 ⚡ 🧯 (15m bars from Binance, 1h and 4h) ----------
function igJudge(x, kl) {
  const at = h => kl.slice(0, h * 4);
  const mx = (a, f) => a.length ? Math.max(...a.map(f)) : null, mn = (a, f) => a.length ? Math.min(...a.map(f)) : null;
  const k1 = at(1), k4 = at(4), up1 = mx(k1, k => +k[2]), up4 = mx(k4, k => +k[2]), dn1 = mn(k1, k => +k[3]), dn4 = mn(k4, k => +k[3]);
  const r = { up1: up1 / x.px - 1, up4: up4 / x.px - 1, dn1: dn1 / x.px - 1, dn4: dn4 / x.px - 1, end4: +k4[k4.length - 1][4] / x.px - 1 };
  if (x.kind === 'GASI') {
    r.newHi = x.peak != null && up4 > x.peak;
    r.hit382 = x.f382 != null && dn4 <= x.f382; r.hit5 = x.f5 != null && dn4 <= x.f5;
  } else if (x.lo != null) {   // pull-back to .5/.618 of the leg base low -> highest high after the alarm, AFTER that high
    let hi = x.px, iHi = -1; k4.forEach((k, i) => { if (+k[2] > hi) { hi = +k[2]; iHi = i; } });
    const after = k4.slice(iHi + 1), lowAfter = after.length ? Math.min(...after.map(k => +k[3])) : Infinity;
    r.pb5 = lowAfter <= hi - 0.5 * (hi - x.lo); r.pb618 = lowAfter <= hi - 0.618 * (hi - x.lo);
  }
  return r;
}
// 2026-11-10 v1.6: does the alarm make money as a TRADE? 8h window (32 x 15m), first touch, SL+TP same bar = SL.
//  🧯 ГАСИ short: entry = alarm price, SL just over the peak, TP1 .382, TP2 .5 of the leg.
//  🔥 RUN short: leg = base low -> alarm price; SL alarm + .236 leg, TP1 alarm - .382 leg, TP2 - .5 leg.
//  🔥 IGNITE / ⚡ EARLY pull-back long: limit at .618 of base low -> running high after the alarm,
//     SL at .786, TP1 = that high (≈ 3.7R). NOFILL when .618 never comes inside the 8h.
const IG_SIM_BARS = 32;
function simPullback(x, kl) {
  let hi = x.px; const lo = x.lo;
  if (!(lo > 0 && lo < hi)) return null;
  for (let i = 0; i < kl.length; i++) {
    const H = +kl[i][2], L = +kl[i][3], leg = hi - lo, lvl = hi - 0.618 * leg;
    if (L <= lvl) {
      const sl = hi - 0.786 * leg, t = { side: 'L', entry: lvl, sl, tp1: hi, tp2: null, et: 'MKT', rr: (hi - lvl) / (lvl - sl) };
      if (L <= sl) return { res: 'SL', tp2: false, R: -1, entry: lvl };
      return { ...judge(t, kl.slice(i + 1)), entry: lvl };
    }
    if (H > hi) hi = H;
  }
  return { res: 'NOFILL', tp2: false, R: 0 };
}
function simShort(entry, sl, tp1, tp2, kl) {
  if (!(sl > entry)) return null;
  if (!(tp1 < entry)) { if (tp2 != null && tp2 < entry) { tp1 = tp2; tp2 = null; } else return null; }
  if (tp2 != null && !(tp2 < tp1)) tp2 = null;
  const t = { side: 'S', entry, sl, tp1, tp2, et: 'MKT', rr: (entry - tp1) / (sl - entry) };
  return judge(t, kl);
}
function igSim(x, kl) {
  if (x.kind === 'GASI') return x.peak > 0 && x.f382 > 0 ? simShort(x.px, x.peak * 1.003, x.f382, x.f5, kl) : null;
  if (x.kind === 'RUN') { if (!(x.lo > 0 && x.lo < x.px)) return null; const leg = x.px - x.lo; return simShort(x.px, x.px + 0.236 * leg, x.px - 0.382 * leg, x.px - 0.5 * leg, kl); }
  return simPullback(x, kl);
}
let igResolving = false;
async function resolveIg() {
  if (igResolving) return; igResolving = true;
  try {
    const now = Date.now();
    const due = state.igTrack.filter(x => x.px > 0 && ((!x.res && now >= x.t + 4 * 3600e3 + 60e3) || (x.sim === undefined && now >= x.t + IG_SIM_BARS * BAR + 60e3))).slice(0, 30);
    for (const x of due) {
      const kl = await bklines(x.coin + 'USDT', Math.floor(x.t / BAR) * BAR, IG_SIM_BARS + 1);
      if (!kl) continue;
      const k = kl.filter(r => +r[6] > x.t);
      if (!x.res && now >= x.t + 4 * 3600e3 + 60e3) { const k4 = k.slice(0, 16); x.res = k4.length >= 4 ? igJudge(x, k4) : { na: true }; }
      if (x.sim === undefined && now >= x.t + IG_SIM_BARS * BAR + 60e3) x.sim = k.length >= 8 ? igSim(x, k.slice(0, IG_SIM_BARS)) : null;
      await sleep(150);
    }
    if (due.length) save();
  } finally { igResolving = false; }
}
function igStats(hours) {
  const cut = Date.now() - hours * 3600e3, T = state.igTrack.filter(x => x.t >= cut), done = T.filter(x => x.res && !x.res.na);
  if (!T.length) return 'Уште нема аларми во овој период.';
  const med = a => { const v = a.filter(x => x != null && isFinite(x)).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const cnt = k => T.filter(x => x.kind === k).length;
  let t = `<b>🔥 ALARM следење · ${hours}h</b>\n⚡ EARLY ${cnt('EARLY')} · 🔥 IGNITE ${cnt('IGNITE')} · RUN ${cnt('RUN')} · 🧯 ГАСИ ${cnt('GASI')} · завршени ${done.length} (4h)\n`;
  for (const g of [['EARLY', '⚡ EARLY'], ['IGNITE', '🔥 IGNITE'], ['RUN', '🔥 RUN']]) {
    const a = done.filter(x => x.kind === g[0]); if (!a.length) continue;
    t += `\n<b>${g[1]}</b> · ${a.length}\nпо алармот: макс раст 1h ${pc(med(a.map(x => x.res.up1)))} / 4h ${pc(med(a.map(x => x.res.up4)))} · макс пад 4h ${pc(med(a.map(x => x.res.dn4)))} · крај 4h ${pc(med(a.map(x => x.res.end4)))} (медијани)\n` +
      `повлекување по врвот: до .5 ${a.filter(x => x.res.pb5).length}/${a.length} · до .618 ${a.filter(x => x.res.pb618).length}/${a.length}\n`;
  }
  const G = done.filter(x => x.kind === 'GASI');
  if (G.length) t += `\n<b>🧯 ГАСИ</b> · ${G.length}\nпо алармот: макс пад 4h ${pc(med(G.map(x => x.res.dn4)))} · макс раст 4h ${pc(med(G.map(x => x.res.up4)))} · крај 4h ${pc(med(G.map(x => x.res.end4)))}\nнов врв (squeeze) ${G.filter(x => x.res.newHi).length}/${G.length} · до .382 ${G.filter(x => x.res.hit382).length}/${G.length} · до .5 ${G.filter(x => x.res.hit5).length}/${G.length}\n`;
  const S = T.filter(x => x.sim && x.sim.res);
  if (S.length) {
    t += `\n<b>💰 Трејд симулација · 8h</b> (SL и TP во иста свеќа = SL)\n`;
    for (const g of [['GASI', '🧯 ГАСИ шорт · SL над врвот · TP .382/.5'], ['RUN', '🔥 RUN шорт · SL +.236 · TP −.382/−.5'], ['IGNITE', '🔥 IGNITE лимит .618 · SL .786 · TP врв'], ['EARLY', '⚡ EARLY лимит .618 · SL .786 · TP врв']]) {
      const a = S.filter(x => x.kind === g[0]); if (!a.length) continue;
      const sl = a.filter(x => x.sim.res === 'SL').length, tp = a.filter(x => x.sim.res === 'TP1').length, tp2 = a.filter(x => x.sim.tp2).length;
      const none = a.filter(x => x.sim.res === 'NONE').length, nf = a.filter(x => x.sim.res === 'NOFILL').length;
      const f = a.filter(x => x.sim.res !== 'NOFILL'), exp = f.length ? f.reduce((q, x) => q + x.sim.R, 0) / f.length : 0;
      const v = sl + tp >= 8 ? (exp > 0.2 ? 'носи ✅' : exp < -0.2 ? 'губи ❌' : 'неутрално ➖') : 'премалку примери';
      t += `${g[1]} · ${a.length}\nSL прв ${sl} · TP1 прв ${tp}${tp2 ? ' (TP2 ' + tp2 + ')' : ''} · ништо ${none}${nf ? ' · непополнет ' + nf : ''} · просек ${exp >= 0 ? '+' : ''}${exp.toFixed(2)}R → ${v}\n`;
    }
  }
  const L = T.filter(x => x.kind !== 'GASI' && x.first && x.first.px > 0);
  if (L.length) t += `\n<b>Доцнење</b> (прв кандидат → аларм): медијана ${Math.round(med(L.map(x => (x.t - x.first.t) / 60000)))} мин · цена ${pc(med(L.map(x => x.px / x.first.px - 1)))}\n`;
  t += '\n<b>Последни</b>\n' + [...T].sort((a, b) => b.t - a.t).slice(0, 10).map(x => {
    const ic = x.kind === 'GASI' ? '🧯' : x.kind === 'EARLY' ? '⚡' : '🔥', r = x.res;
    const res = !r ? 'отворено' : r.na ? 'n/a' : x.kind === 'GASI' ? `4h ${pc(r.dn4)} / ${pc(r.up4)}${r.newHi ? ' ⚠нов врв' : ''}${r.hit5 ? ' .5✔' : r.hit382 ? ' .382✔' : ''}`
      : `4h ${pc(r.up4)} / ${pc(r.dn4)}${r.pb618 ? ' .618✔' : r.pb5 ? ' .5✔' : ''}`;
    const lead = x.first && x.kind !== 'GASI' ? ` · прв ${hhmm(x.first.t)} ${pc(x.px / x.first.px - 1)}` : '';
    const sim = x.sim && x.sim.res ? ` · трејд ${x.sim.res === 'NOFILL' ? 'непоп.' : (x.sim.R >= 0 ? '+' : '') + x.sim.R + 'R'}` : '';
    return `${hhmm(x.t)} ${ic} ${esc(x.coin)} ${x.score}${lead} · ${res}${sim}`;
  }).join('\n');
  return t;
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
  '/why 48 — зошто нема сигнали (статистика по гејт)',
  '/near — 👀 9/10 известувања (on/off, не е влез)',
  '/nearstats 72 — што се случило после 9/10 и A/B (по гејт)',
  '/alarm — 🔥⚡🧯 аларм on/off · /alarm both — ▲ или ▲▼',
  '/igstats 72 — што се случило после 🔥 ⚡ 🧯 (1h/4h)',
  '/mute 60 · /unmute',
  '/quiet 01:00-08:30 · /quiet off — ноќна тишина',
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
    case '/igstats': { const h = Math.min(240, Math.max(1, parseInt(argRaw) || 72)); await resolveIg(); return send(igStats(h)); }
    case '/alarm': {
      if (/^both$/i.test(argRaw || '')) { state.alarmBoth = !state.alarmBoth; save(); aLoadedAt = 0; return send(`🔥 ALARM насока: ${state.alarmBoth ? '▲▼ (и паѓања)' : '▲ (само раст)'}`); }
      if (/^on$/i.test(argRaw || '')) state.alarm = true; else if (/^off$/i.test(argRaw || '')) state.alarm = false; else if (!argRaw) state.alarm = !state.alarm;
      save(); alarmPoll().catch(() => {});
      return send(state.alarm ? '🔥 ALARM вклучен · првите 5–15 мин собира податоци' : '🔥 ALARM исклучен');
    }
    case '/nearstats': { const h = Math.min(168, Math.max(1, parseInt(argRaw) || 72)); await resolveTracks(); return send(nearStats(h)); }
    case '/why': { const h = Math.min(72, Math.max(1, parseInt(argRaw) || 24)); return send(whyReport(h)); }
    case '/near': state.near = !state.near; save(); return send(`👀 9/10 известувања: ${state.near ? 'ON' : 'OFF'}\n(само за следење, влез е само ✅A/B)`);
    case '/mute': { const m = parseInt(argRaw) || 60; state.muteUntil = Date.now() + m * 60e3; save(); return send(`🔕 Тишина до ${hhmm(state.muteUntil)}`); }
    case '/unmute': state.muteUntil = 0; save(); return send('🔔 Алармите се вклучени');
    case '/quiet': {
      if (argRaw && /^off$/i.test(argRaw)) { state.quiet = null; save(); return send('🌙 Ноќна тишина: OFF'); }
      if (argRaw) {
        const q = text.slice(cmdRaw.length).trim();
        if (!parseQuiet(q)) return send('Формат: /quiet 01:00-08:30 или /quiet off');
        state.quiet = q.replace(/\s+/g, ''); save();
      }
      return send(state.quiet ? `🌙 Ноќна тишина: ${esc(state.quiet)} (без аларми)${inQuiet() ? ' · сега активна' : ''}` : '🌙 Ноќна тишина: OFF');
    }
    case '/status': {
      const f = state.lastFull, c = state.lastClean;
      return send([
        f ? `Build ${esc(f.ver)} ${esc(f.code)} · ${esc(f.build)}` : 'Build: уште не е вчитан',
        f ? `Цел скен ${hhmm(f.ts)} · ${f.uni} коини · ${f.n} сигнали · ${(f.dur / 1000).toFixed(0)}s` : 'Цел скен: —',
        c ? `CLEAN15 ${hhmm(c.ts)} · A${c.A} B${c.B} WAIT${c.W} · ${(c.dur / 1000).toFixed(0)}s` : 'CLEAN15: —',
        `Strict ${state.strict ? 'ON' : 'OFF'} · 9/10 ${state.near ? 'ON' : 'OFF'} · ${state.muteUntil > Date.now() ? '🔕 до ' + hhmm(state.muteUntil) : '🔔 активен'} · ред ${queueLen}`,
        `🌙 Тишина ${state.quiet ? esc(state.quiet) + (inQuiet() ? ' (сега)' : '') : 'OFF'}`,
        `📊 Следење: ${state.track.filter(x => !x.res).length} отворени · ${state.track.filter(x => x.res).length} завршени`,
        await alarmStatus(),
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
  if (!state.errNotified && !inQuiet()) { state.errNotified = true; save(); await send('⚠️ αSCOUT грешка: ' + esc(e.message)); }
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
        resolveTracks().catch(e => log('track', e.message));
        resolveIg().catch(e => log('igtrack', e.message));
        if (inQuiet() || Date.now() < state.muteUntil) continue;   // silent: nothing marked as sent
        const out = fresh(r.rows); save();
        if (out.length) await send(head(r) + '\n\n' + out.map(card).join('\n\n'));
        if (state.near && r.near9?.length) {
          const now = Date.now(), nn = r.near9.filter(z => {
            const k = z.coin + ':' + z.side, p = state.nearSent[k];
            if (p && now - p < CFG.cooldownMin * 60e3) return false;
            state.nearSent[k] = now; return true;
          }).slice(0, 5);
          for (const k in state.nearSent) if (now - state.nearSent[k] > 24 * 3600e3) delete state.nearSent[k];
          save();
          if (nn.length) await send(nn.map(nearCard).join('\n\n'));
        }
      }
    } catch (e) { await onError(e); try { await page?.close(); } catch {} page = null; }
  }
}

// ---------- MAIN ----------
log('aSCOUT bot starting, chat', state.chatId || '(waiting /start)');
pollLoop();
job(fullScan).then(() => send(`🟢 αSCOUT бот стартуван · ${esc(state.lastFull.ver)} ${esc(state.lastFull.code)} · ${esc(state.lastFull.build)}`)).catch(onError);
schedLoop();
setInterval(() => { alarmPoll().catch(() => {}); }, 20000);

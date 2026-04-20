// api/cron-snapshot.js — Vercel Cron Job
// Llama DIRECTAMENTE a Morningstar, Kraken y Yahoo Finance — sin self-fetch.
// Se ejecuta automáticamente cada día a las 22:00 UTC (config en vercel.json).
// Uso manual: GET /api/cron-snapshot  (sin CRON_SECRET) o
//             GET /api/cron-snapshot?secret=<CRON_SECRET>

export const config = { maxDuration: 300 };

import { putFile } from '../lib/github.js';

// ─────────────────────────────────────────────────────────────────────────────
// TABLA FONDOS: ISIN → { pid, sfx }  (idéntica a api/morningstar.js)
// ─────────────────────────────────────────────────────────────────────────────
const FUNDS = {
  'ES0157640006': { pid: '0P0001R4YK', sfx: 'FOESP$$ALL' }, // RF Horizonte 2027
  'ES0157639008': { pid: 'F00000Z653',  sfx: 'FOESP$$ALL' }, // RF Flexible A
  'ES0121776035': { pid: 'F0GBR04DNI', sfx: 'FOESP$$ALL' }, // Constantfons
  'ES0164839005': { pid: 'F00001GJDK', sfx: 'FOESP$$ALL' }, // Zebra US Small Caps A
  'ES0164838007': { pid: 'F0000173VQ', sfx: 'FOESP$$ALL' }, // Value Minus Growth A
  'ES0157642002': { pid: '0P0001TFN9', sfx: 'FOESP$$ALL' }, // V.I.F.
  'ES0113319034': { pid: 'F0GBR04DOJ', sfx: 'FOESP$$ALL' }, // Small Caps A
  'ES0141113037': { pid: 'F0GBR06FL7', sfx: 'FOESP$$ALL' }, // Japon A
  'ES0143597005': { pid: 'F00001DJ06', sfx: 'FOESP$$ALL' }, // Global Equity DS A
  'ES0140628035': { pid: 'F0GBR04DOB', sfx: 'FOESP$$ALL' }, // Emergentfond
  'ES0157638000': { pid: 'F00000SRXI', sfx: 'FOESP$$ALL' }, // 300 Places Worldwide A
  'LU0625737910': { pid: '0P0000TOUY', sfx: 'FOLUX$$ALL' }, // Pictet China Index P EUR
  'IE00BYX5MX67': { pid: '0P0001CLDM', sfx: 'FOIRL$$ALL' }, // Fidelity S&P 500 P-EUR
  'IE00BYX5NX33': { pid: '0P0001CLDK', sfx: 'FOIRL$$ALL' }, // Fidelity MSCI World P-EUR
  'ES0119199018': { pid: 'F000016A7V', sfx: 'FOESP$$ALL' }, // Cobas Internacional FI Clase D
  '0P0001L8Z8':   { pid: '0P0001L8Z8', sfx: 'FOESP$$ALL' }, // Baskepensiones RF Corto
  '0P0001L8YS':   { pid: '0P0001L8YS', sfx: 'FOESP$$ALL' }, // Baskepensiones Bolsa Euro
};

// Criptos: cgId -> par Kraken
const CG_TO_KRAKEN = {
  'bitcoin':        { pair: 'XXBTZEUR', inEur: true },
  'solana':         { pair: 'SOLEUR',   inEur: true },
  'ripple':         { pair: 'XXRPZEUR', inEur: true },
  'sui':            { pair: 'SUIUSD',   inEur: false },
  'kaspa':          { pair: 'KASUSD',   inEur: false },
  'pudgy-penguins': { pair: 'PENGUUSD', inEur: false },
  'pump-fun':       { pair: 'PUMPUSD',  inEur: false },
  'linea':          { pair: 'LINEAUSD', inEur: false },
};

// Benchmarks Yahoo Finance
const BENCH_TICKERS = {
  MSCIW: 'IWDA.L',
  EAGG:  'EUN4.DE',  // iShares EUR Aggregate Bond (Xetra) — ticker confirmado
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const today    = () => new Date().toISOString().slice(0, 10);
const msToDate = ms  => new Date(ms).toISOString().slice(0, 10);
function startDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 4);
  return d.toISOString().slice(0, 10);
}

const MS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Referer': 'https://www.morningstar.es/',
  'Origin': 'https://www.morningstar.es',
};
const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 25000;

async function fetchT(url, options = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MORNINGSTAR (directo)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFundHistory(isin) {
  const fund = FUNDS[isin];
  if (!fund) { console.warn(`[MS] sin mapeo: ${isin}`); return null; }
  const msId = `${fund.pid}]2]0]${fund.sfx}`;
  const url = `https://tools.morningstar.co.uk/api/rest.svc/timeseries_price/t92wz0sj7c` +
    `?currencyId=EUR&idtype=Morningstar&frequency=daily&outputType=COMPACTJSON` +
    `&startDate=${startDate()}&endDate=${today()}&id=${encodeURIComponent(msId)}`;
  try {
    const r = await fetchT(url, { headers: MS_HEADERS });
    if (!r.ok) { console.warn(`[MS] ${isin} HTTP ${r.status}`); return null; }
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;
    return data.map(([ms, price]) => ({ date: msToDate(ms), nav: price }));
  } catch (e) {
    console.warn(`[MS] ${isin}:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KRAKEN (directo)
// ─────────────────────────────────────────────────────────────────────────────
let _eurUsd = null;
async function getEurUsd() {
  if (_eurUsd) return _eurUsd;
  try {
    const r = await fetchT('https://api.kraken.com/0/public/Ticker?pair=EURUSD');
    if (r.ok) {
      const d = await r.json();
      const t = Object.values(d.result || {})[0];
      if (t?.c?.[0]) { _eurUsd = parseFloat(t.c[0]); return _eurUsd; }
    }
  } catch (e) {}
  _eurUsd = 1.08;
  return _eurUsd;
}

async function fetchCryptoHistory(cgId) {
  const m = CG_TO_KRAKEN[cgId];
  if (!m) return null;
  const since = Math.floor(Date.now() / 1000) - 4 * 365 * 24 * 3600;
  try {
    const r = await fetchT(`https://api.kraken.com/0/public/OHLC?pair=${m.pair}&interval=1440&since=${since}`);
    if (!r.ok) return null;
    const raw = await r.json();
    if (raw.error?.length) return null;
    const pd = Object.values(raw.result || {}).find(v => Array.isArray(v));
    if (!pd?.length) return null;
    const eurRate = m.inEur ? 1 : await getEurUsd();
    return pd.map(k => ({
      date: new Date(k[0] * 1000).toISOString().slice(0, 10),
      nav:  parseFloat(k[4]) / (m.inEur ? 1 : eurRate),
    }));
  } catch (e) {
    console.warn(`[KRK] ${cgId}:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// YAHOO FINANCE (directo)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchYahooHistory(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5y`;
  try {
    const r = await fetchT(url, { headers: { 'User-Agent': YF_UA, Accept: '*/*' } });
    if (!r.ok) return null;
    const d = await r.json();
    const q = d?.chart?.result?.[0];
    if (!q) return null;
    const ts = q.timestamp || [];
    const cl = q.indicators?.quote?.[0]?.close || [];
    const history = [];
    for (let i = 0; i < ts.length; i++) {
      if (cl[i] == null) continue;
      history.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), nav: cl[i] });
    }
    return history.length ? history : null;
  } catch (e) {
    console.warn(`[YF] ${ticker}:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// METRICAS
// ─────────────────────────────────────────────────────────────────────────────
function computeMetrics(history) {
  if (!history || history.length < 15) return null;
  const prices = history.map(h => h.nav).filter(v => v > 0);
  if (prices.length < 15) return null;
  const rets = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i-1] > 0 && prices[i] > 0) rets.push(Math.log(prices[i] / prices[i-1]));
  }
  if (rets.length < 10) return null;
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1) * 252);
  const neg = rets.filter(r => r < 0);
  const downVol = neg.length > 1 ? Math.sqrt(neg.reduce((s, v) => s + v * v, 0) / (neg.length - 1) * 252) : vol * 0.7;
  let peak = prices[0], maxDD = 0;
  for (const p of prices) { if (p > peak) peak = p; const dd = (peak - p) / peak; if (dd > maxDD) maxDD = dd; }
  const nDays = (new Date(history[history.length-1].date) - new Date(history[0].date)) / 86400000;
  const years = Math.max(nDays / 365.25, 0.1);
  const cagr = Math.pow(prices[prices.length-1] / prices[0], 1 / years) - 1;
  const now = new Date();
  const ytdCut = `${now.getFullYear()}-01-01`;
  const mtdCut = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const ytdS = history.find(h => h.date >= ytdCut);
  const mtdS = history.find(h => h.date >= mtdCut);
  const Rf = 0.03;
  return {
    vol, maxDD, cagr,
    ytd: ytdS ? (prices[prices.length-1] - ytdS.nav) / ytdS.nav : 0,
    mtd: mtdS ? (prices[prices.length-1] - mtdS.nav) / mtdS.nav : 0,
    sharpe:  vol > 0     ? (cagr - Rf) / vol     : 0,
    sortino: downVol > 0 ? (cagr - Rf) / downVol : 0,
    calmar:  maxDD > 0   ? cagr / maxDD           : 0,
    downVol, retDaily: mean * 252, nDays,
    lastNav: prices[prices.length - 1],
    lastDate: history[history.length - 1].date,
    histLen: history.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const CRON_SECRET  = (process.env.CRON_SECRET || '').trim();
  const authHeader   = (req.headers.authorization || '').trim();
  const querySecret  = (req.query?.secret || '').trim();
  const isVercelCron = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  const isManualAuth = CRON_SECRET && querySecret === CRON_SECRET;
  const noAuth       = !CRON_SECRET;

  if (!noAuth && !isVercelCron && !isManualAuth) {
    return res.status(401).json({
      error: 'Unauthorized',
      hint:  'Añade ?secret=TU_CRON_SECRET o elimina CRON_SECRET de Vercel para acceso libre.',
      debug: {
        hasCronSecret:     !!process.env.CRON_SECRET,
        cronSecretPrefix:  CRON_SECRET ? CRON_SECRET.slice(0,4)+'...' : '(vacio)',
        queryPrefix:       querySecret ? querySecret.slice(0,4)+'...' : '(vacio)',
      },
    });
  }

  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main' } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'Faltan GITHUB_TOKEN / GITHUB_REPO' });
  }

  const t0 = Date.now();
  const snap = {
    generatedAt: new Date().toISOString(),
    generatedBy: isVercelCron ? 'vercel-cron' : 'manual',
    histories: {}, metrics: {}, benchmarks: {},
    stats: { fundsOk:0, fundsFail:0, cryptosOk:0, cryptosFail:0, benchmarksOk:0, benchmarksFail:0 },
  };

  const isins = Object.keys(FUNDS);

  // 1. Fondos Morningstar (3 en paralelo, pausas entre lotes)
  for (let i = 0; i < isins.length; i += 3) {
    await Promise.allSettled(isins.slice(i, i+3).map(async isin => {
      const hist = await fetchFundHistory(isin);
      if (hist) {
        snap.histories[isin] = hist;
        const m = computeMetrics(hist);
        if (m) snap.metrics[isin] = m;
        snap.stats.fundsOk++;
        console.log(`[MS] OK ${isin} (${hist.length} pts)`);
      } else {
        snap.stats.fundsFail++;
      }
    }));
    if (i + 3 < isins.length) await new Promise(r => setTimeout(r, 800));
  }

  // 2. Criptos Kraken (secuencial)
  for (const cgId of Object.keys(CG_TO_KRAKEN)) {
    const hist = await fetchCryptoHistory(cgId);
    if (hist) {
      snap.histories[cgId] = hist;
      const m = computeMetrics(hist);
      if (m) snap.metrics[cgId] = m;
      snap.stats.cryptosOk++;
      console.log(`[KRK] OK ${cgId} (${hist.length} pts)`);
    } else {
      snap.stats.cryptosFail++;
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // 3. Benchmarks Yahoo
  for (const [key, ticker] of Object.entries(BENCH_TICKERS)) {
    const hist = await fetchYahooHistory(ticker);
    if (hist) {
      snap.benchmarks[key] = { ticker, history: hist, metrics: computeMetrics(hist) };
      snap.stats.benchmarksOk++;
      console.log(`[YF] OK ${ticker}/${key} (${hist.length} pts)`);
    } else {
      snap.stats.benchmarksFail++;
    }
  }

  // BTC como benchmark
  if (snap.histories['bitcoin']) {
    snap.benchmarks.BTC = { ticker: 'bitcoin', history: snap.histories['bitcoin'], metrics: snap.metrics['bitcoin'] || null };
    snap.stats.benchmarksOk++;
  }

  // MIX50 sintetico
  const mh = snap.benchmarks.MSCIW?.history;
  const eh = snap.benchmarks.EAGG?.history;
  if (mh && eh) {
    const m1={}, m2={};
    for (const {date,nav} of mh) m1[date]=nav;
    for (const {date,nav} of eh) m2[date]=nav;
    const common = Object.keys(m1).filter(d => d in m2).sort();
    if (common.length > 10) {
      const b1=m1[common[0]], b2=m2[common[0]];
      const mixH = common.map(d => ({ date: d, nav: (m1[d]/b1*0.5 + m2[d]/b2*0.5)*100 }));
      snap.benchmarks.MIX50 = { ticker: 'synthetic', history: mixH, metrics: computeMetrics(mixH) };
    }
  }

  snap.elapsedMs = Date.now() - t0;

  // 4. Guardar en GitHub
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    await putFile(
      GITHUB_TOKEN, GITHUB_REPO, 'snapshot.json',
      JSON.stringify(snap, null, 2),
      `Snapshot [${dateStr}] fondos ${snap.stats.fundsOk}/${isins.length} cripto ${snap.stats.cryptosOk}/${Object.keys(CG_TO_KRAKEN).length}`,
      GITHUB_BRANCH,
    );
    return res.status(200).json({ ok: true, message: 'Snapshot generado y subido a GitHub', stats: snap.stats, elapsedMs: snap.elapsedMs, generatedAt: snap.generatedAt });
  } catch (err) {
    console.error('[cron] GitHub error:', err.message);
    return res.status(500).json({ error: 'Error al subir snapshot.json', detail: err.message, stats: snap.stats });
  }
}

// api/cron-snapshot.js — Vercel Cron Job
// Se ejecuta automáticamente una vez al día (configurado en vercel.json)
// Descarga históricos de todos los activos + benchmarks, calcula métricas,
// y guarda un snapshot.json pre-cocinado en el repo de GitHub.
//
// SEGURIDAD: Vercel Crons envían un header "Authorization: Bearer $CRON_SECRET"
// con el valor de la variable de entorno CRON_SECRET. Verificamos eso.
//
// Uso manual (opcional): GET /api/cron-snapshot?secret=<valor_CRON_SECRET>

export const config = { maxDuration: 300 }; // 5 min, suficiente para descargas

import { putFile } from '../lib/github.js';

// ═════════════════════════════════════════════════════════════
// CONFIG: activos y benchmarks a descargar
// ═════════════════════════════════════════════════════════════
// Fondos Morningstar (ISIN único — los fondos CONJUNTA comparten ISIN)
const MS_ISINS = [
  'ES0157640006', // RF Horizonte 2027
  'ES0157639008', // RF Flexible A
  'ES0121776035', // Constantfons
  'ES0164839005', // Zebra US Small Caps A
  'ES0164838007', // Value Minus Growth A
  'ES0157642002', // V.I.F.
  'ES0113319034', // Small Caps A
  'ES0141113037', // Japón A
  'ES0143597005', // Global Equity DS A
  'ES0140628035', // Emergentfond
  'ES0157638000', // 300 Places Worldwide A
  'LU0625737910', // Pictet China Index P EUR
  'IE00BYX5MX67', // Fidelity S&P 500 P-EUR
  'IE00BYX5NX33', // Fidelity MSCI World P-EUR
  'ES0119199018', // Cobas Internacional FI Clase D
  '0P0001L8Z8',   // Baskepensiones RF Corto
  '0P0001L8YS',   // Baskepensiones Bolsa Euro
];

// Criptos (IDs CoinGecko / mapeo Kraken)
const CRYPTO_IDS = [
  'bitcoin', 'solana', 'ripple', 'sui',
  'kaspa', 'pudgy-penguins', 'pump-fun', 'linea',
];

// Benchmarks (Yahoo tickers)
const BENCH_TICKERS = {
  MSCIW: 'IWDA.L',   // iShares Core MSCI World
  EAGG:  'AGGH.DE',  // iShares Core Global Aggregate Bond EUR Hedged
};

// ═════════════════════════════════════════════════════════════
// HELPER: self-fetch a las APIs internas del proyecto
// ═════════════════════════════════════════════════════════════
function getBaseUrl(req) {
  // Vercel preview / production
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  // Custom host
  if (process.env.ALLOWED_HOST) return `https://${process.env.ALLOWED_HOST}`;
  // Fallback desde headers
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function fetchWithTimeout(url, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ═════════════════════════════════════════════════════════════
// CÁLCULO DE MÉTRICAS (espejo del front: calcRealVols + loadBenchmarks)
// ═════════════════════════════════════════════════════════════
function computeMetrics(history) {
  if (!history || history.length < 15) return null;
  const prices = history.map(h => h.nav).filter(v => v > 0);
  if (prices.length < 15) return null;

  // Log-returns diarios
  const rets = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i-1] > 0 && prices[i] > 0) rets.push(Math.log(prices[i]/prices[i-1]));
  }
  if (rets.length < 10) return null;

  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const variance = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1);
  const vol = Math.sqrt(variance * 252);

  // Downside deviation (Sortino)
  const neg = rets.filter(r => r < 0);
  const downVol = neg.length > 1
    ? Math.sqrt(neg.reduce((s, v) => s + v * v, 0) / (neg.length - 1) * 252)
    : vol * 0.7;

  // Max Drawdown
  let peak = prices[0], maxDD = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // CAGR
  const nDays = (new Date(history[history.length-1].date) - new Date(history[0].date)) / 86400000;
  const years = Math.max(nDays / 365.25, 0.1);
  const totalRet = prices[prices.length-1] / prices[0];
  const cagr = Math.pow(totalRet, 1/years) - 1;

  // YTD / MTD
  const now = new Date();
  const ytdCut = `${now.getFullYear()}-01-01`;
  const mtdCut = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const ytdS = history.find(h => h.date >= ytdCut);
  const ytd = ytdS ? (prices[prices.length-1] - ytdS.nav) / ytdS.nav : 0;
  const mtdS = history.find(h => h.date >= mtdCut);
  const mtd = mtdS ? (prices[prices.length-1] - mtdS.nav) / mtdS.nav : 0;

  // Sharpe, Sortino, Calmar (Rf = 3%)
  const Rf = 0.03;
  const sharpe  = vol > 0     ? (cagr - Rf) / vol : 0;
  const sortino = downVol > 0 ? (cagr - Rf) / downVol : 0;
  const calmar  = maxDD > 0   ? cagr / maxDD : 0;

  return {
    vol, maxDD, cagr, ytd, mtd, sharpe, sortino, calmar, downVol,
    retDaily: mean * 252,
    nDays,
    lastNav: prices[prices.length - 1],
    lastDate: history[history.length - 1].date,
    histLen: history.length,
  };
}

// ═════════════════════════════════════════════════════════════
// DESCARGA DE DATOS
// ═════════════════════════════════════════════════════════════
async function fetchMsHistory(baseUrl, isin) {
  try {
    const r = await fetchWithTimeout(
      `${baseUrl}/api/morningstar?action=history&isin=${isin}&from=2021-01-01`,
      30000
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d.history?.length ? d.history : null;
  } catch (e) {
    console.warn(`[cron] MS ${isin}:`, e.message);
    return null;
  }
}

async function fetchCryptoHistory(baseUrl, cgId) {
  try {
    const r = await fetchWithTimeout(
      `${baseUrl}/api/crypto-history?id=${encodeURIComponent(cgId)}`,
      25000
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d.history?.length ? d.history : null;
  } catch (e) {
    console.warn(`[cron] CG ${cgId}:`, e.message);
    return null;
  }
}

async function fetchYahooHistory(baseUrl, ticker) {
  try {
    const r = await fetchWithTimeout(
      `${baseUrl}/api/yahoo?ticker=${encodeURIComponent(ticker)}&action=history`,
      25000
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d.history?.length ? d.history : null;
  } catch (e) {
    console.warn(`[cron] YF ${ticker}:`, e.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
// HANDLER
// ═════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // ── Autenticación: Vercel Cron o secret en query ─────────────
  const CRON_SECRET = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const querySecret = req.query?.secret;

  const isVercelCron = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  const isManualAuth = CRON_SECRET && querySecret === CRON_SECRET;

  if (CRON_SECRET && !isVercelCron && !isManualAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Comprobación de env vars ────────────────────────────────
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main' } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'Faltan variables GITHUB_TOKEN / GITHUB_REPO' });
  }

  const startTime = Date.now();
  const baseUrl = getBaseUrl(req);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    generatedBy: isVercelCron ? 'vercel-cron' : 'manual',
    histories: {},   // { isin|cgId|ticker : [{date,nav}, ...] }
    metrics:   {},   // { isin|cgId|ticker : {vol,cagr,sharpe,...} }
    benchmarks: {},  // { MSCIW: {history, metrics}, EAGG: {...}, BTC: {...} }
    stats: {
      fundsOk: 0, fundsFail: 0,
      cryptosOk: 0, cryptosFail: 0,
      benchmarksOk: 0, benchmarksFail: 0,
    },
  };

  // ── 1. Descargar fondos Morningstar (en paralelo, 3 a la vez) ──
  for (let i = 0; i < MS_ISINS.length; i += 3) {
    const batch = MS_ISINS.slice(i, i + 3);
    await Promise.allSettled(batch.map(async isin => {
      const hist = await fetchMsHistory(baseUrl, isin);
      if (hist) {
        snapshot.histories[isin] = hist;
        const m = computeMetrics(hist);
        if (m) snapshot.metrics[isin] = m;
        snapshot.stats.fundsOk++;
      } else {
        snapshot.stats.fundsFail++;
      }
    }));
  }

  // ── 2. Descargar criptos (secuencial, Kraken tiene rate-limit) ──
  for (const cgId of CRYPTO_IDS) {
    const hist = await fetchCryptoHistory(baseUrl, cgId);
    if (hist) {
      snapshot.histories[cgId] = hist;
      const m = computeMetrics(hist);
      if (m) snapshot.metrics[cgId] = m;
      snapshot.stats.cryptosOk++;
    } else {
      snapshot.stats.cryptosFail++;
    }
    await new Promise(r => setTimeout(r, 300)); // respetar rate-limit
  }

  // ── 3. Descargar benchmarks Yahoo ─────────────────────────────
  for (const [key, ticker] of Object.entries(BENCH_TICKERS)) {
    const hist = await fetchYahooHistory(baseUrl, ticker);
    if (hist) {
      const m = computeMetrics(hist);
      snapshot.benchmarks[key] = { ticker, history: hist, metrics: m };
      snapshot.stats.benchmarksOk++;
    } else {
      snapshot.stats.benchmarksFail++;
    }
  }

  // BTC como benchmark = reutilizar histórico de 'bitcoin'
  if (snapshot.histories['bitcoin']) {
    snapshot.benchmarks.BTC = {
      ticker: 'bitcoin',
      history: snapshot.histories['bitcoin'],
      metrics: snapshot.metrics['bitcoin'] || null,
    };
    snapshot.stats.benchmarksOk++;
  }

  // MIX50 sintético: 50% MSCI World + 50% Euro Agg
  const msciw = snapshot.benchmarks.MSCIW?.history;
  const eagg = snapshot.benchmarks.EAGG?.history;
  if (msciw && eagg) {
    const m1 = {}, m2 = {};
    for (const { date, nav } of msciw) m1[date] = nav;
    for (const { date, nav } of eagg)  m2[date] = nav;
    const commonDates = Object.keys(m1).filter(d => d in m2).sort();
    if (commonDates.length > 10) {
      const base1 = m1[commonDates[0]], base2 = m2[commonDates[0]];
      const mixHist = commonDates.map(d => ({
        date: d,
        nav: (m1[d]/base1 * 0.5 + m2[d]/base2 * 0.5) * 100
      }));
      snapshot.benchmarks.MIX50 = {
        ticker: 'synthetic',
        history: mixHist,
        metrics: computeMetrics(mixHist),
      };
    }
  }

  // ── 4. Guardar en GitHub ─────────────────────────────────────
  snapshot.elapsedMs = Date.now() - startTime;

  try {
    const today = new Date().toISOString().slice(0, 10);
    await putFile(
      GITHUB_TOKEN,
      GITHUB_REPO,
      'snapshot.json',
      JSON.stringify(snapshot, null, 2),
      `Snapshot diario [${today}] · ${snapshot.stats.fundsOk}/${MS_ISINS.length} fondos · ${snapshot.stats.cryptosOk}/${CRYPTO_IDS.length} criptos · ${snapshot.stats.benchmarksOk} benchmarks`,
      GITHUB_BRANCH,
    );

    return res.status(200).json({
      ok: true,
      message: 'Snapshot generado y subido a GitHub',
      stats: snapshot.stats,
      elapsedMs: snapshot.elapsedMs,
      generatedAt: snapshot.generatedAt,
    });
  } catch (err) {
    console.error('[cron-snapshot]', err.message);
    return res.status(500).json({
      error: 'Error al subir snapshot a GitHub',
      detail: err.message,
      stats: snapshot.stats,
    });
  }
}

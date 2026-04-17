// api/yahoo.js — Vercel Serverless Function
// Proxy para Yahoo Finance con autenticación crumb
// Fixes: AbortController timeout, crumb más robusto, sin Cache Map en memoria serverless

export const config = { maxDuration: 20 };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 9000;

// crumbCache sobrevive entre warm invocations de la misma instancia (best-effort)
let crumbCache = null;
const CRUMB_TTL = 55 * 60 * 1000;

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_HOST
    ? `https://${process.env.ALLOWED_HOST}`
    : '*';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // Cache de borde de Vercel CDN (15 min)
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { ticker, action } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker requerido' });

  const sym = ticker.toUpperCase().trim();
  const act = action || 'summary';

  try {
    let result;
    if      (act === 'chart')   result = await fetchChart(sym);
    else if (act === 'history') result = await fetchHistory(sym);
    else                        result = await fetchSummary(sym);
    return res.json(result);
  } catch (err) {
    console.error('[yahoo]', sym, err.message);
    return res.status(500).json({ error: 'Error al obtener datos de Yahoo Finance' });
  }
}

async function getCrumb() {
  if (crumbCache && Date.now() - crumbCache.ts < CRUMB_TTL) return crumbCache;

  const pageRes = await fetchWithTimeout('https://finance.yahoo.com/', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
  });
  const cookie = pageRes.headers.get('set-cookie') || '';

  const crumbRes = await fetchWithTimeout('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Accept': '*/*', 'Cookie': cookie },
  });
  const crumb = await crumbRes.text();
  if (!crumb || crumb.includes('<') || crumb.length > 30) throw new Error('crumb inválido');

  crumbCache = { crumb: crumb.trim(), cookie, ts: Date.now() };
  return crumbCache;
}

// ── Precio actual (últimos 5 días) ──────────────────────────────
async function fetchChart(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`;
  const r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' } });
  if (!r.ok) throw new Error(`chart HTTP ${r.status}`);
  const d = await r.json();
  const q = d?.chart?.result?.[0];
  if (!q) throw new Error('sin datos chart');
  const closes = (q.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  const price  = closes[closes.length - 1];
  const prev   = closes.length > 1 ? closes[closes.length - 2] : price;
  const d1     = prev > 0 ? ((price - prev) / prev) * 100 : 0;
  return { price, d1, longName: q.meta?.longName || sym };
}

// ── Histórico de precios (5 años, intervalo diario) ─────────────
async function fetchHistory(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5y`;
  const r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' } });
  if (!r.ok) throw new Error(`history HTTP ${r.status}`);
  const d = await r.json();
  const q = d?.chart?.result?.[0];
  if (!q) throw new Error('sin datos history');
  const timestamps = q.timestamp || [];
  const closes = q.indicators?.quote?.[0]?.close || [];
  const history = [];
  for (let i = 0; i < timestamps.length; i++) {
    const nav = closes[i];
    if (nav == null) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    history.push({ date, nav });
  }
  return { history };
}

// ── Fundamentales con crumb ─────────────────────────────────────
async function fetchSummary(sym) {
  const modules = 'summaryDetail,financialData,defaultKeyStatistics,assetProfile,price';
  let root = null;

  // Intento 1: con crumb (v10)
  try {
    const { crumb, cookie } = await getCrumb();
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetchWithTimeout(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Cookie': cookie },
    });
    if (r.ok) {
      const json = await r.json();
      root = json?.quoteSummary?.result?.[0] || null;
    }
  } catch (e) {
    crumbCache = null;
    console.warn('[crumb]', e.message);
  }

  // Intento 2: v11 sin crumb
  if (!root) {
    const url = `https://query2.finance.yahoo.com/v11/finance/quoteSummary/${sym}?modules=${modules}`;
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`summary HTTP ${r.status}`);
    const json = await r.json();
    root = json?.quoteSummary?.result?.[0];
    if (!root) throw new Error('sin datos');
  }

  const sd = root.summaryDetail        || {};
  const fd = root.financialData        || {};
  const ks = root.defaultKeyStatistics || {};
  const ap = root.assetProfile         || {};
  const pr = root.price                || {};

  const price = pr.regularMarketPrice?.raw ?? sd.previousClose?.raw ?? null;
  const d1    = pr.regularMarketChangePercent?.raw != null ? pr.regularMarketChangePercent.raw * 100 : 0;
  const trailingEps = ks.trailingEps?.raw;
  const per = sd.trailingPE?.raw ?? (price && trailingEps > 0 ? +(price / trailingEps).toFixed(2) : null);

  return {
    price, d1,
    longName:     pr.longName || pr.shortName || sym,
    per,
    forwardPer:   sd.forwardPE?.raw ?? null,
    peg:          ks.pegRatio?.raw ?? null,
    pb:           ks.priceToBook?.raw ?? null,
    ps:           ks.priceToSalesTrailing12Months?.raw ?? null,
    evEbitda:     ks.enterpriseToEbitda?.raw ?? null,
    divYield:     sd.dividendYield?.raw != null ? +(sd.dividendYield.raw * 100).toFixed(2) : null,
    profitMargin: fd.profitMargins?.raw != null ? +(fd.profitMargins.raw * 100).toFixed(2) : null,
    roe:          fd.returnOnEquity?.raw != null ? +(fd.returnOnEquity.raw * 100).toFixed(2) : null,
    debtEq:       fd.debtToEquity?.raw != null ? +(fd.debtToEquity.raw / 100).toFixed(2) : null,
    low52:        sd.fiftyTwoWeekLow?.raw ?? null,
    high52:       sd.fiftyTwoWeekHigh?.raw ?? null,
    mktCap:       pr.marketCap?.raw ?? ks.marketCap?.raw ?? null,
    beta:         sd.beta?.raw ?? null,
    sector:       ap.sector ?? null,
    industry:     ap.industry ?? null,
    summary:      ap.longBusinessSummary ? ap.longBusinessSummary.slice(0, 280) + '…' : null,
  };
}

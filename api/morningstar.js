// api/morningstar.js
export const config = { maxDuration: 30 };

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Referer': 'https://www.morningstar.es/',
  'Origin': 'https://www.morningstar.es',
};

const FUNDS = {
  'ES0157640006': { pid: '0P0001R4YK', sfx: 'FOESP$$ALL' },
  'ES0157639008': { pid: 'F00000Z653',  sfx: 'FOESP$$ALL' },
  'ES0121776035': { pid: 'F0GBR04DNI', sfx: 'FOESP$$ALL' },
  'ES0164839005': { pid: 'F00001GJDK', sfx: 'FOESP$$ALL' },
  'ES0164838007': { pid: 'F0000173VQ', sfx: 'FOESP$$ALL' },
  'ES0157642002': { pid: '0P0001TFN9', sfx: 'FOESP$$ALL' },
  'ES0113319034': { pid: 'F0GBR04DOJ', sfx: 'FOESP$$ALL' },
  'ES0141113037': { pid: 'F0GBR06FL7', sfx: 'FOESP$$ALL' },
  'ES0143597005': { pid: 'F00001DJ06', sfx: 'FOESP$$ALL' },
  'ES0140628035': { pid: 'F0GBR04DOB', sfx: 'FOESP$$ALL' },
  'ES0157638000': { pid: 'F00000SRXI', sfx: 'FOESP$$ALL' },
  'LU0625737910': { pid: '0P0000TOUY', sfx: 'FOLUX$$ALL' },
  'IE00BYX5MX67': { pid: '0P0001CLDM', sfx: 'FOIRL$$ALL' },
  'IE00BYX5NX33': { pid: '0P0001CLDK', sfx: 'FOIRL$$ALL' },
  'IE000QAZP7L2': { pid: '0P0001XF3Z', sfx: 'FOIRL$$ALL' }, // iShares EM Index S Acc EUR
  'ES0119199018': { pid: 'F000016A7V', sfx: 'FOESP$$ALL' },
  '0P0001L8Z8':   { pid: '0P0001L8Z8', sfxs: ['FOESP$$ALL', 'FEESP$$ALL', 'FPESP$$ALL', 'XIESP$$ALL'] },
  '0P0001L8YS':   { pid: '0P0001L8YS', sfxs: ['FOESP$$ALL', 'FEESP$$ALL', 'FPESP$$ALL', 'XIESP$$ALL'] },
};

const CACHE = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, isin, from } = req.query;

  try {
    if (action === 'nav') {
      const fund = FUNDS[isin];
      if (!fund) return res.status(404).json({ error: 'ISIN no mapeado: ' + isin });

      const cKey = 'nav:' + fund.pid;
      if (CACHE.has(cKey)) {
        const c = CACHE.get(cKey);
        if (Date.now() - c.ts < 3600000) return res.json({ isin, ...c.data });
      }

      const sfxList = fund.sfxs || [fund.sfx];
      const data = await fetchMsCascade(fund.pid, sfxList, daysAgo(10), today(), false);
      CACHE.set(cKey, { ts: Date.now(), data });
      return res.json({ isin, performanceId: fund.pid, ...data });
    }

    if (action === 'history') {
      const fund = FUNDS[isin];
      if (!fund) return res.status(404).json({ error: 'ISIN no mapeado: ' + isin });

      const sfxList = fund.sfxs || [fund.sfx];
      const history = await fetchMsCascade(fund.pid, sfxList, from || '2021-01-01', today(), true);
      return res.json({ isin, performanceId: fund.pid, history });
    }

    return res.status(400).json({ error: 'action invalida. Usa: nav, history' });

  } catch (err) {
    console.error('[ms-proxy]', action, isin, err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchMsCascade(pid, sfxList, startDate, endDate, returnHistory) {
  let lastErr;
  for (const sfx of sfxList) {
    try {
      const result = await fetchMs(pid, sfx, startDate, endDate, returnHistory);
      if (sfxList.length > 1) console.log('[ms-proxy] ' + pid + ' OK con sufijo ' + sfx);
      return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Ningun sufijo valido para ' + pid);
}

async function fetchMs(pid, sfx, startDate, endDate, returnHistory) {
  const msId = pid + ']2]0]' + sfx;
  const url = 'https://tools.morningstar.co.uk/api/rest.svc/timeseries_price/t92wz0sj7c' +
    '?currencyId=EUR&idtype=Morningstar&frequency=daily&outputType=COMPACTJSON' +
    '&startDate=' + startDate + '&endDate=' + endDate + '&id=' + encodeURIComponent(msId);

  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error('Morningstar HTTP ' + r.status + ' para ' + pid + ' (' + sfx + ')');
  const data = await r.json();
  if (!Array.isArray(data) || data.length === 0)
    throw new Error('Sin datos para ' + pid + ' (' + sfx + ')');

  if (returnHistory) return data.map(function(d) { return { date: msToDate(d[0]), nav: d[1] }; });

  const last = data[data.length - 1];
  const prev = data.length > 1 ? data[data.length - 2] : last;
  return {
    nav: last[1],
    change1d: prev[1] ? ((last[1] - prev[1]) / prev[1]) * 100 : 0,
    date: msToDate(last[0]),
  };
}

function today() { return new Date().toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function msToDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

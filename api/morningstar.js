// api/morningstar.js
// Proxy de precios de fondos via Morningstar.
//
// Cambio jul-2026: tools.morningstar.co.uk empezo a devolver 301 hacia
// global.morningstar.com. Al seguir la redireccion llegaba HTML en vez de
// JSON, el parseo reventaba y el endpoint respondia 500.
//
// Solucion: cascada de hosts/claves/formatos. Se detecta la combinacion
// que funciona, se memoriza y se reutiliza. Las redirecciones se cortan
// con redirect:'manual' para no acabar parseando HTML nunca mas.
//
// Diagnostico:  /api/morningstar?action=debug
//               /api/morningstar?action=debug&pid=0P0001XF3Z

export const config = { maxDuration: 30 };

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Referer': 'https://www.morningstar.es/',
  'Origin': 'https://www.morningstar.es',
};

// Hosts regionales. El .es va primero: es el mas probable que siga vivo
// para fondos espanoles y es el Referer que enviamos.
const HOSTS = [
  'tools.morningstar.es',
  'tools.morningstar.co.uk',
  'lt.morningstar.com',
  'tools.morningstar.it',
  'tools.morningstar.de',
  'tools.morningstar.fr',
];

const KEYS = ['t92wz0sj7c', 'jbseuq1ymf'];

// Separador entre performance id y sufijo de universo.
const ID_FORMATS = [']2]0]', ']2]1]'];

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

// Combinacion host/clave/formato que ya sabemos que funciona.
// Se rellena en el primer acierto y se reutiliza en las siguientes llamadas.
let WORKING = null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, isin, from } = req.query;

  try {
    if (action === 'debug') return await handleDebug(req, res);

    if (action === 'nav') {
      const fund = FUNDS[isin];
      if (!fund) return res.status(404).json({ error: 'ISIN no mapeado: ' + isin });

      const cKey = 'nav:' + fund.pid;
      const cached = CACHE.get(cKey);
      if (cached && Date.now() - cached.ts < 3600000) {
        return res.json({ isin, ...cached.data });
      }

      const sfxList = fund.sfxs || [fund.sfx];
      try {
        const data = await fetchMsCascade(fund.pid, sfxList, daysAgo(10), today(), false);
        CACHE.set(cKey, { ts: Date.now(), data });
        return res.json({ isin, performanceId: fund.pid, ...data });
      } catch (e) {
        // Si Morningstar falla pero teniamos un precio previo, lo servimos
        // marcado como obsoleto en vez de dejar el dashboard sin dato.
        if (cached) {
          return res.json({ isin, performanceId: fund.pid, ...cached.data, stale: true });
        }
        throw e;
      }
    }

    if (action === 'history') {
      const fund = FUNDS[isin];
      if (!fund) return res.status(404).json({ error: 'ISIN no mapeado: ' + isin });

      const sfxList = fund.sfxs || [fund.sfx];
      const history = await fetchMsCascade(fund.pid, sfxList, from || '2021-01-01', today(), true);
      return res.json({ isin, performanceId: fund.pid, history });
    }

    return res.status(400).json({ error: 'action invalida. Usa: nav, history, debug' });

  } catch (err) {
    console.error('[ms-proxy]', action, isin, err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Cascada
// ---------------------------------------------------------------------------

function buildUrl(host, key, idfmt, pid, sfx, startDate, endDate) {
  const msId = pid + idfmt + sfx;
  return 'https://' + host + '/api/rest.svc/timeseries_price/' + key +
    '?currencyId=EUR&idtype=Morningstar&frequency=daily&outputType=COMPACTJSON' +
    '&startDate=' + startDate + '&endDate=' + endDate +
    '&id=' + encodeURIComponent(msId);
}

// Devuelve el array de puntos [[ts, precio], ...] o lanza error.
async function tryCombo(host, key, idfmt, pid, sfx, startDate, endDate) {
  const url = buildUrl(host, key, idfmt, pid, sfx, startDate, endDate);

  // redirect:'manual' evita acabar parseando la pagina HTML de destino.
  const r = await fetch(url, { headers: HEADERS, redirect: 'manual' });

  if (r.status >= 300 && r.status < 400) {
    throw new Error('redirect ' + r.status + ' -> ' + (r.headers.get('location') || '?'));
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);

  const text = await r.text();
  const trimmed = text.trim();
  if (!trimmed) throw new Error('respuesta vacia');
  if (trimmed[0] === '<') throw new Error('devuelve HTML, no JSON');

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    throw new Error('JSON invalido');
  }

  if (!Array.isArray(data) || data.length === 0) throw new Error('sin datos');
  return data;
}

async function fetchRaw(pid, sfxList, startDate, endDate) {
  let lastErr;

  // 1) Probar primero la combinacion ya conocida.
  if (WORKING) {
    for (const sfx of sfxList) {
      try {
        return await tryCombo(WORKING.host, WORKING.key, WORKING.idfmt, pid, sfx, startDate, endDate);
      } catch (e) { lastErr = e; }
    }
  }

  // 2) Cascada completa.
  for (const host of HOSTS) {
    for (const key of KEYS) {
      for (const idfmt of ID_FORMATS) {
        if (WORKING && WORKING.host === host && WORKING.key === key && WORKING.idfmt === idfmt) continue;
        for (const sfx of sfxList) {
          try {
            const data = await tryCombo(host, key, idfmt, pid, sfx, startDate, endDate);
            WORKING = { host, key, idfmt };
            console.log('[ms-proxy] combinacion valida: ' + host + ' | ' + key + ' | ' + idfmt + ' | ' + sfx);
            return data;
          } catch (e) { lastErr = e; }
        }
      }
    }
  }

  throw new Error('Ninguna fuente disponible para ' + pid + ' (ultimo: ' + (lastErr && lastErr.message) + ')');
}

async function fetchMsCascade(pid, sfxList, startDate, endDate, returnHistory) {
  const data = await fetchRaw(pid, sfxList, startDate, endDate);

  if (returnHistory) {
    return data.map(function (d) { return { date: msToDate(d[0]), nav: d[1] }; });
  }

  const last = data[data.length - 1];
  const prev = data.length > 1 ? data[data.length - 2] : last;
  return {
    nav: last[1],
    change1d: prev[1] ? ((last[1] - prev[1]) / prev[1]) * 100 : 0,
    date: msToDate(last[0]),
  };
}

// ---------------------------------------------------------------------------
// Diagnostico
// ---------------------------------------------------------------------------

async function handleDebug(req, res) {
  const pid = (req.query.pid || '0P0001CLDM').trim();
  const sfx = (req.query.sfx || 'FOIRL$$ALL').trim();
  const startDate = daysAgo(30);
  const endDate = today();

  const results = [];

  for (const host of HOSTS) {
    for (const key of KEYS) {
      for (const idfmt of ID_FORMATS) {
        const label = host + ' | ' + key + ' | ' + idfmt;
        const t0 = Date.now();
        try {
          const data = await tryCombo(host, key, idfmt, pid, sfx, startDate, endDate);
          results.push({
            test: label,
            veredicto: '*** OK - DEVUELVE DATOS ***',
            puntos: data.length,
            ultimo: data[data.length - 1],
            ms: Date.now() - t0,
          });
        } catch (e) {
          results.push({ test: label, veredicto: e.message, ms: Date.now() - t0 });
        }
      }
    }
  }

  const ok = results.filter(r => r.veredicto.indexOf('OK') !== -1);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    pid,
    sfx,
    rango: startDate + ' -> ' + endDate,
    resumen: {
      total: results.length,
      funcionan: ok.length,
      ganadores: ok.map(r => r.test),
    },
    detalle: results,
  });
}

// ---------------------------------------------------------------------------

function today() { return new Date().toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
function msToDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

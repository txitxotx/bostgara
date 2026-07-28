// api/mstest.js
// Diagnostico temporal: prueba combinaciones de host/clave/sufijo de Morningstar
// desde el servidor de Vercel (sin CORS) y reporta cual devuelve datos.
// Uso:  https://bostgara.vercel.app/api/mstest
//       https://bostgara.vercel.app/api/mstest?pid=0P0001XF3Z
// Borrar este archivo cuando terminemos el diagnostico.

const HOSTS = [
  'tools.morningstar.co.uk',
  'tools.morningstar.es',
  'tools.morningstar.it',
  'tools.morningstar.de',
  'tools.morningstar.fr',
  'lt.morningstar.com',
];

const KEYS = [
  't92wz0sj7c',
  'jbseuq1ymf',
];

const SUFFIXES = [
  ']2]1]',
  ']2]1]FOESP$$ALL',
  ']2]1]FOIRL$$ALL',
  ']2]1]FOGBR$$ALL',
];

function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

async function probe(url) {
  const started = Date.now();
  try {
    const r = await fetch(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.morningstar.es/',
      },
    });

    const out = {
      status: r.status,
      ms: Date.now() - started,
      location: r.headers.get('location') || null,
      contentType: r.headers.get('content-type') || null,
    };

    if (r.status >= 300 && r.status < 400) {
      out.verdict = 'REDIRECT (endpoint retirado)';
      return out;
    }

    const text = await r.text();
    out.bytes = text.length;
    out.sample = text.slice(0, 220);

    if (!r.ok) {
      out.verdict = 'ERROR HTTP';
      return out;
    }

    const trimmed = text.trim();
    if (trimmed.startsWith('<')) {
      out.verdict = 'HTML (no es JSON)';
      return out;
    }

    try {
      const j = JSON.parse(trimmed);
      const arr = Array.isArray(j) ? j : (j.TimeSeries || j.data || null);
      out.parsed = true;
      out.points = Array.isArray(arr) ? arr.length : null;
      out.verdict = out.points > 0 ? '*** OK - DEVUELVE DATOS ***' : 'JSON vacio';
    } catch (e) {
      out.verdict = 'JSON invalido';
    }
    return out;
  } catch (e) {
    return { status: 'FETCH_FAIL', error: String(e.message || e), ms: Date.now() - started };
  }
}

export default async function handler(req, res) {
  const pid = (req.query.pid || '0P0001CLDM').trim();
  const startDate = isoDaysAgo(30);
  const endDate = isoDaysAgo(0);

  const results = [];

  // ---- Bloque 1: API timeseries_price clasica ----
  for (const host of HOSTS) {
    for (const key of KEYS) {
      for (const suffix of SUFFIXES) {
        const id = encodeURIComponent(pid + suffix);
        const url = `https://${host}/api/rest.svc/timeseries_price/${key}`
          + `?currencyId=EUR&idtype=Morningstar&frequency=daily`
          + `&startDate=${startDate}&endDate=${endDate}`
          + `&outputType=COMPACTJSON&id=${id}&priceType=`;
        const r = await probe(url);
        results.push({ test: `timeseries | ${host} | ${key} | ${suffix}`, url, ...r });
      }
    }
  }

  // ---- Bloque 2: SAL service (nuevo, requiere apikey/bearer) ----
  const salKeys = ['lstzFDEOhfFNMLikKa0am9czi2Q7Y0'];
  for (const k of salKeys) {
    const url = `https://api-global.morningstar.com/sal-service/v1/fund/priceChart/${pid}/data`
      + `?currency=EUR&apikey=${k}`;
    const r = await probe(url);
    results.push({ test: `sal-service | apikey=${k.slice(0, 8)}...`, url, ...r });
  }

  // ---- Bloque 3: pagina snapshot (fallback de scraping, solo NAV actual) ----
  const snapUrls = [
    `https://www.morningstar.es/es/funds/snapshot/snapshot.aspx?id=${pid}`,
    `https://www.morningstar.co.uk/uk/funds/snapshot/snapshot.aspx?id=${pid}`,
  ];
  for (const url of snapUrls) {
    const r = await probe(url);
    results.push({ test: `snapshot | ${new URL(url).host}`, url, ...r });
  }

  const winners = results.filter(r => r.verdict && r.verdict.includes('OK'));

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    pid,
    startDate,
    endDate,
    resumen: {
      total: results.length,
      funcionan: winners.length,
      ganadores: winners.map(w => w.test),
    },
    detalle: results,
  });
}

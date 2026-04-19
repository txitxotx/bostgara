// api/get-snapshot.js — Sirve el snapshot.json pre-generado por el cron
// Cache agresivo de CDN: el snapshot solo cambia una vez al día

export const config = { maxDuration: 15 };

import { getFile } from '../lib/github.js';

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_HOST
    ? `https://${process.env.ALLOWED_HOST}`
    : '*';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main' } = process.env;

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'Faltan variables GITHUB_TOKEN / GITHUB_REPO' });
  }

  try {
    const file = await getFile(GITHUB_TOKEN, GITHUB_REPO, 'snapshot.json', GITHUB_BRANCH);

    if (!file) {
      return res.status(404).json({
        error: 'snapshot.json no encontrado',
        hint: 'El cron diario no se ha ejecutado aún. Lanza manualmente /api/cron-snapshot?secret=...',
      });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(file.content);

  } catch (err) {
    console.error('[get-snapshot]', err.message);
    return res.status(500).json({ error: 'Error al leer snapshot.json' });
  }
}

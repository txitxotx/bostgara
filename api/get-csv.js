// api/get-csv.js — Lee portfolio.csv directamente desde GitHub (siempre fresco)
// Fixes: usa lib/github (timeout, retry), detecta errores por Content-Type

export const config = { maxDuration: 15 };

import { getFile } from '../lib/github.js';

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_HOST
    ? `https://${process.env.ALLOWED_HOST}`
    : '*';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main' } = process.env;

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'Faltan variables GITHUB_TOKEN / GITHUB_REPO' });
  }

  try {
    const file = await getFile(GITHUB_TOKEN, GITHUB_REPO, 'portfolio.csv', GITHUB_BRANCH);

    if (!file) {
      return res.status(404).json({ error: 'portfolio.csv no encontrado en el repo' });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).send(file.content);

  } catch (err) {
    console.error('[get-csv]', err.message);
    return res.status(500).json({ error: 'Error al leer portfolio.csv' });
  }
}

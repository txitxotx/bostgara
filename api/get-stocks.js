// api/get-stocks.js — Lee stocks-history.json directamente desde GitHub
// Fixes: lib/github (timeout, retry), no expone errores internos

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
    const file = await getFile(GITHUB_TOKEN, GITHUB_REPO, 'stocks-history.json', GITHUB_BRANCH);

    if (!file) {
      return res.status(404).json({ error: 'stocks-history.json no encontrado' });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(file.content);

  } catch (err) {
    console.error('[get-stocks]', err.message);
    return res.status(500).json({ error: 'Error al leer stocks-history.json' });
  }
}

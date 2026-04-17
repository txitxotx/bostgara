// api/save-stocks.js — Guarda stocks-history.json en el repo de GitHub
// Fixes: lib/github (retry, timeout, SHA race), auth backend

export const config = { maxDuration: 20 };

import { putFile } from '../lib/github.js';
import { rejectIfUnauthorized } from '../lib/auth.js';

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_HOST
    ? `https://${process.env.ALLOWED_HOST}`
    : '*';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  if (rejectIfUnauthorized(req, res)) return;

  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main' } = process.env;

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'Faltan variables GITHUB_TOKEN / GITHUB_REPO' });
  }

  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Sin contenido' });

    // Validar que es JSON válido
    JSON.parse(content);

    const today = new Date().toISOString().slice(0, 10);
    await putFile(
      GITHUB_TOKEN,
      GITHUB_REPO,
      'stocks-history.json',
      content,
      `Actualizar stocks-history.json [${today}]`,
      GITHUB_BRANCH,
    );

    return res.status(200).json({ ok: true, message: 'stocks-history.json actualizado en GitHub' });

  } catch (err) {
    console.error('[save-stocks]', err.message);
    return res.status(500).json({ error: 'Error al guardar stocks-history.json' });
  }
}

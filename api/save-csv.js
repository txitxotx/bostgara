// api/save-csv.js — Guarda portfolio.csv en el repo de GitHub
// Fixes: lib/github (retry, timeout, SHA race), auth backend, validación CSV básica

export const config = { maxDuration: 20 };

import { putFile } from '../lib/github.js';
import { rejectIfUnauthorized } from '../lib/auth.js';

/** Valida que el contenido parece un CSV de portfolio (cabecera mínima) */
function validateCsv(content) {
  if (!content || typeof content !== 'string') return false;
  const firstLine = content.replace(/^\uFEFF/, '').split('\n')[0] || ''; // BOM safe
  // Debe tener al menos un campo separado por comas o punto y coma
  return firstLine.includes(',') || firstLine.includes(';');
}

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_HOST
    ? `https://${process.env.ALLOWED_HOST}`
    : '*';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  // Verificar autenticación a nivel de API (defensa en profundidad)
  if (rejectIfUnauthorized(req, res)) return;

  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main' } = process.env;

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'Faltan variables GITHUB_TOKEN / GITHUB_REPO' });
  }

  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Sin contenido' });

    if (!validateCsv(content)) {
      return res.status(400).json({ error: 'El contenido no parece un CSV válido' });
    }

    const today = new Date().toISOString().slice(0, 10);
    await putFile(
      GITHUB_TOKEN,
      GITHUB_REPO,
      'portfolio.csv',
      content,
      `Actualizar portfolio.csv [${today}]`,
      GITHUB_BRANCH,
    );

    return res.status(200).json({ ok: true, message: 'portfolio.csv actualizado en GitHub' });

  } catch (err) {
    console.error('[save-csv]', err.message);
    return res.status(500).json({ error: 'Error al guardar portfolio.csv' });
  }
}

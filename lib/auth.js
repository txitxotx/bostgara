// lib/auth.js — Helper de autenticación para endpoints serverless (Node runtime)
// IMPORTANTE: solo lo importan funciones del runtime Node (api/login.js,
// api/save-csv.js, api/save-txn.js, api/save-stocks.js).
// El middleware.js usa Web Crypto API directamente y NO importa este archivo,
// por lo que Vercel NO lo bundlea en el Edge Runtime. Es seguro tenerlo aquí.
//
// Si este archivo falta → MODULE_NOT_FOUND → todos los endpoints de guardado
// crashean y los datos NUNCA se persisten en GitHub.

import { createHmac, timingSafeEqual } from 'crypto';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

export function generateSessionToken(secret) {
  if (!secret) throw new Error('SESSION_SECRET vacío');
  const ts = String(Date.now());
  const sig = createHmac('sha256', secret).update(ts).digest('hex');
  return `${ts}.${sig}`;
}

export function verifySessionToken(token, secret) {
  try {
    if (!token || !secret) return false;
    const [tsStr, sig] = token.split('.');
    if (!tsStr || !sig) return false;
    const ts = Number(tsStr);
    if (!Number.isFinite(ts)) return false;
    if (Date.now() - ts > MAX_AGE_MS) return false;
    const expected = createHmac('sha256', secret).update(tsStr).digest('hex');
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function readAuthCookie(req) {
  const raw = req.headers?.cookie || '';
  const m = raw.match(/(?:^|;\s*)maikos_auth=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function rejectIfUnauthorized(req, res) {
  const password = process.env.SITE_PASSWORD;
  const secret   = process.env.SESSION_SECRET || password;
  if (!password) return false;
  const token = readAuthCookie(req);
  if (!token) { res.status(401).json({ error: 'No autenticado' }); return true; }
  const hmacOk   = secret ? verifySessionToken(token, secret) : false;
  const legacyOk = token === password;
  if (!hmacOk && !legacyOk) { res.status(401).json({ error: 'No autenticado' }); return true; }
  return false;
}

// lib/auth.js — Helper de autenticación para endpoints serverless (Node runtime)
// Este archivo es CRÍTICO: lo importan api/login.js, api/save-csv.js,
// api/save-txn.js y api/save-stocks.js. Si falta, todos los endpoints de
// guardado crashean al cargar y los datos NUNCA se persisten en GitHub.
//
// Formato del token (compatible con middleware.js que usa Web Crypto API):
//   <timestamp>.<hmacSHA256(timestamp, SESSION_SECRET) en hex>
//
// El middleware.js lo valida en el Edge; estas funciones lo generan y
// revalidan en el runtime Node de las funciones /api/*.

import { createHmac, timingSafeEqual } from 'crypto';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

/**
 * Firma un timestamp con HMAC-SHA256 y devuelve "ts.sig" en hex.
 * Debe coincidir bit a bit con la validación de middleware.js.
 */
export function generateSessionToken(secret) {
  if (!secret) throw new Error('SESSION_SECRET vacío');
  const ts = String(Date.now());
  const sig = createHmac('sha256', secret).update(ts).digest('hex');
  return `${ts}.${sig}`;
}

/**
 * Valida un token "ts.sig". Devuelve true si firma correcta y no expirado.
 */
export function verifySessionToken(token, secret) {
  try {
    if (!token || !secret) return false;
    const [tsStr, sig] = token.split('.');
    if (!tsStr || !sig) return false;

    const ts = Number(tsStr);
    if (!Number.isFinite(ts)) return false;
    if (Date.now() - ts > MAX_AGE_MS) return false;

    const expected = createHmac('sha256', secret).update(tsStr).digest('hex');

    // timingSafeEqual requiere buffers de misma longitud
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || a.length === 0) return false;

    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Extrae la cookie maikos_auth de un objeto req estilo Vercel/Node. */
function readAuthCookie(req) {
  const raw = req.headers?.cookie || '';
  const m = raw.match(/(?:^|;\s*)maikos_auth=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Defensa en profundidad dentro del propio endpoint.
 * Si no hay SITE_PASSWORD configurado → acceso libre (modo dev).
 * Si hay password pero falta/es inválida la cookie → 401 y devuelve true.
 * Si todo OK → devuelve false y el handler continúa normalmente.
 *
 * Uso en los handlers:
 *     if (rejectIfUnauthorized(req, res)) return;
 */
export function rejectIfUnauthorized(req, res) {
  const password = process.env.SITE_PASSWORD;
  const secret   = process.env.SESSION_SECRET || password;

  // Sin password configurada → acceso libre (por ejemplo en desarrollo local)
  if (!password) return false;

  const token = readAuthCookie(req);
  if (!token) {
    res.status(401).json({ error: 'No autenticado' });
    return true;
  }

  // Aceptamos token HMAC válido o, por compatibilidad transitoria,
  // la propia password en claro (igual que hace middleware.js).
  const hmacOk   = secret ? verifySessionToken(token, secret) : false;
  const legacyOk = token === password;

  if (hmacOk || legacyOk) return false;

  res.status(401).json({ error: 'No autenticado' });
  return true;
}

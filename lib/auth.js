// lib/auth.js — Verifica que el request viene autenticado
// Los endpoints POST sensibles deben llamar a requireAuth(req) al inicio.

import { createHmac } from 'crypto';

/**
 * Comprueba que la petición lleva una cookie de sesión válida
 * o bien un header Authorization correcto.
 *
 * Devuelve true si está autenticado, false si no.
 */
export function isAuthenticated(req) {
  const secret = process.env.SESSION_SECRET || process.env.SITE_PASSWORD;
  if (!secret) return true; // Sin auth configurada → libre

  const cookieHeader = req.headers['cookie'] || '';
  const match = cookieHeader.match(/(?:^|;\s*)maikos_auth=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : null;

  if (!token) return false;

  // Soporte doble: token nuevo (HMAC) o cookie legacy (password en claro, migración)
  if (isValidHmacToken(token, secret)) return true;

  // Compatibilidad hacia atrás durante la migración
  if (token === process.env.SITE_PASSWORD) return true;

  return false;
}

/**
 * Verifica que el origen de la petición es el propio dominio.
 * Evita CSRF en endpoints mutantes (POST).
 */
export function isOriginAllowed(req) {
  const allowedHost = process.env.ALLOWED_HOST; // ej: "tu-app.vercel.app"
  if (!allowedHost) return true; // No configurado → permisivo

  const origin = req.headers['origin'] || req.headers['referer'] || '';
  return origin.includes(allowedHost);
}

/**
 * Lanza respuesta 401 si no está autenticado, 403 si el origen no está permitido.
 * Devuelve true si debe abortar (ya respondió).
 */
export function rejectIfUnauthorized(req, res) {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: 'No autenticado' });
    return true;
  }
  if (!isOriginAllowed(req)) {
    res.status(403).json({ error: 'Origen no permitido' });
    return true;
  }
  return false;
}

// ── Generación / validación de tokens HMAC ─────────────────────

/**
 * Genera un token de sesión firmado: "ts.hmac"
 * Válido 30 días.
 */
export function generateSessionToken(secret) {
  const ts = Date.now();
  const sig = createHmac('sha256', secret).update(String(ts)).digest('hex');
  return `${ts}.${sig}`;
}

/**
 * Valida un token de sesión HMAC.
 * Rechaza tokens caducados (> 30 días).
 */
export function isValidHmacToken(token, secret) {
  try {
    const [tsStr, sig] = token.split('.');
    if (!tsStr || !sig) return false;
    const ts = Number(tsStr);
    if (isNaN(ts)) return false;
    // Caducado
    if (Date.now() - ts > 30 * 24 * 60 * 60 * 1000) return false;
    const expected = createHmac('sha256', secret).update(tsStr).digest('hex');
    // Comparación de longitud constante
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

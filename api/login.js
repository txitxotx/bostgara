// api/login.js — Valida la contraseña y establece cookie de sesión con token HMAC
// Fixes aplicados:
//   - Comparación timing-safe (evita timing attacks)
//   - Cookie guarda token HMAC firmado, NO la contraseña en claro
//   - Rate-limit básico por IP (ventana 5 min, máx 10 intentos)
//   - CORS restringido al propio host

export const config = { maxDuration: 5 };

import { createHash, timingSafeEqual } from 'crypto';
import { generateSessionToken } from '../lib/auth.js';

// Rate limiter en memoria (aproximado; se resetea en cold start)
const attempts = new Map(); // ip → { count, resetAt }
const WINDOW_MS  = 5 * 60 * 1000; // 5 min
const MAX_TRIES  = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  rec.count++;
  if (rec.count > MAX_TRIES) return false;
  return true;
}

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_HOST
    ? `https://${process.env.ALLOWED_HOST}`
    : req.headers.origin || '*';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    // Delay extra para dificultar el ataque incluso tras limite
    await new Promise(r => setTimeout(r, 1500));
    return res.status(429).json({ error: 'Demasiados intentos. Espera 5 minutos.' });
  }

  const { password } = req.body || {};
  const SITE_PASSWORD = process.env.SITE_PASSWORD;
  const SESSION_SECRET = process.env.SESSION_SECRET || SITE_PASSWORD;

  if (!SITE_PASSWORD) {
    // Sin contraseña configurada → acceso libre
    return res.status(200).json({ ok: true });
  }

  // Comparación timing-safe: hashea ambos lados con SHA-256 para igualar longitud
  const bufA = createHash('sha256').update(password  || '').digest();
  const bufB = createHash('sha256').update(SITE_PASSWORD).digest();
  const match = timingSafeEqual(bufA, bufB);

  if (!match) {
    // Delay anti-brute-force
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  // Contraseña correcta → generar token HMAC firmado (NO guardar la password)
  const token = generateSessionToken(SESSION_SECRET);
  const cookieMaxAge = 60 * 60 * 24 * 30; // 30 días

  res.setHeader('Set-Cookie',
    `maikos_auth=${encodeURIComponent(token)}; Path=/; Max-Age=${cookieMaxAge}; HttpOnly; Secure; SameSite=Lax`
  );

  return res.status(200).json({ ok: true });
}

// middleware.js — Vercel Edge Middleware (sin Next.js)
// Fixes aplicados:
//   - Valida token HMAC (no la password en claro)
//   - Las rutas /api/* reciben 401 JSON, no redirect 302
//   - Compatibilidad transitoria con cookie legacy (password en claro)

import { isValidHmacToken } from './lib/auth.js';

const PUBLIC = ['/login.html', '/api/login'];

export default function middleware(request) {
  const url  = new URL(request.url);
  const path = url.pathname;

  // Rutas públicas → dejar pasar siempre
  if (PUBLIC.some(p => path.startsWith(p))) return;

  const cookie   = request.headers.get('cookie') || '';
  const password = process.env.SITE_PASSWORD;
  const secret   = process.env.SESSION_SECRET || password;

  // Sin contraseña configurada → acceso libre
  if (!password) return;

  // Extraer cookie maikos_auth
  const match = cookie.match(/(?:^|;\s*)maikos_auth=([^;]+)/);
  const rawToken = match ? decodeURIComponent(match[1]) : null;

  // Validar token
  const isHmacValid = rawToken && secret && isValidHmacToken(rawToken, secret);
  // Compatibilidad legacy: cookie con password en claro (eliminar tras migración)
  const isLegacyValid = rawToken && rawToken === password;

  if (isHmacValid || isLegacyValid) return; // ✅ Autenticado

  // ❌ No autenticado
  if (path.startsWith('/api/')) {
    // Para fetch/XHR → responder 401 JSON (no redirect)
    return new Response(JSON.stringify({ error: 'No autenticado' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Para páginas → redirigir al login
  const loginUrl = new URL('/login.html', request.url);
  loginUrl.searchParams.set('from', path);
  return Response.redirect(loginUrl.toString(), 302);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};

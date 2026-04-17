// middleware.js — Vercel Edge Middleware
// USA Web Crypto API (disponible en Edge), NO Node.js crypto

const PUBLIC = ['/login.html', '/api/login'];

async function isValidHmacToken(token, secret) {
  try {
    const [tsStr, sig] = token.split('.');
    if (!tsStr || !sig) return false;
    const ts = Number(tsStr);
    if (isNaN(ts)) return false;
    if (Date.now() - ts > 30 * 24 * 60 * 60 * 1000) return false; // 30 días

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(tsStr));
    const expected = Array.from(new Uint8Array(sigBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return expected === sig;
  } catch {
    return false;
  }
}

export default async function middleware(request) {
  const url  = new URL(request.url);
  const path = url.pathname;

  if (PUBLIC.some(p => path.startsWith(p))) return;

  const cookie   = request.headers.get('cookie') || '';
  const password = process.env.SITE_PASSWORD;
  const secret   = process.env.SESSION_SECRET || password;

  if (!password) return;

  const match = cookie.match(/(?:^|;\s*)maikos_auth=([^;]+)/);
  const rawToken = match ? decodeURIComponent(match[1]) : null;

  if (!rawToken) return reject(request, path);

  const hmacOk  = secret ? await isValidHmacToken(rawToken, secret) : false;
  const legacyOk = rawToken === password; // compatibilidad transitoria

  if (hmacOk || legacyOk) return; // ✅ Autenticado

  return reject(request, path);
}

function reject(request, path) {
  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'No autenticado' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const loginUrl = new URL('/login.html', request.url);
  loginUrl.searchParams.set('from', path);
  return Response.redirect(loginUrl.toString(), 302);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};

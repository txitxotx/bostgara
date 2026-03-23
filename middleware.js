// middleware.js — Vercel Edge Middleware (sin Next.js)
// Usa la Web API nativa compatible con Vercel Edge Runtime

const PUBLIC = ['/login.html', '/api/login'];

export default function middleware(request) {
  const url  = new URL(request.url);
  const path = url.pathname;

  // Rutas públicas → dejar pasar siempre
  if (PUBLIC.some(p => path.startsWith(p))) {
    return;
  }

  // Leer cookie de sesión
  const cookie   = request.headers.get('cookie') || '';
  const password = process.env.SITE_PASSWORD;

  // Sin contraseña configurada → acceso libre (modo dev)
  if (!password) return;

  // Extraer valor de cookie maikos_auth
  const match = cookie.match(/(?:^|;\s*)maikos_auth=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : null;

  if (token === password) {
    // Autenticado → renovar cookie
    const res = new Response(null, { status: 200 });
    res.headers.set(
      'Set-Cookie',
      `maikos_auth=${encodeURIComponent(password)}; Path=/; Max-Age=${60*60*24*30}; HttpOnly; Secure; SameSite=Lax`
    );
    return res;
  }

  // No autenticado → redirigir a login
  const loginUrl = new URL('/login.html', request.url);
  loginUrl.searchParams.set('from', path);
  return Response.redirect(loginUrl.toString(), 302);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

// middleware.js — Vercel Edge Middleware (sin Next.js)

const PUBLIC = ['/login.html', '/api/login'];

export default function middleware(request) {
  const url  = new URL(request.url);
  const path = url.pathname;

  // Rutas públicas → dejar pasar siempre
  if (PUBLIC.some(p => path.startsWith(p))) {
    return; // undefined = Vercel sirve el archivo normalmente
  }

  const cookie   = request.headers.get('cookie') || '';
  const password = process.env.SITE_PASSWORD;

  // Sin contraseña configurada → acceso libre
  if (!password) return;

  // Extraer cookie maikos_auth
  const match = cookie.match(/(?:^|;\s*)maikos_auth=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : null;

  if (token === password) {
    // ✅ Autenticado → NO devolver Response, dejar que Vercel sirva el archivo
    return; // undefined = pass-through
  }

  // ❌ No autenticado → redirigir a login
  const loginUrl = new URL('/login.html', request.url);
  loginUrl.searchParams.set('from', path);
  return Response.redirect(loginUrl.toString(), 302);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

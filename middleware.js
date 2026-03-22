// middleware.js — Protección con contraseña para toda la web MAIKOS
// Vercel Edge Middleware: se ejecuta antes de servir cualquier ruta
//
// Variable de entorno necesaria en Vercel:
//   SITE_PASSWORD → la contraseña que quieras (ej: "maikos2024")
//
// Cómo funciona:
//   1. Si la cookie "auth" tiene el valor correcto → acceso permitido
//   2. Si no → redirige a /login.html
//   3. /login.html y /api/login no requieren autenticación (excluidas)

import { NextResponse } from 'next/server';

// Rutas que NO requieren autenticación
const PUBLIC = ['/login.html', '/api/login', '/favicon.ico'];

export function middleware(request) {
  const { pathname } = request.nextUrl;

  // Dejar pasar rutas públicas
  if (PUBLIC.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Comprobar cookie de sesión
  const authCookie = request.cookies.get('maikos_auth');
  const password   = process.env.SITE_PASSWORD;

  if (!password) {
    // Si no hay contraseña configurada → dejar pasar (modo desarrollo)
    return NextResponse.next();
  }

  if (authCookie?.value === password) {
    // Autenticado → renovar cookie (30 días)
    const res = NextResponse.next();
    res.cookies.set('maikos_auth', password, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 días
      path: '/',
    });
    return res;
  }

  // No autenticado → redirigir a login
  const loginUrl = new URL('/login.html', request.url);
  loginUrl.searchParams.set('from', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * Aplica a todas las rutas excepto:
     * - _next/static (archivos estáticos de Next.js)
     * - _next/image (optimización de imágenes)
     * - favicon.ico
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};

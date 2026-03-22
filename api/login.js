// api/login.js — Valida la contraseña y establece la cookie de sesión
export const config = { maxDuration: 5 };

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { password } = req.body || {};
  const SITE_PASSWORD = process.env.SITE_PASSWORD;

  if (!SITE_PASSWORD) {
    // Sin contraseña configurada → acceso libre
    return res.status(200).json({ ok: true });
  }

  if (!password || password !== SITE_PASSWORD) {
    // Pequeño delay anti-brute-force
    return new Promise(resolve => setTimeout(() => {
      res.status(401).json({ error: 'Contraseña incorrecta' });
      resolve();
    }, 800));
  }

  // Contraseña correcta → establecer cookie httpOnly de 30 días
  res.setHeader('Set-Cookie',
    `maikos_auth=${SITE_PASSWORD}; Path=/; Max-Age=${60*60*24*30}; HttpOnly; Secure; SameSite=Lax`
  );
  return res.status(200).json({ ok: true });
}

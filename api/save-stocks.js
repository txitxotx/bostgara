// api/save-stocks.js — Guarda stocks-history.json en el repo de GitHub
// Variables de entorno necesarias en Vercel:
//   GITHUB_TOKEN   → Personal Access Token con permisos repo
//   GITHUB_REPO    → "usuario/nombre-repo"
//   GITHUB_BRANCH  → rama (por defecto "main")

export const config = { maxDuration: 20 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main' } = process.env;

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'Faltan variables GITHUB_TOKEN / GITHUB_REPO' });
  }

  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Sin contenido' });

    // Validar que es JSON válido
    JSON.parse(content);

    const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/stocks-history.json`;
    const headers = {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };

    // Obtener SHA del archivo actual si existe
    let sha;
    try {
      const getRes = await fetch(`${apiBase}?ref=${GITHUB_BRANCH}`, { headers });
      if (getRes.ok) { const d = await getRes.json(); sha = d.sha; }
    } catch(e) {}

    const body = {
      message: `Actualizar stocks-history.json [${new Date().toISOString().slice(0,10)}]`,
      content: Buffer.from(content).toString('base64'),
      branch: GITHUB_BRANCH,
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiBase, {
      method: 'PUT', headers, body: JSON.stringify(body),
    });

    if (!putRes.ok) {
      const err = await putRes.json();
      throw new Error(err.message || `GitHub API error ${putRes.status}`);
    }

    return res.status(200).json({ ok: true, message: 'stocks-history.json actualizado en GitHub' });

  } catch(err) {
    console.error('[save-stocks]', err.message);
    return res.status(500).json({ error: err.message });
  }
}

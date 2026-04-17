// lib/github.js — Helper centralizado para operaciones GitHub Content API
// Todos los endpoints save-*/get-* deben importar desde aquí.

const GH_API = 'https://api.github.com';
const TIMEOUT_MS = 8000;

function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/** Fetch con timeout automático */
async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lee un archivo del repo. Devuelve { content: string, sha: string } o null si no existe.
 * @param {string} token  GitHub PAT
 * @param {string} repo   "usuario/repo"
 * @param {string} path   "portfolio.csv"
 * @param {string} branch "main"
 */
export async function getFile(token, repo, path, branch = 'main') {
  const url = `${GH_API}/repos/${repo}/contents/${path}?ref=${branch}`;
  const r = await fetchWithTimeout(url, { headers: ghHeaders(token) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET ${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { content, sha: data.sha };
}

/**
 * Escribe un archivo en el repo. Reintenta 1 vez en caso de conflicto SHA (409/422).
 * @param {string} token
 * @param {string} repo
 * @param {string} path
 * @param {string} content  Texto a guardar
 * @param {string} message  Mensaje de commit
 * @param {string} branch
 */
export async function putFile(token, repo, path, content, message, branch = 'main') {
  const apiUrl = `${GH_API}/repos/${repo}/contents/${path}`;
  const headers = ghHeaders(token);

  async function attemptPut(retries = 2) {
    // Obtener SHA actual (necesario para actualizar)
    let sha;
    try {
      const existing = await getFile(token, repo, path, branch);
      if (existing) sha = existing.sha;
    } catch (_) { /* archivo nuevo */ }

    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    };

    const r = await fetchWithTimeout(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });

    if ((r.status === 409 || r.status === 422) && retries > 0) {
      // Conflicto de SHA — reintentamos con SHA fresco
      await new Promise(res => setTimeout(res, 300));
      return attemptPut(retries - 1);
    }

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.message || `GitHub PUT ${r.status}`);
    }

    return r.json();
  }

  return attemptPut();
}

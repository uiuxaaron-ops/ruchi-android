/*
 * Ask Ruchi AI server — a Cloudflare Worker (free tier is plenty to start).
 * The app sends the conversation here; this calls Claude with YOUR API key,
 * which stays on the server and never ships inside the app.
 *
 * Secrets (set with wrangler, never commit them):
 *   ANTHROPIC_API_KEY  your Claude API key (console.anthropic.com)
 *   RUCHI_KEY          optional; must match aiKey in src/config.js
 * Optional variable:
 *   MODEL              defaults to claude-haiku-5-5 (fast + cheap)
 */
const ORIGINS = ['https://localhost', 'capacitor://localhost', 'http://localhost'];

function cors(req) {
  const o = req.headers.get('origin') || '';
  return {
    'access-control-allow-origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-ruchi-key',
    'access-control-max-age': '86400'
  };
}
const json = (req, status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(req) } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    if (req.method !== 'POST') return json(req, 405, { error: 'POST only' });
    if (env.RUCHI_KEY && req.headers.get('x-ruchi-key') !== env.RUCHI_KEY) return json(req, 401, { error: 'bad key' });

    let body;
    try { body = await req.json(); } catch { return json(req, 400, { error: 'bad json' }); }
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || !messages.length || messages.length > 20) return json(req, 400, { error: 'messages required (max 20)' });
    for (const m of messages) {
      if (!['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 60000)
        return json(req, 400, { error: 'bad message' });
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: env.MODEL || 'claude-haiku-5-5', max_tokens: 1200, messages })
    });
    if (r.status === 429) return json(req, 429, { error: 'rate_limited' });
    if (!r.ok) return json(req, 502, { error: 'upstream ' + r.status });
    const j = await r.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return json(req, 200, { text, truncated: j.stop_reason === 'max_tokens' });
  }
};

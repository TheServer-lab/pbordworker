// worker.js - Cloudflare Worker for reading Discord messages (read-only)
// Deploy with Wrangler or Cloudflare Dashboard. Store BOT_TOKEN as a secret.
// Usage: GET /messages?channel_id=123456789012345678&limit=50

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // simple health check
      if (pathname === '/health') {
        return jsonResponse({ ok: true, note: 'worker up' });
      }

      // GET /messages?channel_id=...&limit=...
      if (pathname === '/messages' && request.method === 'GET') {
        const channelId = url.searchParams.get('channel_id');
        const limit = Math.min(100, Number(url.searchParams.get('limit') || 50));
        if (!channelId) return jsonResponse({ error: 'missing channel_id' }, 400);

        // Build Discord API URL
        const discordUrl = `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`;

        // Try to respond from Cache API first (optional)
        const cacheKey = new Request(discordUrl, request);
        const cache = caches.default;
        let cached = await cache.match(cacheKey);
        if (cached) {
          const body = await cached.json();
          return corsJsonResponse(normalizeMessages(body));
        }

        // Fetch from Discord
        const BOT_TOKEN = env.BOT_TOKEN;
        if (!BOT_TOKEN) return jsonResponse({ error: 'server misconfigured' }, 500);

        const resp = await fetch(discordUrl, {
          headers: { Authorization: `Bot ${BOT_TOKEN}` },
          method: 'GET'
        });

        if (!resp.ok) {
          const text = await resp.text();
          return corsJsonResponse({ error: 'discord_error', status: resp.status, text }, resp.status);
        }

        const json = await resp.json();

        // Cache for a short time (helps reduce rate usage)
        const resToCache = new Response(JSON.stringify(json), {
          headers: { 'Content-Type': 'application/json' }
        });
        // cache for 10 seconds
        resToCache.headers.set('Cache-Control', 'public, max-age=10');
        request.cf = request.cf || {}; // ensure request.cf exists
        await cache.put(cacheKey, resToCache.clone());

        return corsJsonResponse(normalizeMessages(json));
      }

      return jsonResponse({ error: 'not_found' }, 404);
    } catch (err) {
      return jsonResponse({ error: 'server_error', detail: String(err) }, 500);
    }
  }
}

// Normalize message objects to only what the frontend needs
function normalizeMessages(msgs) {
  return msgs.map(m => ({
    id: m.id,
    content: m.content,
    timestamp: m.timestamp || m.created_at || m.createdTimestamp || new Date().toISOString(),
    author_name: m.author ? `${m.author.username}${m.author.discriminator ? '#' + m.author.discriminator : ''}` : 'Unknown',
    attachments: (m.attachments || []).map(a => ({ url: a.url, filename: a.filename || a.name || '', size: a.size || 0 }))
  }));
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function corsJsonResponse(obj, status = 200) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', // consider restricting to your domain in production
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  return new Response(JSON.stringify(obj), { status, headers });
}

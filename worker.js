// worker.js - Cloudflare Worker for reading Discord messages (read-only)
// - Store your bot token with wrangler secret put BOT_TOKEN
// - Endpoints:
//    GET /health
//    GET /messages?channel_id=<id>&limit=<n>
//    GET /lookup?channel_id=<id>&username=<username>   (searches REGISTER username|salt|hash|ts messages)
// CORS enabled. Uses caches.default (10s).

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const origin = request.headers.get('Origin') || '*';
    const CORS_ORIGIN = env.ALLOWED_ORIGIN || origin || '*';

    // Handle OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(CORS_ORIGIN)
      });
    }

    try {
      if (pathname === '/health') {
        return corsJson({ ok: true, note: 'worker up' }, 200, CORS_ORIGIN);
      }

      if (pathname === '/messages' && request.method === 'GET') {
        const channelId = url.searchParams.get('channel_id');
        const limit = Math.min(100, Number(url.searchParams.get('limit') || 50));
        if (!channelId) return corsJson({ error: 'missing channel_id' }, 400, CORS_ORIGIN);

        const discordUrl = `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`;

        // cache key
        const cacheKey = new Request(`${discordUrl}`, request);
        const cache = caches.default;
        const cached = await cache.match(cacheKey);
        if (cached) {
          const body = await cached.json();
          return corsJson(normalizeMessages(body), 200, CORS_ORIGIN);
        }

        const BOT_TOKEN = env.BOT_TOKEN;
        if (!BOT_TOKEN) return corsJson({ error: 'server misconfigured' }, 500, CORS_ORIGIN);

        const resp = await fetch(discordUrl, {
          method: 'GET',
          headers: { Authorization: `Bot ${BOT_TOKEN}` }
        });

        if (!resp.ok) {
          const text = await resp.text();
          return corsJson({ error: 'discord_error', status: resp.status, text }, resp.status, CORS_ORIGIN);
        }

        const json = await resp.json();

        // cache short time
        const resToCache = new Response(JSON.stringify(json), {
          headers: { 'Content-Type': 'application/json' }
        });
        // cache for 10s
        resToCache.headers.set('Cache-Control', 'public, max-age=10');
        await cache.put(cacheKey, resToCache.clone());

        return corsJson(normalizeMessages(json), 200, CORS_ORIGIN);
      }

      // Lookup registration messages like: REGISTER username|salt|hash|ts
      if (pathname === '/lookup' && request.method === 'GET') {
        const channelId = url.searchParams.get('channel_id');
        const username = url.searchParams.get('username');
        if (!channelId || !username) return corsJson({ error: 'missing channel_id or username' }, 400, CORS_ORIGIN);

        const discordUrl = `https://discord.com/api/v10/channels/${channelId}/messages?limit=200`;
        const BOT_TOKEN = env.BOT_TOKEN;
        if (!BOT_TOKEN) return corsJson({ error: 'server misconfigured' }, 500, CORS_ORIGIN);

        const resp = await fetch(discordUrl, { headers: { Authorization: `Bot ${BOT_TOKEN}` }});
        if (!resp.ok) return corsJson({ error: 'discord_error', status: resp.status }, resp.status, CORS_ORIGIN);
        const msgs = await resp.json();
        for (const m of msgs) {
          if (!m.content || !m.content.startsWith('REGISTER ')) continue;
          const rest = m.content.slice('REGISTER '.length).trim();
          const parts = rest.split('|');
          if (parts[0] === username) {
            return corsJson({
              found: true,
              messageId: m.id,
              channelId,
              raw: m.content,
              ts: m.timestamp || m.created_at || m.createdTimestamp
            }, 200, CORS_ORIGIN);
          }
        }
        return corsJson({ found: false }, 200, CORS_ORIGIN);
      }

      return corsJson({ error: 'not_found' }, 404, CORS_ORIGIN);
    } catch (err) {
      console.error(err);
      return corsJson({ error: 'server_error', detail: String(err) }, 500, CORS_ORIGIN);
    }
  }
};

function normalizeMessages(msgs) {
  // msgs is an array of Discord message objects (newest-first). Return newest-first normalized list.
  return msgs.map(m => ({
    id: m.id,
    content: m.content,
    timestamp: m.timestamp || m.created_at || new Date().toISOString(),
    author_name: m.author ? `${m.author.username}${m.author.discriminator ? '#' + m.author.discriminator : ''}` : 'Unknown',
    attachments: (m.attachments || []).map(a => ({ url: a.url, filename: a.filename || a.name || '', size: a.size || 0 }))
  }));
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function corsJson(obj, status = 200, origin = '*') {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(origin) };
  return new Response(JSON.stringify(obj), { status, headers });
}

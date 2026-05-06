// /api/social-post
//
// Admin-only social poster. Wraps Buffer's modern GraphQL API
// (https://api.buffer.com/graphql) — the legacy v1 REST API at
// api.bufferapp.com no longer accepts the OIDC bearer tokens Buffer
// hands out today.
//
// Actions (POST body):
//   { action: 'list-profiles' }
//     → returns connected Buffer channels (id, service, name)
//
//   { action: 'send', platform, copy, image_url?, scheduled_at? }
//     → schedules or publishes a post on the matching channel
//
//   { action: 'raw-query', query, variables? }
//     → escape hatch: arbitrary GraphQL query against Buffer for debug
//
// Buffer access token in env var BUFFER_ACCESS_TOKEN.

const BUFFER_GQL = 'https://api.buffer.com/graphql';

async function bufferQuery(query, variables, token) {
  const r = await fetch(BUFFER_GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, body: j, raw: text };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const auth = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) {
    return res.status(501).json({
      error: 'BUFFER_ACCESS_TOKEN not configured on Vercel',
      hint:  'Add BUFFER_ACCESS_TOKEN to project → settings → environment variables',
    });
  }

  const body = req.body || {};
  const action = String(body.action || '').toLowerCase() || 'send';

  try {
    // ── list-profiles via GraphQL ──────────────────────────────────────
    if (action === 'list-profiles') {
      // First get the organization, then channels under it.
      const orgQuery = `query { organizations { id name } }`;
      const orgRes = await bufferQuery(orgQuery, {}, token);
      if (!orgRes.ok || !orgRes.body || orgRes.body.errors) {
        return res.status(orgRes.status || 502).json({
          error: 'buffer organizations query failed',
          detail: (orgRes.body && orgRes.body.errors) || orgRes.raw.slice(0, 400),
        });
      }
      const orgs = (orgRes.body.data && orgRes.body.data.organizations) || [];
      if (!orgs.length) {
        return res.status(200).json({ ok: true, count: 0, profiles: [], note: 'no Buffer organizations found for this token' });
      }
      const orgId = orgs[0].id;

      const channelsQuery = `
        query Channels($organizationId: String!) {
          channels(input: { organizationId: $organizationId }) {
            id
            service
            name
            serviceType
            avatar
            timezone
          }
        }
      `;
      const chRes = await bufferQuery(channelsQuery, { organizationId: orgId }, token);
      if (!chRes.ok || !chRes.body || chRes.body.errors) {
        return res.status(chRes.status || 502).json({
          error: 'buffer channels query failed',
          detail: (chRes.body && chRes.body.errors) || chRes.raw.slice(0, 400),
          orgId,
        });
      }
      const channels = (chRes.body.data && chRes.body.data.channels) || [];
      const profiles = channels.map((c) => ({
        id: c.id,
        service: c.service,
        serviceType: c.serviceType,
        name: c.name,
        avatar: c.avatar,
        timezone: c.timezone,
      }));
      return res.status(200).json({ ok: true, organization: orgs[0], count: profiles.length, profiles });
    }

    // ── send via GraphQL ───────────────────────────────────────────────
    if (action === 'send') {
      const platform = String(body.platform || '').toLowerCase().trim();
      const copy = String(body.copy || '').trim();
      const image_url = body.image_url ? String(body.image_url).trim() : '';
      const scheduled_at = body.scheduled_at ? new Date(body.scheduled_at) : null;

      if (!platform) return res.status(400).json({ error: 'platform required (e.g. linkedin, instagram, twitter, threads, bluesky)' });
      if (!copy)     return res.status(400).json({ error: 'copy required' });

      // Look up channels and find the matching one
      const orgRes = await bufferQuery(`query { organizations { id } }`, {}, token);
      const orgId = orgRes.body && orgRes.body.data && orgRes.body.data.organizations && orgRes.body.data.organizations[0] && orgRes.body.data.organizations[0].id;
      if (!orgId) return res.status(502).json({ error: 'no organization in Buffer', detail: orgRes.body });

      const chRes = await bufferQuery(
        `query Channels($organizationId: String!) { channels(input: { organizationId: $organizationId }) { id service serviceType name } }`,
        { organizationId: orgId },
        token
      );
      const channels = (chRes.body && chRes.body.data && chRes.body.data.channels) || [];
      const target = channels.find((c) => {
        const svc = String(c.service || '').toLowerCase();
        if (platform === 'x' || platform === 'twitter') return svc === 'twitter';
        if (platform === 'ig' || platform === 'instagram' || platform === 'instagram-feed' || platform === 'instagram-reel') return svc === 'instagram';
        if (platform === 'linkedin' || platform === 'linkedin-page') return svc === 'linkedin';
        return svc === platform;
      });
      if (!target) {
        return res.status(404).json({
          error: `no Buffer channel for platform '${platform}'`,
          available: channels.map((c) => ({ service: c.service, name: c.name })),
        });
      }

      // createPost mutation
      const mutation = `
        mutation CreatePost($input: CreatePostInput!) {
          createPost(input: $input) {
            post { id status scheduledAt }
            ... on CreatePostError { reason }
          }
        }
      `;
      const input = {
        organizationId: orgId,
        channelIds: [target.id],
        content: { text: copy, ...(image_url ? { media: [{ url: image_url, type: 'image' }] } : {}) },
        ...(scheduled_at && !isNaN(scheduled_at.getTime())
          ? { scheduledAt: scheduled_at.toISOString() }
          : { schedulingType: 'NOW' }),
      };
      const sendRes = await bufferQuery(mutation, { input }, token);
      if (!sendRes.ok || !sendRes.body || sendRes.body.errors) {
        return res.status(sendRes.status || 502).json({
          error: 'buffer createPost failed',
          detail: (sendRes.body && sendRes.body.errors) || sendRes.raw.slice(0, 400),
          input,
        });
      }
      return res.status(200).json({
        ok: true,
        platform,
        scheduled: !!scheduled_at,
        result: sendRes.body.data,
      });
    }

    // ── raw-query — debug escape hatch ─────────────────────────────────
    if (action === 'raw-query') {
      const query = String(body.query || '').trim();
      if (!query) return res.status(400).json({ error: 'query required' });
      const r = await bufferQuery(query, body.variables || {}, token);
      return res.status(r.status).json({ ok: r.ok, body: r.body, raw: r.raw.slice(0, 2000) });
    }

    return res.status(400).json({ error: `unknown action: ${action}`, valid: ['list-profiles', 'send', 'raw-query'] });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'social-post failed' });
  }
}

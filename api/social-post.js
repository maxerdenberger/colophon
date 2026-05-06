// /api/social-post
//
// Admin-only social poster. Wraps Buffer's REST API so Cowork can:
//   POST { action: 'list-profiles' } → returns connected Buffer channels
//   POST { action: 'send', platform, copy, image_url?, scheduled_at? } →
//        creates a Buffer update on the matching profile (now or scheduled)
//   POST { action: 'analytics', profile_id } → recent sent posts + stats
//
// Buffer access token lives in env var BUFFER_ACCESS_TOKEN. Add it to
// Vercel project settings → environment variables.

const BUFFER_BASE = 'https://api.bufferapp.com/1';

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
    if (action === 'list-profiles') {
      const r = await fetch(`${BUFFER_BASE}/profiles.json?access_token=${encodeURIComponent(token)}`);
      const text = await r.text();
      let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
      if (!r.ok) {
        return res.status(r.status).json({ error: (j && j.error) || `buffer ${r.status}`, detail: j || text.slice(0, 200) });
      }
      const profiles = (j || []).map((p) => ({
        id: p.id,
        service: p.service,
        service_id: p.service_id,
        username: p.formatted_username || p.service_username || '',
        avatar: p.avatar,
        timezone: p.timezone,
      }));
      return res.status(200).json({ ok: true, count: profiles.length, profiles });
    }

    if (action === 'send') {
      const platform = String(body.platform || '').toLowerCase().trim();
      const copy = String(body.copy || '').trim();
      const image_url = body.image_url ? String(body.image_url).trim() : '';
      const scheduled_at = body.scheduled_at ? new Date(body.scheduled_at) : null;

      if (!platform) return res.status(400).json({ error: 'platform required (e.g. linkedin, instagram, twitter, threads, bluesky)' });
      if (!copy)     return res.status(400).json({ error: 'copy required' });

      const profilesRes = await fetch(`${BUFFER_BASE}/profiles.json?access_token=${encodeURIComponent(token)}`);
      const profilesText = await profilesRes.text();
      let profilesJson = null; try { profilesJson = profilesText ? JSON.parse(profilesText) : []; } catch {}
      if (!profilesRes.ok) return res.status(profilesRes.status).json({ error: 'buffer profiles fetch failed', detail: profilesJson });

      const target = (profilesJson || []).find((p) => {
        const svc = String(p.service || '').toLowerCase();
        if (platform === 'x' || platform === 'twitter') return svc === 'twitter';
        if (platform === 'ig' || platform === 'instagram' || platform === 'instagram-feed' || platform === 'instagram-reel') return svc === 'instagram' || svc === 'instagram_business';
        if (platform === 'linkedin' || platform === 'linkedin-page') return svc === 'linkedin' || svc === 'linkedin_company';
        return svc === platform;
      });
      if (!target) {
        const available = (profilesJson || []).map((p) => `${p.service}:${p.formatted_username || p.service_username}`).join(', ');
        return res.status(404).json({ error: `no Buffer profile for platform '${platform}'`, available });
      }

      const params = new URLSearchParams();
      params.append('access_token', token);
      params.append('text', copy);
      params.append('profile_ids[]', target.id);
      if (image_url) params.append('media[photo]', image_url);
      if (scheduled_at && !isNaN(scheduled_at.getTime())) {
        params.append('scheduled_at', Math.floor(scheduled_at.getTime() / 1000).toString());
      } else {
        params.append('now', 'true');
      }

      const r = await fetch(`${BUFFER_BASE}/updates/create.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const text = await r.text();
      let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
      if (!r.ok || !(j && j.success)) {
        return res.status(r.status || 502).json({
          error: (j && (j.message || j.error)) || `buffer create failed (${r.status})`,
          detail: j || text.slice(0, 200),
        });
      }

      const updates = (j.updates || []).map((u) => ({
        id: u.id,
        status: u.status,
        scheduled_at: u.scheduled_at ? u.scheduled_at * 1000 : null,
        profile_service: u.profile_service,
        text: u.text,
      }));
      return res.status(200).json({ ok: true, platform, scheduled: !!scheduled_at, updates });
    }

    if (action === 'analytics') {
      const profileId = String(body.profile_id || '').trim();
      if (!profileId) return res.status(400).json({ error: 'profile_id required (use action: list-profiles to find ids)' });
      const r = await fetch(`${BUFFER_BASE}/profiles/${encodeURIComponent(profileId)}/updates/sent.json?access_token=${encodeURIComponent(token)}&count=25`);
      const text = await r.text();
      let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
      if (!r.ok) return res.status(r.status).json({ error: 'buffer analytics failed', detail: j || text.slice(0, 200) });
      const posts = (j && j.updates || []).map((u) => ({
        id: u.id,
        sent_at: u.sent_at ? u.sent_at * 1000 : null,
        text: u.text,
        statistics: u.statistics || {},
        media: u.media || null,
      }));
      return res.status(200).json({ ok: true, count: posts.length, posts });
    }

    return res.status(400).json({ error: `unknown action: ${action}`, valid: ['list-profiles', 'send', 'analytics'] });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'social-post failed' });
  }
}

// /api/version
//
// Tiny endpoint that exposes the deployed git SHA + commit message so the
// admin UI can confirm 'this is the build that landed'. Reads from Vercel's
// auto-injected build env vars — no extra config needed.
//
// Returns:
//   {
//     sha:        '67ad8f2...',          full commit SHA
//     shortSha:   '67ad8f2',             first 7 chars
//     message:    'Align apply form...', first line of commit message
//     deploymentId: 'dpl_HZSk...',
//     env:        'production' | 'preview' | 'development',
//     deployedAt: '2026-05-21T20:14:00Z' (best-effort — we use process start)
//   }

const _bootTs = new Date().toISOString();

export default function handler(req, res) {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || 'local';
  const shortSha = sha === 'local' ? 'local' : sha.slice(0, 7);
  const message = process.env.VERCEL_GIT_COMMIT_MESSAGE || '';
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID || '';
  const env = process.env.VERCEL_ENV || 'development';
  // We don't have an authoritative "deployed at" — the lambda's cold-start
  // time is the best signal we get. It's accurate to within minutes of the
  // actual deploy time, since Vercel spins up a fresh function on each
  // deploy. Good enough for "is this the latest?" sanity checks.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    sha, shortSha, message, deploymentId, env,
    deployedAt: _bootTs,
    serverTime: new Date().toISOString(),
  });
}

import Stripe from 'stripe';
import { Resend } from 'resend';

const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend  = new Resend(process.env.RESEND_API_KEY);
const FROM    = 'Colophon <bench@colophon.contact>';
const SITE    = (process.env.SITE_URL || 'https://colophon.contact').replace(/\/$/, '');

const DURATION_DAYS = {
  'day-pass':   1,
  'week-pass':  7,
  'month-pass': 30,
};

const DURATION_LABEL = {
  'day-pass':   '24-hour',
  'week-pass':  '7-day',
  'month-pass': '30-day',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  }

  try {
    const { session_id } = req.body || {};
    if (!session_id) {
      return res.status(400).json({ error: 'session_id required' });
    }

    // Verify the session is paid before issuing a token. This is the security
    // boundary — without it, anyone could call /redeem with a fabricated id.
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: `payment not complete (status: ${session.payment_status})` });
    }

    const product = session.metadata?.product || 'day-pass';
    const days = DURATION_DAYS[product];
    if (!days) {
      // Concierge or unknown product — redeem doesn't apply
      return res.status(400).json({ error: `redeem only handles passes (got: ${product})` });
    }

    // Mint a base64 token compatible with the existing /access page checker:
    //   { exp: <ms epoch>, tier: 'day' | 'week' | 'month' }
    const expMs = Date.now() + days * 86_400_000;
    const tier  = product.replace('-pass', ''); // 'day' | 'week' | 'month'
    const token = Buffer.from(JSON.stringify({ exp: expMs, tier })).toString('base64');
    const accessUrl = `${SITE}/access?t=${encodeURIComponent(token)}`;

    const email = session.customer_details?.email || session.customer_email;

    // Send the colophon-branded confirmation. Failure here doesn't fail the
    // overall redeem — the token is still issued so the user can land on their
    // bench even if the email send hiccups.
    let emailSent = false;
    if (email && process.env.RESEND_API_KEY) {
      try {
        await resend.emails.send({
          from: FROM,
          to: email,
          subject: 'Your access is open.',
          html: confirmationHtml({ accessUrl, durationLabel: DURATION_LABEL[product], expMs }),
        });
        emailSent = true;
      } catch (e) {
        console.error('redeem email error:', e);
      }
    }

    return res.status(200).json({ token, accessUrl, email, emailSent });
  } catch (err) {
    console.error('redeem error:', err);
    return res.status(500).json({ error: err.message || 'redeem failed' });
  }
}

function confirmationHtml({ accessUrl, durationLabel, expMs }) {
  const expDate = new Date(expMs).toUTCString();
  return `
    <div style="background:#f4ede2;padding:56px 24px;font-family:Georgia,'Times New Roman',serif;color:#0d1014;">
      <div style="max-width:520px;margin:0 auto;">
        <p style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#5a5854;margin:0 0 24px;font-family:'IBM Plex Mono',ui-monospace,monospace;">Colophon — access</p>
        <p style="font-size:18px;line-height:1.6;margin:0 0 16px;">Your ${durationLabel} access to the directory is open.</p>
        <p style="font-size:16px;line-height:1.7;margin:0 0 28px;color:#0d1014;">Each entry lists the member, their portfolio, their rate, and their address. Correspondence is direct.</p>
        <p style="margin:0 0 32px;">
          <a href="${accessUrl}" style="display:inline-block;background:#0d1014;color:#f4ede2;padding:14px 22px;text-decoration:none;font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:12px;letter-spacing:0.08em;border-radius:6px;">view the directory →</a>
        </p>
        <p style="font-size:13px;line-height:1.7;margin:0 0 8px;color:#5a5854;">Access expires ${expDate}.</p>
        <p style="font-size:12px;line-height:1.7;margin:0;color:#5a5854;font-family:'IBM Plex Mono',ui-monospace,monospace;">Keep this email — the link above is your only copy.</p>
        <p style="font-size:13px;line-height:1.7;margin:32px 0 0;">— Colophon</p>
      </div>
    </div>`;
}

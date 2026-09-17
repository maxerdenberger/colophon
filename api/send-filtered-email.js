// /api/send-filtered-email — sends a custom email to filtered bench creatives.
//
//   POST {
//     discipline?: string,         // Filter by discipline (e.g., "copywriter")
//     availability?: string,       // Filter by availability (e.g., "Immediate")
//     minRate?: number,            // Filter by minimum hourly rate
//     maxRate?: number,            // Filter by maximum hourly rate
//     excludeStatus?: string[],    // Exclude certain statuses (e.g., ['booked'])
//     subject: string,             // Email subject
//     body: string,                // Email body (plain text)
//     dryRun?: bool
//   }
//
// Returns { sent, failed, dryRun, count, sample } where sample is first 5 recipients.
//
// Auth: Bearer ADMIN_KEY (or legacy ADMIN_SECRET, falls back to '590Rossmore').

import { Resend } from 'resend';
import { google } from 'googleapis';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM     = 'Colophon <noreply@colophon.contact>';
const REPLY_TO = 'noreply@colophon.contact';
const SLEEP_MS = 120;

const TAB_NAME  = process.env.SHEETS_TAB_NAME || 'Form Responses 1';
const RANGE_ALL = `${TAB_NAME}!A:Z`;

const COL = {
  TS: 0, 
  NAME: 1, 
  EMAIL: 2, 
  PORTFOLIO: 3,
  LINKEDIN: 4,
  DISC: 5, 
  OTHER_DISC: 6,
  AVAIL: 7,
  RATE_SECTION: 8,
  HOURLY: 9,
  MIN_FEE: 10,
  REFERRAL: 11, 
  STATUS: 18, 
  CONFIRMED: 20,
};

const operatorEmails = () =>
  new Set(
    (process.env.OPERATOR_EMAIL || 'merdenberger@gmail.com')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\"/g,'&quot;').replace(/'/g,'&#39;');
}

const BRAND_MARK = `
  <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 28px;">
    <tr>
      <td>
        <div style="display:inline-block;width:44px;height:44px;background:#f4f1ec;border:2px solid #0d0d0b;border-radius:50%;text-align:center;line-height:40px;vertical-align:middle;">
          <span style="display:inline-block;width:14px;height:14px;background:#ff5100;border-radius:50%;vertical-align:middle;"></span>
        </div>
      </td>
      <td style="padding-left:12px;font-family:'Space Grotesk',Georgia,serif;font-weight:700;font-size:16px;letter-spacing:-0.02em;color:#0d0d0b;vertical-align:middle;">
        colo<span style="color:#ff5100;">phon</span>
      </td>
    </tr>
  </table>`;

async function fetchFiltered(filters) {
  if (!process.env.SHEETS_SPREADSHEET_ID) throw new Error('SHEETS_SPREADSHEET_ID not set');
  
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key:   process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  
  const sheets = google.sheets({ version: 'v4', auth });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: RANGE_ALL,
  });
  
  const rows = r.data.values || [];
  const ops  = operatorEmails();
  const seen = new Set();
  const out  = [];
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const email = (row[COL.EMAIL] || '').trim().toLowerCase();
    
    if (!email || !email.includes('@')) continue;
    if (ops.has(email)) continue;
    if (seen.has(email)) continue;
    
    const status    = (row[COL.STATUS]    || '').trim().toLowerCase();
    const confirmed = (row[COL.CONFIRMED] || '').trim().toLowerCase();
    const isPending = status === '' || status === 'pending';
    const claimed   = confirmed === 'true' || confirmed === 'yes' || confirmed === '1';
    
    // Skip if not pending or already claimed
    if (!isPending || claimed) continue;
    
    // Apply filter: discipline
    if (filters.discipline) {
      const disciplines = [
        (row[COL.DISC] || '').trim(),
        (row[COL.OTHER_DISC] || '').trim(),
      ].filter(Boolean);
      const disciplineMatch = disciplines.some((d) => 
        d.toLowerCase().includes(filters.discipline.toLowerCase())
      );
      if (!disciplineMatch) continue;
    }
    
    // Apply filter: availability
    if (filters.availability) {
      const avail = (row[COL.AVAIL] || '').trim();
      if (!avail.toLowerCase().includes(filters.availability.toLowerCase())) {
        continue;
      }
    }
    
    // Apply filter: minimum hourly rate
    if (filters.minRate !== undefined && filters.minRate > 0) {
      const hourly = parseFloat(row[COL.HOURLY] || 0);
      if (hourly < filters.minRate) continue;
    }
    
    // Apply filter: maximum hourly rate
    if (filters.maxRate !== undefined && filters.maxRate > 0) {
      const hourly = parseFloat(row[COL.HOURLY] || 0);
      if (hourly > filters.maxRate) continue;
    }
    
    // Apply filter: exclude statuses
    if (filters.excludeStatus && Array.isArray(filters.excludeStatus)) {
      const excluded = filters.excludeStatus.some((s) => 
        status.toLowerCase().includes(s.toLowerCase())
      );
      if (excluded) continue;
    }
    
    seen.add(email);
    out.push({
      email,
      name: (row[COL.NAME] || '').trim(),
      discipline: (row[COL.DISC] || '').trim(),
      hourly: parseFloat(row[COL.HOURLY] || 0),
      availability: (row[COL.AVAIL] || '').trim(),
    });
  }
  
  return out;
}

function buildEmailHtml(recipientName, company, project, timeline, budget, mustHaves, smsNumber) {
  const firstName = recipientName ? esc(recipientName.split(/\s+/)[0]) : 'there';
  const smsText = smsNumber ? `Text INTERESTED to ${smsNumber}` : 'Reply to confirm interest';
  
  const html = `
    <div style="background:#f4ede2;padding:56px 24px;font-family:Georgia,'Times New Roman',serif;color:#0d1014;">
      <div style="max-width:520px;margin:0 auto;">
        ${BRAND_MARK}
        <p style="font-size:16px;line-height:1.7;margin:0 0 18px;">${firstName},</p>
        
        <p style="font-size:15px;line-height:1.7;margin:0 0 18px;"><strong>${esc(company)}</strong> is hiring for <strong>${esc(project)}</strong>.</p>
        
        <div style="font-size:15px;line-height:1.6;margin:0 0 18px;">
          <p style="margin:0 0 8px;"><strong>Project:</strong> ${esc(project)}</p>
          <p style="margin:0 0 8px;"><strong>Timeline:</strong> ${esc(timeline)}</p>
          <p style="margin:0 0 8px;"><strong>Budget:</strong> ${esc(budget)}</p>
          ${mustHaves ? `<p style="margin:0 0 8px;"><strong>Must-haves:</strong> ${esc(mustHaves)}</p>` : ''}
        </div>
        
        <p style="font-size:15px;line-height:1.7;margin:0 0 18px;">Interested? <strong>${smsText}</strong></p>
        <p style="font-size:13px;line-height:1.6;color:#2a2f36;margin:0 0 28px;">We'll connect you directly with the hiring manager.</p>
        
        <p style="font-size:15px;line-height:1.7;margin:28px 0 0;">— colophon</p>
      </div>
    </div>`;
  
  return html;
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
  
  if (!process.env.RESEND_API_KEY) {
    return res.status(501).json({ error: 'RESEND_API_KEY not set' });
  }
  
  const body = req.body || {};
  const company = String(body.company || '').trim();
  const project = String(body.project || '').trim();
  const timeline = String(body.timeline || '').trim();
  const budget = String(body.budget || '').trim();
  const mustHaves = String(body.mustHaves || '').trim();
  const dryRun = !!body.dryRun;
  const smsNumber = String(body.smsNumber || '').trim();
  
  if (!company || !project || !timeline || !budget) {
    return res.status(400).json({ error: 'company, project, timeline, and budget are required' });
  }
  
  const filters = {
    discipline: body.discipline ? String(body.discipline).trim() : undefined,
    availability: body.availability ? String(body.availability).trim() : undefined,
    minRate: body.minRate ? parseFloat(body.minRate) : undefined,
    maxRate: body.maxRate ? parseFloat(body.maxRate) : undefined,
    excludeStatus: Array.isArray(body.excludeStatus) ? body.excludeStatus : undefined,
  };
  
  let recipients;
  try {
    recipients = await fetchFiltered(filters);
  } catch (err) {
    return res.status(500).json({ error: 'fetch: ' + (err.message || 'failed') });
  }
  
  if (recipients.length === 0) {
    return res.status(200).json({
      dryRun: true,
      count: 0,
      sent: 0,
      failed: [],
      sample: [],
      message: 'No recipients matched the filters.',
    });
  }
  
  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      count: recipients.length,
      sent: 0,
      failed: [],
      sample: recipients.slice(0, 5),
    });
  }
  
  let sent = 0;
  const failed = [];
  const emailSubject = `${company} – ${project}`;
  const plainTextBody = `Hi [Name],\n\n${company} is hiring for ${project}.\n\nProject: ${project}\nTimeline: ${timeline}\nBudget: ${budget}\n${mustHaves ? `Must-haves: ${mustHaves}\n` : ''}\nInterested? Text INTERESTED to [SMS #]\nWe'll connect you directly with the hiring manager.\n\n— Colophon`;
  
  for (const recipient of recipients) {
    const html = buildEmailHtml(recipient.name, company, project, timeline, budget, mustHaves, smsNumber);
    
    try {
      await resend.emails.send({
        from: FROM,
        to: recipient.email,
        replyTo: REPLY_TO,
        subject: emailSubject,
        html: html,
        text: plainTextBody,
      });
      sent++;
    } catch (err) {
      failed.push({ email: recipient.email, error: err.message || 'send failed' });
    }
    
    if (SLEEP_MS) await new Promise((res2) => setTimeout(res2, SLEEP_MS));
  }
  
  return res.status(200).json({
    dryRun: false,
    count: recipients.length,
    sent,
    failed,
    sample: recipients.slice(0, 5),
  });
}

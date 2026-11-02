// Vercel serverless function: forwards a finished questionnaire to Shmuel's Google Sheet.
// The Apps Script URL (env SHEET_WEBHOOK_URL) stays on the server, out of the public repo.

const FIELDS = ['biz', 'person', 'phone', 'email', 'field', 'type', 'total', 'model', 'summary', 'chat'];
const MAX = { summary: 8000, chat: 20000 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const url = process.env.SHEET_WEBHOOK_URL;
  if (!url) return res.status(500).json({ error: 'missing_sheet_url' });

  const b = req.body || {};
  if (!b.summary) return res.status(400).json({ error: 'bad_request' });
  const row = {};
  for (const k of FIELDS) row[k] = String(b[k] == null ? '' : b[k]).slice(0, MAX[k] || 300);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('sheet ' + r.status);
  } catch (e) {
    console.error('lead', e.message);
    return res.status(502).json({ error: 'sheet_failed' });
  }
  res.status(200).json({ ok: true });
}

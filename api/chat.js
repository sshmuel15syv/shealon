// Vercel serverless function: the questionnaire's AI assistant.
// Holds the Gemini key (env GEMINI_API_KEY) so it never reaches the browser.
// The page sends the chat history, the list of form fields and their current values;
// Gemini answers with the next question plus which fields to fill. Prices are never
// decided here: the page calculates them from the filled form.

import fs from 'node:fs';
import path from 'node:path';

// Tried in order: when one is overloaded, retired or slow, the next one answers.
const MODELS = (process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.5-flash,gemini-flash-lite-latest')
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_MESSAGES = 60;
const MAX_TEXT = 2000;

// Shmuel's own instructions (tone, knowledge, FAQ) live in assistant-instructions.md so he can
// edit them without touching code. HTML comments in that file are notes to him, not to the model.
const INSTRUCTIONS = fs.readFileSync(path.join(process.cwd(), 'assistant-instructions.md'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '').trim();

// Rules the page depends on. They stay here so an edit to the instructions can't break the form.
const SYSTEM = INSTRUCTIONS + `

## כללים טכניים (חובה)
- כשהשיחה הסתיימה (הלקוח אמר שאין לו עוד מה להוסיף), סמן done=true.

איך למלא שדות (updates):
- field הוא ה-id של השדה מהרשימה למטה, בדיוק.
- בשדה מסוג choice: ערך אחד, מילה במילה מתוך options.
- בשדה מסוג multi: כל הערכים שצריכים להיות מסומנים (הרשימה המלאה, לא רק מה שנוסף), מילה במילה מתוך options.
- בשדה מסוג text: ערך אחד, טקסט חופשי וקצר.
- אל תמציא פרטים שהלקוח לא אמר.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    updates: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          field: { type: 'STRING' },
          values: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['field', 'values'],
      },
    },
    done: { type: 'BOOLEAN' },
  },
  required: ['reply', 'updates', 'done'],
};

export default async function handler(req, res) {
  const key = process.env.GEMINI_API_KEY;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!key) return res.status(500).json({ error: 'missing_key' });

  const { messages, fields, state } = req.body || {};
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES || !Array.isArray(fields))
    return res.status(400).json({ error: 'bad_request' });
  const fieldsJson = JSON.stringify(fields);
  const stateJson = JSON.stringify(state || {});
  if (fieldsJson.length > 20000 || stateJson.length > 20000) return res.status(400).json({ error: 'too_large' });

  const contents = messages
    .map(m => ({ role: m && m.role === 'model' ? 'model' : 'user', parts: [{ text: String((m && m.text) || '').slice(0, MAX_TEXT) }] }))
    .filter(c => c.parts[0].text);
  while (contents.length && contents[0].role === 'model') contents.shift();
  if (!contents.length || contents[contents.length - 1].role !== 'user') return res.status(400).json({ error: 'bad_request' });

  const system = { parts: [{ text: SYSTEM + '\n\nשדות השאלון:\n' + fieldsJson + '\n\nמה שכבר מלא כרגע:\n' + stateJson }] };
  const bodyFor = model => {
    const generationConfig = { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.6 };
    if (model.startsWith('gemini-3')) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    return JSON.stringify({ systemInstruction: system, contents, generationConfig });
  };

  // Move to the next model when one is rate-limited (429), overloaded (503), retired (404)
  // or slow (15s cap). Free-tier limits are per model, so the next one usually has room.
  let r, model;
  for (model of MODELS) {
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: bodyFor(model),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      r = null;
    }
    if (r && ![429, 503, 404].includes(r.status)) break;
    console.error('gemini', model, r ? r.status : 'timeout');
  }
  if (!r) return res.status(503).json({ error: 'busy', reason: 'timeout' });
  if (!r.ok) {
    const detail = await r.text();
    console.error('gemini', r.status, detail.slice(0, 500));
    let reason = '';
    try { const e = JSON.parse(detail).error; reason = e.status + ': ' + String(e.message).slice(0, 200); } catch (e) {}
    const busy = r.status === 429 || r.status === 503;
    return res.status(busy ? r.status : 502).json({ error: busy ? 'busy' : 'upstream_error', reason });
  }

  let out;
  try {
    const data = await r.json();
    const text = data.candidates[0].content.parts.map(p => p.text || '').join('');
    out = JSON.parse(text);
  } catch (e) {
    return res.status(502).json({ error: 'bad_upstream_reply' });
  }

  // Only let through updates for fields the page actually has.
  const ids = new Set(fields.map(f => f && f.id));
  const updates = (Array.isArray(out.updates) ? out.updates : [])
    .filter(u => u && ids.has(u.field) && Array.isArray(u.values))
    .map(u => ({ field: u.field, values: u.values.map(v => String(v).slice(0, 500)).slice(0, 20) }));

  res.status(200).json({ reply: String(out.reply || '').slice(0, 3000), updates, done: !!out.done, model });
}

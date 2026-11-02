// Vercel serverless function: the questionnaire's AI assistant.
// Holds the Gemini key (env GEMINI_API_KEY) so it never reaches the browser.
// The page sends the chat history, the list of form fields and their current values;
// Gemini answers with the next question plus which fields to fill. Prices are never
// decided here: the page calculates them from the filled form.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MAX_MESSAGES = 60;
const MAX_TEXT = 2000;

const SYSTEM = `אתה העוזר הדיגיטלי של שמואל, שבונה דפי נחיתה ואתרים לעסקים קטנים.
התפקיד שלך: לנהל עם הלקוח שיחה קצרה ונעימה בעברית, ולמלא בשבילו שאלון אפיון.

איך לנהל את השיחה:
- כבר פתחת בברכה ושאלת על שם העסק ותחומו. אל תציג את עצמך שוב.
- שאל שאלה אחת בכל פעם (לכל היותר שתיים קשורות), במשפט או שניים. בלי רשימות ארוכות.
- דבר בגובה העיניים, בלי מונחים טכניים. אם הלקוח לא מבין משהו, הסבר בפשטות.
- כשהלקוח מספר משהו, מלא מיד את כל השדות שאפשר להסיק ממנו, גם כאלה שלא שאלת עליהם.
- אל תשאל על שדה שכבר מלא, אלא אם צריך לוודא משהו.
- אפשר להציע אפשרויות מתוך הרשימות, כדי שיהיה ללקוח קל לענות.
- סדר נושאים מומלץ: העסק ← מה הדף צריך להשיג וקהל היעד ← אילו אזורים בדף ← טקסטים ← עיצוב (לוגו, צבעים, סגנון) ← פרטי יצירת קשר שיופיעו בדף ← תמונות, דומיין, תוספות ודדליין.
- אל תנקוב במחירים ואל תבטיח הנחות. המחיר מחושב אוטומטית בסוף לפי השאלון, ושמואל מאשר אותו.
- אם הלקוח שואל משהו שלא קשור, ענה בקצרה והחזר בעדינות לשאלון.
- אם הלקוח לא יודע או לא רוצה לענות, דלג הלאה.
- כשכיסית את הנושאים העיקריים, שאל אם יש עוד משהו שחשוב לו. כשהוא אומר שלא, סיים במשפט קצר שמזמין אותו לראות את הסיכום והמחיר, וסמן done=true.

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
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const key = process.env.GEMINI_API_KEY;
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

  const generationConfig = { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.6 };
  if (MODEL.startsWith('gemini-2.5-flash')) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else if (MODEL.startsWith('gemini-3')) generationConfig.thinkingConfig = { thinkingLevel: 'low' };

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM + '\n\nשדות השאלון:\n' + fieldsJson + '\n\nמה שכבר מלא כרגע:\n' + stateJson }] },
    contents,
    generationConfig,
  };

  // One retry when Gemini is overloaded (503) or slow; each try is capped at 20s.
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      r = null;
    }
    if (r && r.status !== 503) break;
    if (attempt === 0) await new Promise(ok => setTimeout(ok, 1500));
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

  res.status(200).json({ reply: String(out.reply || '').slice(0, 3000), updates, done: !!out.done });
}

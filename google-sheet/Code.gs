// Google Apps Script: receives questionnaire inquiries from api/lead.js and adds a row to the
// "פניות" tab of the spreadsheet it is attached to. Deploy as a web app (Execute as: Me,
// Who has access: Anyone) and put its URL in Vercel as SHEET_WEBHOOK_URL.

const TAB = 'פניות';
const HEADERS = ['תאריך', 'שם העסק', 'איש קשר', 'טלפון', 'מייל', 'תחום', 'סוג', 'מחיר משוער', 'מודל AI', 'סיכום', 'השיחה עם העוזר'];

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setRightToLeft(true);
  }
  // A leading ' keeps Sheets from treating a phone number or "=..." text as a number or formula.
  const cell = v => "'" + String(v || '');
  sheet.appendRow([new Date(), cell(d.biz), cell(d.person), cell(d.phone), cell(d.email), cell(d.field),
    cell(d.type), d.total || '', cell(d.model), cell(d.summary), cell(d.chat)]);
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}

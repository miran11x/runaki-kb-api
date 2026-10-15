// Translation review of the live FAQs, for a native Sorani / Badini speaker.
//  GET  /api/admin/translation-review         QA / lead  downloads an .xlsx: every FAQ question and answer, English beside Sorani and Badini
//         ?category=Billing%20Complaints  only one category   ·   ?gaps=1  only FAQs missing a Sorani or Badini text
//  POST /api/admin/translation-review/apply   QA / lead  {changes:[{faq_id, part:'question'|'answer', lang:'ku'|'ba', text}], dry:true}
//         dry = preview (old text vs new text); without dry the corrected texts are saved on the FAQs
const ExcelJS = require('exceljs');

const STAFF = ['qa_officer', 'team_lead'];
const clean = v => (v == null ? '' : String(v));
const PARTS = ['question', 'answer'];
const LANGS = ['ku', 'ba'];

module.exports = function mountTranslationReview(app, pool, authMiddleware) {
  app.get('/api/admin/translation-review', authMiddleware(STAFF), async (req, res) => {
    try {
      const cat = clean(req.query.category).trim();
      const gaps = req.query.gaps === '1';
      const qr = await pool.query(
        `SELECT id, category, subcategory, question_en, answer_en, question_ku, answer_ku, question_ba, answer_ba, question_ar, answer_ar
           FROM faqs WHERE is_published = true AND ($1 = '' OR category = $1) ORDER BY category, subcategory, id`, [cat]);
      let faqs = qr.rows;
      if (gaps) faqs = faqs.filter(f => !clean(f.question_ku).trim() || !clean(f.answer_ku).trim() || !clean(f.question_ba).trim() || !clean(f.answer_ba).trim());

      const wb = new ExcelJS.Workbook();
      wb.creator = 'Runaki KB'; wb.created = new Date();
      const A = { name: 'Arial', size: 11 };
      const thin = { style: 'thin', color: { argb: 'FFD0D7DE' } };
      const border = { top: thin, left: thin, bottom: thin, right: thin };
      const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

      // ---- Review sheet ----
      const ws = wb.addWorksheet('Review', { views: [{ state: 'frozen', xSplit: 4, ySplit: 1 }], properties: { tabColor: { argb: 'FF10B981' } } });
      const cols = [
        ['FAQ ID', 8], ['Category', 20], ['Part', 11], ['English (original)', 48],
        ['Sorani: current text', 48], ['Sorani: status', 17], ['Sorani: corrected text', 48],
        ['Badini: current text', 48], ['Badini: status', 17], ['Badini: corrected text', 48],
        ['Notes', 28], ['Arabic (reference only)', 40],
      ];
      ws.columns = cols.map(([header, width]) => ({ header, width }));
      const head = ws.getRow(1); head.height = 34;
      head.eachCell((c, i) => {
        c.font = { ...A, bold: true, color: { argb: 'FFFFFFFF' } };
        c.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
        c.border = border;
        c.fill = fill(i >= 5 && i <= 7 ? 'FF2E7D32' : i >= 8 && i <= 10 ? 'FF1565C0' : 'FF0B1120');
      });
      let n = 1; let sorMissing = 0, badMissing = 0;
      for (const f of faqs) {
        for (const part of PARTS) {
          const en = clean(f[`${part}_en`]), ku = clean(f[`${part}_ku`]).trim(), ba = clean(f[`${part}_ba`]).trim(), ar = clean(f[`${part}_ar`]);
          if (!en.trim() && !ku && !ba) continue;
          const row = ws.addRow([f.id, [f.category, f.subcategory].filter(Boolean).join(' › '), part === 'question' ? 'Question' : 'Answer', en, ku, ku ? null : 'Missing translation', null, ba, ba ? null : 'Missing translation', null, null, ar]);
          n++;
          if (!ku) sorMissing++; if (!ba) badMissing++;
          row.eachCell({ includeEmpty: true }, (c, i) => {
            c.font = { ...A, size: i === 12 ? 10 : 11, color: { argb: i === 12 ? 'FF666666' : 'FF000000' } };
            c.border = border;
            const rtl = [5, 7, 8, 10, 12].includes(i);
            c.alignment = rtl ? { wrapText: true, vertical: 'top', horizontal: 'right', readingOrder: 'rtl' } : { wrapText: true, vertical: 'top', horizontal: [6, 9].includes(i) ? 'center' : 'left' };
            if (i === 5) c.fill = fill('FFE8F5E9');
            else if (i === 8) c.fill = fill('FFE3F2FD');
            else if ([6, 7, 9, 10, 11].includes(i)) c.fill = fill('FFFFF9C4');
            else if (i === 12) c.fill = fill('FFF3F4F6');
          });
          const longest = Math.max(en.length, ku.length, ba.length);
          row.height = Math.max(34, Math.min(300, 15.5 * (Math.ceil(longest / 40) + (en.split('\n').length - 1))));
          for (const col of ['F', 'I']) row.getCell(col).dataValidation = { type: 'list', allowBlank: true, formulae: ['"OK,Needs change,Missing translation"'] };
        }
      }
      const last = Math.max(2, n);
      ws.autoFilter = { from: 'A1', to: `L${last}` };
      for (const ref of [`F2:F${last}`, `I2:I${last}`]) {
        ws.addConditionalFormatting({ ref, rules: [
          { type: 'cellIs', operator: 'equal', formulae: ['"Needs change"'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFCDD2' } } } },
          { type: 'cellIs', operator: 'equal', formulae: ['"Missing translation"'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFE0B2' } } } },
          { type: 'cellIs', operator: 'equal', formulae: ['"OK"'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFC8E6C9' } } } },
        ] });
      }
      ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };

      // ---- How to review sheet (first tab) ----
      const hs = wb.addWorksheet('How to review', { views: [{ showGridLines: false }], properties: { tabColor: { argb: 'FFFF6B35' } } });
      wb.views = [{ activeTab: 0 }];
      hs.columns = [{ width: 3 }, { width: 34 }, { width: 80 }];
      const put = (r, c, v, o = {}) => { const cell = hs.getCell(r, c); cell.value = v; cell.font = { name: 'Arial', size: o.size || 11, bold: !!o.bold, color: { argb: o.color || 'FF000000' } }; cell.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' }; return cell; };
      put(2, 2, 'Runaki Knowledge Base: FAQ Kurdish wording review', { size: 16, bold: true });
      put(3, 2, `Exported ${new Date().toISOString().slice(0, 10)} · ${faqs.length} FAQs · ${cat || 'all categories'}${gaps ? ' · only FAQs with a missing Sorani or Badini text' : ''}`, { color: 'FF555555' });
      let r = 5; put(r++, 2, 'What to do', { size: 12, bold: true });
      [['Step 1', 'Open the "Review" tab. Each FAQ has two rows: its Question and its Answer, with the English original beside the Sorani and Badini texts.'],
       ['Step 2', 'Read the Sorani text. In the yellow status cell choose "OK" or "Needs change". Rows marked "Missing translation" have no Kurdish text yet.'],
       ['Step 3', 'If it needs a change, or is missing, type the full corrected text in the yellow "corrected text" cell (the whole sentence or answer, keep line breaks and bullets).'],
       ['Step 4', 'Do the same for Badini in its own yellow cells. Use Notes for anything we should know.'],
       ['Step 5', 'Do not change the FAQ ID column or the Part column. QA uses them to put your corrections back into the right FAQ.'],
       ['Step 6', 'Send the file back to QA. The Arabic column is for reference only.']].forEach(([a, b]) => { put(r, 2, a, { bold: true }); put(r, 3, b); hs.getRow(r).height = 34; r++; });
      r++; put(r++, 2, 'What to look for', { size: 12, bold: true });
      ['Natural wording: would an agent in Erbil (Sorani) or Duhok (Badini) really say this on a call?', 'Correct meaning: the Kurdish says the same thing as the English.',
       'Respectful, consistent tone with the customer.', 'Letters: ە ێ ڵ ڕ ۆ are used correctly (and ڤ in Badini).',
       'Words in [square brackets] are placeholders. Keep them. Words in English letters (Runaki, KYC, SMS, BNF) stay as they are.'].forEach(t => { put(r, 3, '• ' + t); hs.getRow(r).height = 30; r++; });
      r++; put(r++, 2, 'Progress', { size: 12, bold: true });
      const rows = Math.max(0, n - 1);
      [['Texts to review', `COUNTA(Review!A2:A${last})`, rows], ['Sorani checked', `COUNTIF(Review!F2:F${last},"OK")+COUNTIF(Review!F2:F${last},"Needs change")`, 0],
       ['Sorani still missing', `COUNTIF(Review!F2:F${last},"Missing translation")`, sorMissing], ['Badini checked', `COUNTIF(Review!I2:I${last},"OK")+COUNTIF(Review!I2:I${last},"Needs change")`, 0],
       ['Badini still missing', `COUNTIF(Review!I2:I${last},"Missing translation")`, badMissing]].forEach(([lab, f, res]) => { put(r, 2, lab, { bold: true }); hs.getCell(r, 3).value = { formula: f, result: res }; hs.getCell(r, 3).font = A; hs.getCell(r, 3).alignment = { horizontal: 'left' }; r++; });
      // the instructions come first when the file opens
      hs.orderNo = 0; ws.orderNo = 1; wb.views = [{ activeTab: 0 }];

      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Runaki_FAQ_Kurdish_Review_${stamp}.xlsx"`);
      await wb.xlsx.write(res); res.end();
    } catch (err) { console.error('translation export:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });

  app.post('/api/admin/translation-review/apply', authMiddleware(STAFF), async (req, res) => {
    try {
      const list = (Array.isArray(req.body.changes) ? req.body.changes : []).slice(0, 4000)
        .map(c => ({ faq_id: parseInt(c.faq_id, 10), part: String(c.part || '').toLowerCase(), lang: String(c.lang || '').toLowerCase(), text: clean(c.text).replace(/\r\n/g, '\n').trim() }))
        .filter(c => c.faq_id && PARTS.includes(c.part) && LANGS.includes(c.lang) && c.text);
      if (!list.length) return res.json({ dry: !!req.body.dry, changes: [], applied: 0, skipped: 0 });
      const ids = [...new Set(list.map(c => c.faq_id))];
      const cur = await pool.query('SELECT id, question_ku, answer_ku, question_ba, answer_ba FROM faqs WHERE id = ANY($1)', [ids]);
      const byId = new Map(cur.rows.map(r => [r.id, r]));
      const out = []; let skipped = 0;
      for (const c of list) {
        const row = byId.get(c.faq_id); if (!row) { skipped++; continue; }
        const col = `${c.part}_${c.lang}`;
        const old = clean(row[col]).trim();
        if (old === c.text) { skipped++; continue; }
        out.push({ faq_id: c.faq_id, part: c.part, lang: c.lang, col, old, text: c.text });
      }
      if (req.body.dry) return res.json({ dry: true, changes: out, applied: 0, skipped });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const c of out) await client.query(`UPDATE faqs SET ${c.col} = $1, updated_by = $2, updated_at = NOW() WHERE id = $3`, [c.text, req.user.id, c.faq_id]);
        await client.query(`INSERT INTO activity_log(user_id, action, details) VALUES($1,'TRANSLATION_REVIEW',$2)`, [req.user.id, `Applied ${out.length} reviewed Kurdish texts to ${new Set(out.map(c => c.faq_id)).size} FAQs`]).catch(() => {});
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      res.json({ dry: false, changes: [], applied: out.length, skipped });
    } catch (err) { console.error('translation apply:', err.message); res.status(500).json({ error: err.message }); }
  });
};

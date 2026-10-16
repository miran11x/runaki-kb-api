// "Translation quest": review the translated Shortlisted FAQ's one by one (Sorani, Badini, Arabic).
//  GET  /api/admin/translation-quest              the shortlisted FAQs (document order) + who reviewed what
//  PUT  /api/admin/translation-quest/:id          { lang, question, answer }  edit one translation (auto-saved from the page)
//  POST /api/admin/translation-quest/:id/review   { lang, reviewed }          tick / untick "this translation is checked"
// Editing a translation clears its tick, so a changed text always has to be confirmed again.
const STAFF = ['qa_officer', 'team_lead'];
const LANGS = ['ku', 'ba', 'ar'];

module.exports = function mountTranslationQuest(app, pool, authMiddleware) {
  let ready = null;
  const ensure = () => (ready || (ready = (async () => {
    await pool.query(`ALTER TABLE faqs ADD COLUMN IF NOT EXISTS is_shortlisted BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE faqs ADD COLUMN IF NOT EXISTS shortlist_pos INTEGER`);
    await pool.query(`CREATE TABLE IF NOT EXISTS faq_translation_reviews (faq_id INTEGER NOT NULL, lang TEXT NOT NULL, reviewed_by INTEGER, reviewed_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (faq_id, lang))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS faq_content_backups (id SERIAL PRIMARY KEY, faq_id INTEGER NOT NULL, data JSONB, reason TEXT, created_at TIMESTAMP DEFAULT NOW())`);
  })().catch(e => { ready = null; throw e; })));
  const wrap = fn => async (req, res) => { try { await ensure(); await fn(req, res); } catch (e) { console.error('translation quest:', e.message); res.status(500).json({ error: e.message }); } };

  app.get('/api/admin/translation-quest', authMiddleware(STAFF), wrap(async (req, res) => {
    const f = await pool.query(`SELECT id, shortlist_pos, question_en, answer_en, question_ku, answer_ku, question_ba, answer_ba, question_ar, answer_ar
      FROM faqs WHERE COALESCE(is_shortlisted,false) = true ORDER BY shortlist_pos NULLS LAST, id`);
    const r = await pool.query(`SELECT r.faq_id, r.lang, r.reviewed_at, u.name FROM faq_translation_reviews r LEFT JOIN users u ON u.id = r.reviewed_by
      WHERE r.faq_id = ANY($1::int[])`, [f.rows.map(x => x.id)]);
    res.json({
      faqs: f.rows.map(x => ({ id: x.id, pos: x.shortlist_pos, question_en: x.question_en, answer_en: x.answer_en,
        ku: { q: x.question_ku || '', a: x.answer_ku || '' }, ba: { q: x.question_ba || '', a: x.answer_ba || '' }, ar: { q: x.question_ar || '', a: x.answer_ar || '' } })),
      reviews: r.rows,
    });
  }));

  app.put('/api/admin/translation-quest/:id', authMiddleware(STAFF), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10), lang = req.body.lang;
    if (!Number.isFinite(id) || !LANGS.includes(lang)) return res.status(400).json({ error: 'Bad request' });
    const q = String(req.body.question ?? ''), a = String(req.body.answer ?? '');
    if (q.length > 2000 || a.length > 60000) return res.status(400).json({ error: 'Text is too long' });
    // keep a copy of the text before the first edit of a session (not on every autosave)
    await pool.query(`INSERT INTO faq_content_backups (faq_id, data, reason)
      SELECT id, to_jsonb(f), 'translation-quest' FROM faqs f WHERE id = $1
        AND NOT EXISTS (SELECT 1 FROM faq_content_backups b WHERE b.faq_id = $1 AND b.reason = 'translation-quest' AND b.created_at > NOW() - INTERVAL '6 hours')`, [id]);
    const r = await pool.query(`UPDATE faqs SET question_${lang} = $2, answer_${lang} = $3, updated_at = NOW() WHERE id = $1 RETURNING id`, [id, q, a]);
    if (!r.rowCount) return res.status(404).json({ error: 'FAQ not found' });
    await pool.query(`DELETE FROM faq_translation_reviews WHERE faq_id = $1 AND lang = $2`, [id, lang]);
    res.json({ success: true });
  }));

  app.post('/api/admin/translation-quest/:id/review', authMiddleware(STAFF), wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10), lang = req.body.lang;
    if (!Number.isFinite(id) || !LANGS.includes(lang)) return res.status(400).json({ error: 'Bad request' });
    if (req.body.reviewed === false) await pool.query(`DELETE FROM faq_translation_reviews WHERE faq_id = $1 AND lang = $2`, [id, lang]);
    else await pool.query(`INSERT INTO faq_translation_reviews (faq_id, lang, reviewed_by) VALUES ($1,$2,$3)
      ON CONFLICT (faq_id, lang) DO UPDATE SET reviewed_by = EXCLUDED.reviewed_by, reviewed_at = NOW()`, [id, lang, req.user.id]);
    res.json({ success: true });
  }));
};

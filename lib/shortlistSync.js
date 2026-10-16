// Keep the Shortlisted FAQ's in line with the master Word document.
//  POST /api/admin/shortlist-sync/preview  staff  { file: <base64 .docx> }  -> what would change (nothing is changed)
//  POST /api/admin/shortlist-sync/apply    staff  { shortlist:[id], answers:[{id,answer}], unshortlist:[id], create:[{question,answer,category}] }
// Answers that get replaced are first copied to faq_answer_backups, so nothing is lost.
const { parseFaqDocx } = require('./docxFaq');

const STAFF = ['qa_officer', 'team_lead'];
const CATEGORIES = ['Inquiries', 'Billing Complaints', 'General Complaints', 'Service Requests', 'Feedback & Others', 'New Updates'];

const norm = s => String(s || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/&/g, ' and ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = s => new Set(norm(s).split(' ').filter(Boolean));
const jac = (a, b) => { const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0; let i = 0; A.forEach(t => { if (B.has(t)) i++; }); return i / (A.size + B.size - i); };
const plain = s => norm(String(s || '').replace(/\*\*/g, '').replace(/[•◦▪]/g, ' '));

module.exports = function mountShortlistSync(app, pool, authMiddleware) {
  let ready = null;
  const ensure = () => (ready || (ready = pool.query(`
    ALTER TABLE faqs ADD COLUMN IF NOT EXISTS is_shortlisted BOOLEAN DEFAULT false;
    CREATE TABLE IF NOT EXISTS faq_answer_backups (id SERIAL PRIMARY KEY, faq_id INTEGER NOT NULL, answer_en TEXT, replaced_by INTEGER, replaced_at TIMESTAMP DEFAULT NOW());
  `).catch(e => { ready = null; throw e; })));
  const wrap = fn => async (req, res) => { try { await ensure(); await fn(req, res); } catch (e) { console.error('shortlist sync:', e.message); res.status(500).json({ error: e.message }); } };
  const has = c => `(COALESCE(TRIM(question_${c}),'') <> '' AND COALESCE(TRIM(answer_${c}),'') <> '')`;

  app.post('/api/admin/shortlist-sync/preview', authMiddleware(STAFF), wrap(async (req, res) => {
    const b64 = String(req.body.file || '').replace(/^data:[^,]*,/, '');
    if (!b64) return res.status(400).json({ error: 'No file received' });
    let items;
    try { items = await parseFaqDocx(Buffer.from(b64, 'base64')); } catch (e) { return res.status(400).json({ error: 'Could not read this Word file. Please upload the .docx again.' }); }
    if (!items.length) return res.status(400).json({ error: 'No FAQs found. Each FAQ must start with a heading like “FAQ1: Question?”.' });
    const faqs = (await pool.query(`SELECT id, question_en, answer_en, category, COALESCE(is_shortlisted,false) AS is_shortlisted,
        ${has('ku')} AS ku, ${has('ba')} AS ba, ${has('ar')} AS ar FROM faqs`)).rows;
    const byNorm = new Map(); faqs.forEach(f => { const k = norm(f.question_en); if (!byNorm.has(k)) byNorm.set(k, f); });

    // exact matches first, then the closest unclaimed question (shown as "close" so the user checks it)
    const taken = new Set(); const out = items.map(it => ({ ...it, match: null }));
    out.forEach(o => { const f = byNorm.get(norm(o.question)); if (f && !taken.has(f.id)) { taken.add(f.id); o.match = { f, kind: 'exact', score: 1 }; } });
    out.filter(o => !o.match).forEach(o => {
      let best = null, sc = 0;
      faqs.forEach(f => { if (taken.has(f.id)) return; const s = jac(o.question, f.question_en); if (s > sc) { sc = s; best = f; } });
      if (best && sc >= 0.72) { taken.add(best.id); o.match = { f: best, kind: 'close', score: sc }; }
    });

    const rows = out.map(o => {
      const f = o.match && o.match.f;
      let answerStatus = null, sim = null;
      if (f) { answerStatus = plain(f.answer_en) === plain(o.answer) ? 'same' : 'different'; sim = answerStatus === 'same' ? 1 : jac(f.answer_en, o.answer); }
      return {
        no: o.no, question: o.question, answer: o.answer,
        match: f ? { id: f.id, question_en: f.question_en, category: f.category, is_shortlisted: f.is_shortlisted, kind: o.match.kind, score: Math.round(o.match.score * 100), translated: !!(f.ku || f.ba || f.ar) } : null,
        answerStatus, answerSimilarity: sim == null ? null : Math.round(sim * 100), currentAnswer: f && answerStatus === 'different' ? f.answer_en : null,
      };
    });
    const notInDoc = faqs.filter(f => f.is_shortlisted && !taken.has(f.id)).map(f => ({ id: f.id, question_en: f.question_en, category: f.category, translated: !!(f.ku || f.ba || f.ar) }));
    res.json({ items: rows, notInDoc, categories: CATEGORIES, totals: { inDoc: rows.length, shortlistedNow: faqs.filter(f => f.is_shortlisted).length } });
  }));

  app.post('/api/admin/shortlist-sync/apply', authMiddleware(STAFF), wrap(async (req, res) => {
    const ids = a => (Array.isArray(a) ? a : []).map(n => parseInt(n, 10)).filter(Number.isFinite);
    const shortlist = ids(req.body.shortlist), unshortlist = ids(req.body.unshortlist);
    const answers = (Array.isArray(req.body.answers) ? req.body.answers : []).map(a => ({ id: parseInt(a.id, 10), answer: String(a.answer || '').trim() })).filter(a => Number.isFinite(a.id) && a.answer);
    const create = (Array.isArray(req.body.create) ? req.body.create : []).map(c => ({ question: String(c.question || '').trim(), answer: String(c.answer || '').trim(), category: CATEGORIES.includes(c.category) ? c.category : 'Inquiries' })).filter(c => c.question && c.answer);
    if (shortlist.length + unshortlist.length + answers.length + create.length > 150) return res.status(400).json({ error: 'Too many changes at once' });
    const client = await pool.connect();
    const done = { shortlisted: 0, unshortlisted: 0, answersUpdated: 0, created: 0 };
    try {
      await client.query('BEGIN');
      for (const id of shortlist) {
        const r = await client.query(`UPDATE faqs SET is_shortlisted=true WHERE id=$1 AND COALESCE(is_shortlisted,false)=false RETURNING question_en`, [id]);
        if (r.rowCount) { done.shortlisted++; await client.query(`INSERT INTO activity_log(user_id,action,details) VALUES($1,'SHORTLIST_ADD',$2)`, [req.user.id, `FAQ #${id}: ${String(r.rows[0].question_en).slice(0, 140)} (document sync)`]); }
      }
      for (const id of unshortlist) {
        const r = await client.query(`UPDATE faqs SET is_shortlisted=false WHERE id=$1 AND COALESCE(is_shortlisted,false)=true RETURNING question_en`, [id]);
        if (r.rowCount) { done.unshortlisted++; await client.query(`INSERT INTO activity_log(user_id,action,details) VALUES($1,'SHORTLIST_REMOVE',$2)`, [req.user.id, `FAQ #${id}: ${String(r.rows[0].question_en).slice(0, 140)} (document sync)`]); }
      }
      for (const a of answers) {
        const old = await client.query('SELECT answer_en FROM faqs WHERE id=$1', [a.id]);
        if (!old.rows.length) continue;
        await client.query('INSERT INTO faq_answer_backups (faq_id, answer_en, replaced_by) VALUES ($1,$2,$3)', [a.id, old.rows[0].answer_en, req.user.id]);
        await client.query('UPDATE faqs SET answer_en=$1, updated_at=NOW() WHERE id=$2', [a.answer, a.id]);
        done.answersUpdated++;
      }
      for (const c of create) {
        const dup = await client.query('SELECT 1 FROM faqs WHERE LOWER(TRIM(question_en)) = LOWER(TRIM($1))', [c.question]);
        if (dup.rows.length) continue;
        await client.query(`INSERT INTO faqs (category, question_en, answer_en, is_published, is_shortlisted, created_by) VALUES ($1,$2,$3,true,true,$4)`, [c.category, c.question, c.answer, req.user.id]);
        done.created++;
      }
      await client.query(`INSERT INTO activity_log(user_id,action,details) VALUES($1,'SHORTLIST_SYNC',$2)`, [req.user.id, JSON.stringify(done)]);
      await client.query('COMMIT');
      res.json({ success: true, ...done });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));
};

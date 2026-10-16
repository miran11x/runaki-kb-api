// One-time install of the Shortlisted FAQ's from "20260920_Shortlisted_FAQs_2.docx" (31 FAQs, with
// Sorani / Badini / Arabic translations in lib/data/shortlist2026.json).
// It runs by itself on the first request after a deploy, inside one transaction, and then never again
// (it records itself in app_migrations). Rules:
//  - the Shortlisted FAQ's become exactly these 31, in the document's order (faqs.shortlist_pos)
//  - existing shortlisted FAQs are matched by question and updated; a fully translated general FAQ with the
//    same question (one that was un-pinned by mistake) is pinned again; anything missing is created
//  - the general FAQs are never changed, except a shortlisted FAQ that is not in the document goes back to general
//  - replaced text is first copied to faq_content_backups; translations are written only where they are
//    missing or where the English answer really changed
const DATA = require('./data/shortlist2026.json');
const { fix } = require('./shortlistTerms');
const KEY = 'shortlist_2026_10_17';

const norm = s => String(s || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/&/g, ' and ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = s => new Set(norm(s).split(' ').filter(Boolean));
const jac = (a, b) => { const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0; let i = 0; A.forEach(t => { if (B.has(t)) i++; }); return i / (A.size + B.size - i); };
const plain = s => norm(String(s || '').replace(/\*\*/g, '').replace(/[•◦▪]/g, ' '));
const filled = (q, a) => !!(String(q || '').trim() && String(a || '').trim());
const LANGS = ['ku', 'ba', 'ar'];

async function run(pool) {
  const c = await pool.connect();
  try {
    const safe = sql => c.query(sql).catch(() => {});
    await safe(`CREATE TABLE IF NOT EXISTS app_migrations (key TEXT PRIMARY KEY, done_at TIMESTAMP DEFAULT NOW(), result JSONB)`);
    await safe(`CREATE TABLE IF NOT EXISTS faq_content_backups (id SERIAL PRIMARY KEY, faq_id INTEGER NOT NULL, data JSONB, reason TEXT, created_at TIMESTAMP DEFAULT NOW())`);
    await c.query(`ALTER TABLE faqs ADD COLUMN IF NOT EXISTS is_shortlisted BOOLEAN DEFAULT false`);
    await c.query(`ALTER TABLE faqs ADD COLUMN IF NOT EXISTS shortlist_pos INTEGER`);

    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(20261017)');
    if ((await c.query('SELECT 1 FROM app_migrations WHERE key=$1', [KEY])).rowCount) { await c.query('COMMIT'); return { skipped: true }; }

    const actor = (await c.query(`SELECT id FROM users WHERE role='team_lead' ORDER BY id LIMIT 1`).catch(() => ({ rows: [] }))).rows[0]?.id || null;
    const rows = (await c.query(`SELECT id, question_en, answer_en, question_ku, answer_ku, question_ba, answer_ba, question_ar, answer_ar,
        COALESCE(is_shortlisted,false) AS sl FROM faqs`)).rows;
    const shortlisted = rows.filter(r => r.sl), general = rows.filter(r => !r.sl);
    const taken = new Set();
    const plan = DATA.map(d => ({ d, row: null, how: null }));
    const take = (p, row, how) => { p.row = row; p.how = how; taken.add(row.id); };

    // 1) same question already in the shortlist
    plan.forEach(p => { const r = shortlisted.find(x => !taken.has(x.id) && norm(x.question_en) === norm(p.d.question)); if (r) take(p, r, 'exact'); });
    // 2) same question, un-pinned by mistake: a general FAQ that is fully translated goes back to the shortlist
    plan.filter(p => !p.row).forEach(p => {
      const r = general.find(x => !taken.has(x.id) && norm(x.question_en) === norm(p.d.question) && LANGS.every(l => filled(x['question_' + l], x['answer_' + l])));
      if (r) take(p, r, 'pinned-again');
    });
    // 3) clearly the same question, reworded: only when it is a clear winner among the shortlist
    plan.filter(p => !p.row).forEach(p => {
      const sc = shortlisted.filter(x => !taken.has(x.id)).map(x => ({ x, s: jac(p.d.question, x.question_en) })).sort((a, b) => b.s - a.s);
      if (sc[0] && sc[0].s >= 0.8 && (!sc[1] || sc[0].s - sc[1].s >= 0.1)) take(p, sc[0].x, 'close');
    });

    const result = { matched: [], pinnedAgain: [], created: [], answersReplaced: [], translationsWritten: [], removedFromShortlist: [] };
    const upd = [], ins = [];
    for (const p of plan) {
      const { d, row } = p;
      if (!row) { ins.push({ pos: d.no, question_en: d.question, answer_en: d.answer, ...Object.fromEntries(LANGS.flatMap(l => [['question_' + l, d[l].q], ['answer_' + l, d[l].a]])) }); continue; }
      const changed = plain(row.answer_en) !== plain(d.answer);
      const setEn = changed || String(row.answer_en || '').trim() !== d.answer.trim() || String(row.question_en || '').trim() !== d.question.trim();
      const u = { id: row.id, pos: d.no, set_en: setEn, question_en: d.question, answer_en: d.answer };
      const langs = [];
      for (const l of LANGS) {
        const need = !filled(row['question_' + l], row['answer_' + l]) || changed;
        u['set_' + l] = need; u['question_' + l] = d[l].q; u['answer_' + l] = d[l].a;
        if (need) langs.push(l);
      }
      upd.push(u);
      (p.how === 'pinned-again' ? result.pinnedAgain : result.matched).push({ no: d.no, id: row.id, how: p.how });
      if (changed) result.answersReplaced.push(d.no);
      if (langs.length) result.translationsWritten.push({ no: d.no, langs });
    }
    const leave = shortlisted.filter(r => !taken.has(r.id));
    result.removedFromShortlist = leave.map(r => ({ id: r.id, question: String(r.question_en || '').slice(0, 120) }));

    // keep a full copy of everything about to be overwritten or moved
    const touched = [...upd.map(u => u.id), ...leave.map(r => r.id)];
    if (touched.length) await c.query(`INSERT INTO faq_content_backups (faq_id, data, reason) SELECT id, to_jsonb(f), $2 FROM faqs f WHERE id = ANY($1::int[])`, [touched, KEY]);

    if (upd.length) {
      await c.query(`UPDATE faqs f SET
          question_en = CASE WHEN x.set_en THEN x.question_en ELSE f.question_en END,
          answer_en   = CASE WHEN x.set_en THEN x.answer_en ELSE f.answer_en END,
          question_ku = CASE WHEN x.set_ku THEN x.question_ku ELSE f.question_ku END, answer_ku = CASE WHEN x.set_ku THEN x.answer_ku ELSE f.answer_ku END,
          question_ba = CASE WHEN x.set_ba THEN x.question_ba ELSE f.question_ba END, answer_ba = CASE WHEN x.set_ba THEN x.answer_ba ELSE f.answer_ba END,
          question_ar = CASE WHEN x.set_ar THEN x.question_ar ELSE f.question_ar END, answer_ar = CASE WHEN x.set_ar THEN x.answer_ar ELSE f.answer_ar END,
          is_shortlisted = true, is_published = true, shortlist_pos = x.pos, updated_at = NOW()
        FROM jsonb_to_recordset($1::jsonb) AS x(id int, pos int, set_en bool, question_en text, answer_en text,
          set_ku bool, question_ku text, answer_ku text, set_ba bool, question_ba text, answer_ba text, set_ar bool, question_ar text, answer_ar text)
        WHERE f.id = x.id`, [JSON.stringify(upd)]);
    }
    if (ins.length) {
      const r = await c.query(`INSERT INTO faqs (category, question_en, answer_en, question_ku, answer_ku, question_ba, answer_ba, question_ar, answer_ar, is_published, is_shortlisted, shortlist_pos, created_by)
        SELECT 'Inquiries', x.question_en, x.answer_en, x.question_ku, x.answer_ku, x.question_ba, x.answer_ba, x.question_ar, x.answer_ar, true, true, x.pos, $2
        FROM jsonb_to_recordset($1::jsonb) AS x(pos int, question_en text, answer_en text, question_ku text, answer_ku text, question_ba text, answer_ba text, question_ar text, answer_ar text)
        RETURNING id, shortlist_pos`, [JSON.stringify(ins), actor]);
      r.rows.forEach(x => result.created.push({ no: x.shortlist_pos, id: x.id }));
      ins.forEach(i => result.translationsWritten.push({ no: i.pos, langs: LANGS, created: true }));
    }
    if (leave.length) await c.query(`UPDATE faqs SET is_shortlisted = false, shortlist_pos = NULL WHERE id = ANY($1::int[])`, [leave.map(r => r.id)]);

    result.totals = { shortlisted: DATA.length, general: general.length + leave.length - result.pinnedAgain.length };
    await c.query(`INSERT INTO activity_log(user_id, action, details) VALUES ($1, 'SHORTLIST_SYNC', $2)`, [actor, JSON.stringify(result).slice(0, 8000)]).catch(() => {});
    await c.query(`INSERT INTO app_migrations (key, result) VALUES ($1, $2::jsonb)`, [KEY, JSON.stringify(result)]);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

// Second one-time step: apply the house wording (customer = سوودمەند, Commercial Office/CO) to the translated shortlisted FAQs.
const KEY2_ = 'shortlist_terms_2026_10_17', KEY3 = 'shortlist_terms2_2026_10_17', KEY4 = 'shortlist_terms3_2026_10_17';
async function runTerms(pool, KEY2 = 'shortlist_terms_2026_10_17') {
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS app_migrations (key TEXT PRIMARY KEY, done_at TIMESTAMP DEFAULT NOW(), result JSONB)`).catch(() => {});
    await c.query(`CREATE TABLE IF NOT EXISTS faq_content_backups (id SERIAL PRIMARY KEY, faq_id INTEGER NOT NULL, data JSONB, reason TEXT, created_at TIMESTAMP DEFAULT NOW())`).catch(() => {});
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(20261018 + length($1::text))', [KEY2]);
    if ((await c.query('SELECT 1 FROM app_migrations WHERE key=$1', [KEY2])).rowCount) { await c.query('COMMIT'); return { skipped: true }; }
    const rows = (await c.query(`SELECT id, question_ku, answer_ku, question_ba, answer_ba, question_ar, answer_ar FROM faqs WHERE shortlist_pos IS NOT NULL`)).rows;
    const upd = [];
    for (const r of rows) {
      const u = { id: r.id }; let ch = false;
      for (const l of LANGS) for (const k of ['question_', 'answer_']) { const v = fix(l, r[k + l]); u[k + l] = v; if (v !== r[k + l]) ch = true; }
      if (ch) upd.push(u);
    }
    if (upd.length) {
      await c.query(`INSERT INTO faq_content_backups (faq_id, data, reason) SELECT id, to_jsonb(f), $2 FROM faqs f WHERE id = ANY($1::int[])`, [upd.map(u => u.id), KEY2]);
      await c.query(`UPDATE faqs f SET question_ku=x.question_ku, answer_ku=x.answer_ku, question_ba=x.question_ba, answer_ba=x.answer_ba, question_ar=x.question_ar, answer_ar=x.answer_ar, updated_at=NOW()
        FROM jsonb_to_recordset($1::jsonb) AS x(id int, question_ku text, answer_ku text, question_ba text, answer_ba text, question_ar text, answer_ar text) WHERE f.id=x.id`, [JSON.stringify(upd)]);
    }
    await c.query(`INSERT INTO app_migrations (key, result) VALUES ($1, $2::jsonb)`, [KEY2, JSON.stringify({ updated: upd.length, of: rows.length })]);
    await c.query('COMMIT');
    return { updated: upd.length };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

// Express middleware: the first request after a deploy waits for the install; later requests pass straight through.
function middleware(pool) {
  let state = 'pending', running = null, lastTry = 0;
  return (req, res, next) => {
    if (state === 'done' || req.method === 'OPTIONS') return next();
    if (state === 'failed' && Date.now() - lastTry < 60000) return next();
    if (!running) {
      lastTry = Date.now();
      running = run(pool).then(() => runTerms(pool)).then(() => runTerms(pool, KEY3)).then(() => runTerms(pool, KEY4)).then(() => { state = 'done'; }).catch(e => { state = 'failed'; console.error('shortlist install:', e.message); }).finally(() => { running = null; });
    }
    running.then(() => next(), () => next());
  };
}

// STAFF can read what the install did
function mountStatus(app, pool, authMiddleware) {
  app.get('/api/admin/shortlist-install', authMiddleware(['qa_officer', 'team_lead']), async (req, res) => {
    try {
      const r = await pool.query(`SELECT done_at, result FROM app_migrations WHERE key=$1`, [KEY]).catch(() => ({ rows: [] }));
      const t = await pool.query(`SELECT COUNT(*) FILTER (WHERE COALESCE(is_shortlisted,false))::int AS shortlisted, COUNT(*) FILTER (WHERE NOT COALESCE(is_shortlisted,false))::int AS general FROM faqs`);
      res.json({ done: !!r.rows.length, ...(r.rows[0] || {}), now: t.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { middleware, mountStatus, run, runTerms, KEY };

// Search improvement tools:
//  GET  /api/search-synonyms                  any user   active synonym groups (merged into the search engine)
//  POST /api/search-feedback                  any user   👍/👎 on an answer, or a "copy" click (with its position in the results)
//  GET  /api/admin/search/misses              QA / lead  searches that found nothing, grouped, most frequent first
//  POST /api/admin/search/misses/ignore       QA / lead  hide a miss (not useful, or already fixed)
//  POST /api/admin/search/add-key-term        QA / lead  add a key term to an FAQ so that phrase finds it from now on
//  GET  /api/admin/search/quality             QA / lead  helpful rate, 👎 answers, and answers copied from below the first result
//  GET/POST/PUT/DELETE /api/admin/search/synonyms   QA / lead  manage the synonym groups

const STAFF = ['qa_officer', 'team_lead'];
const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const norm = v => clean(v).toLowerCase();

module.exports = function mountSearchTools(app, pool, authMiddleware) {
  let ready = null;
  function ensure() {
    if (!ready) {
      ready = pool.query(`
        CREATE TABLE IF NOT EXISTS search_log (
          id SERIAL PRIMARY KEY, user_id INTEGER, query TEXT NOT NULL, results INTEGER NOT NULL DEFAULT 0,
          source TEXT, created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS search_feedback (
          id SERIAL PRIMARY KEY, user_id INTEGER, query TEXT NOT NULL, faq_id INTEGER, position INTEGER,
          action TEXT NOT NULL, vote SMALLINT, created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_search_feedback_time ON search_feedback (created_at DESC);
        CREATE TABLE IF NOT EXISTS search_synonyms (
          id SERIAL PRIMARY KEY, words TEXT NOT NULL, note TEXT, is_active BOOLEAN NOT NULL DEFAULT true,
          created_by INTEGER, created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS search_miss_ignored (
          norm TEXT PRIMARY KEY, reason TEXT, created_at TIMESTAMP DEFAULT NOW()
        );
      `).catch(err => { ready = null; throw err; });
    }
    return ready;
  }
  const wrap = fn => async (req, res) => {
    try { await ensure(); await fn(req, res); } catch (err) { console.error('search tools:', err.message); res.status(500).json({ error: err.message }); }
  };
  const days = req => Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const wordsOf = text => [...new Set(String(text || '').split(/[,;،؛\n]+/).map(clean).filter(Boolean))];

  // ---- agents -------------------------------------------------------------------------------
  app.get('/api/search-synonyms', authMiddleware(), wrap(async (req, res) => {
    const r = await pool.query(`SELECT words FROM search_synonyms WHERE is_active=true ORDER BY id`);
    res.json({ groups: r.rows.map(x => wordsOf(x.words)).filter(g => g.length > 1) });
  }));

  app.post('/api/search-feedback', authMiddleware(), wrap(async (req, res) => {
    const query = clean(req.body.query).slice(0, 200);
    const action = req.body.action === 'copy' ? 'copy' : 'vote';
    const faqId = parseInt(req.body.faq_id, 10) || null;
    const position = Math.max(1, parseInt(req.body.position, 10) || 1);
    const vote = action === 'vote' ? (req.body.vote > 0 ? 1 : req.body.vote < 0 ? -1 : 0) : null;
    if (!query || !faqId) return res.json({ ok: true });
    if (action === 'vote') {
      // one vote per agent, per search, per answer; the latest click wins (0 removes it)
      await pool.query(`DELETE FROM search_feedback WHERE action='vote' AND user_id=$1 AND faq_id=$2 AND lower(query)=lower($3)`, [req.user.id, faqId, query]);
      if (vote === 0) return res.json({ ok: true });
    }
    await pool.query('INSERT INTO search_feedback (user_id, query, faq_id, position, action, vote) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, query, faqId, position, action, vote]);
    res.json({ ok: true });
  }));

  // ---- staff: searches that found nothing -----------------------------------------------------
  app.get('/api/admin/search/misses', authMiddleware(STAFF), wrap(async (req, res) => {
    // ignore half-typed queries: the same agent searched again within a minute with a longer text that starts the same way
    const r = await pool.query(`
      SELECT lower(trim(l.query)) AS norm, MIN(l.query) AS example, COUNT(*)::int AS n,
             COUNT(DISTINCT l.user_id)::int AS agents, MAX(l.created_at) AS last_seen
        FROM search_log l
       WHERE l.results = 0 AND length(trim(l.query)) >= 3 AND l.created_at > NOW() - make_interval(days => $1::int)
         AND NOT EXISTS (SELECT 1 FROM search_log o WHERE o.user_id IS NOT DISTINCT FROM l.user_id AND o.id > l.id
                         AND o.created_at < l.created_at + INTERVAL '60 seconds' AND length(o.query) > length(l.query)
                         AND lower(o.query) LIKE lower(l.query) || '%')
         AND NOT EXISTS (SELECT 1 FROM search_miss_ignored i WHERE i.norm = lower(trim(l.query)))
       GROUP BY 1 ORDER BY n DESC, last_seen DESC LIMIT 100`, [days(req)]);
    res.json({ days: days(req), rows: r.rows });
  }));

  app.post('/api/admin/search/misses/ignore', authMiddleware(STAFF), wrap(async (req, res) => {
    const n = norm(req.body.query);
    if (!n) return res.status(400).json({ error: 'Query is required' });
    await pool.query(`INSERT INTO search_miss_ignored (norm, reason) VALUES ($1,$2) ON CONFLICT (norm) DO UPDATE SET reason=EXCLUDED.reason`, [n, clean(req.body.reason) || 'ignored']);
    res.json({ ok: true });
  }));

  app.post('/api/admin/search/add-key-term', authMiddleware(STAFF), wrap(async (req, res) => {
    const id = parseInt(req.body.faq_id, 10);
    const term = clean(req.body.term).slice(0, 120);
    if (!id || !term) return res.status(400).json({ error: 'FAQ and term are required' });
    const cur = await pool.query('SELECT tags FROM faqs WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'FAQ not found' });
    const have = wordsOf(cur.rows[0].tags);
    if (!have.some(t => t.toLowerCase() === term.toLowerCase())) have.push(term);
    const tags = have.join(', ');
    await pool.query('UPDATE faqs SET tags=$1, updated_by=$2, updated_at=NOW() WHERE id=$3', [tags, req.user.id, id]);
    await pool.query(`INSERT INTO search_miss_ignored (norm, reason) VALUES ($1,$2) ON CONFLICT (norm) DO UPDATE SET reason=EXCLUDED.reason`, [norm(term), `fixed: FAQ ${id}`]);
    if (req.body.query) await pool.query(`INSERT INTO search_miss_ignored (norm, reason) VALUES ($1,$2) ON CONFLICT (norm) DO UPDATE SET reason=EXCLUDED.reason`, [norm(req.body.query), `fixed: FAQ ${id}`]);
    res.json({ ok: true, tags });
  }));

  // ---- staff: answer quality ------------------------------------------------------------------
  app.get('/api/admin/search/quality', authMiddleware(STAFF), wrap(async (req, res) => {
    const d = days(req);
    const W = `created_at > NOW() - make_interval(days => $1::int)`;
    const [sum, searches, down, order] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE action='vote' AND vote=1)::int AS up,
                         COUNT(*) FILTER (WHERE action='vote' AND vote=-1)::int AS down,
                         COUNT(*) FILTER (WHERE action='copy')::int AS copies,
                         COUNT(*) FILTER (WHERE action='copy' AND position=1)::int AS copies_first
                    FROM search_feedback WHERE ${W}`, [d]),
      pool.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE results=0)::int AS none FROM search_log WHERE ${W}`, [d]),
      pool.query(`SELECT f.query, f.faq_id, q.question_en AS question, COUNT(*)::int AS downs, MIN(f.position) AS position,
                         (SELECT COUNT(*)::int FROM search_feedback u WHERE u.action='vote' AND u.vote=1 AND u.faq_id=f.faq_id AND lower(u.query)=lower(f.query)) AS ups
                    FROM search_feedback f LEFT JOIN faqs q ON q.id = f.faq_id
                   WHERE f.action='vote' AND f.vote=-1 AND f.${W}
                   GROUP BY f.query, f.faq_id, q.question_en ORDER BY downs DESC, f.query LIMIT 50`, [d]),
      pool.query(`SELECT f.query, f.faq_id, q.question_en AS question, COUNT(*)::int AS n, MIN(f.position) AS position
                    FROM search_feedback f LEFT JOIN faqs q ON q.id = f.faq_id
                   WHERE f.action='copy' AND f.position > 1 AND f.${W}
                   GROUP BY f.query, f.faq_id, q.question_en ORDER BY n DESC, f.query LIMIT 50`, [d]),
    ]);
    const s = sum.rows[0], t = searches.rows[0];
    res.json({
      days: d,
      summary: {
        searches: t.n, noResult: t.none, up: s.up, down: s.down,
        helpfulRate: s.up + s.down ? s.up / (s.up + s.down) : null,
        copies: s.copies, firstAnswerRate: s.copies ? s.copies_first / s.copies : null,
      },
      notHelpful: down.rows, wrongOrder: order.rows,
    });
  }));

  // ---- staff: synonym groups --------------------------------------------------------------------
  app.get('/api/admin/search/synonyms', authMiddleware(STAFF), wrap(async (req, res) => {
    res.json((await pool.query('SELECT id, words, note, is_active FROM search_synonyms ORDER BY id DESC')).rows);
  }));
  const saveSyn = async (req, res, id) => {
    const list = wordsOf(req.body.words);
    if (list.length < 2) return res.status(400).json({ error: 'Add at least two words that mean the same thing, separated by commas.' });
    const note = clean(req.body.note).slice(0, 200) || null;
    const active = req.body.is_active === false ? false : true;
    const r = id
      ? await pool.query('UPDATE search_synonyms SET words=$1, note=$2, is_active=$3 WHERE id=$4 RETURNING id, words, note, is_active', [list.join(', '), note, active, id])
      : await pool.query('INSERT INTO search_synonyms (words, note, is_active, created_by) VALUES ($1,$2,$3,$4) RETURNING id, words, note, is_active', [list.join(', '), note, active, req.user.id]);
    res.json(r.rows[0] || null);
  };
  app.post('/api/admin/search/synonyms', authMiddleware(STAFF), wrap((req, res) => saveSyn(req, res, null)));
  app.put('/api/admin/search/synonyms/:id', authMiddleware(STAFF), wrap((req, res) => saveSyn(req, res, parseInt(req.params.id, 10))));
  app.delete('/api/admin/search/synonyms/:id', authMiddleware(STAFF), wrap(async (req, res) => {
    await pool.query('DELETE FROM search_synonyms WHERE id=$1', [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  }));
};

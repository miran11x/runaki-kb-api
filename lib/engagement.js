// Engagement tools: are agents reading what we send them?
//
//  Evaluation acknowledgement and dispute
//    GET  /api/qa/acks                          agent   the caller's acknowledgements / disputes
//    POST /api/qa/acks/:evalId                  agent   "I have read this" (optional comment)
//    POST /api/qa/acks/:evalId/dispute          agent   dispute a score, within DISPUTE_DAYS of the evaluation being posted
//    GET  /api/admin/engagement/evals           staff   who has not read their evaluations + open disputes
//    POST /api/admin/engagement/disputes/:evalId/:userId/resolve   staff   answer a dispute
//  Daily check-in
//    GET  /api/checkin/today                    agent   has the caller checked in today
//    POST /api/checkin                          agent   "I have checked today's updates"
//    GET  /api/admin/engagement/checkins        staff   who checked in today and over the last days
//  Usage
//    POST /api/usage                            any     page visit, link click, file open, navigation search
//    GET  /api/admin/engagement/usage           staff   what agents use most, and navigation searches that found nothing

const STAFF = ['qa_officer', 'team_lead'];
const DISPUTE_DAYS = 7;
const TZ = 'Asia/Baghdad';
const txt = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const KINDS = ['page', 'link', 'file', 'navsearch'];

module.exports = function mountEngagement(app, pool, authMiddleware) {
  let ready = null;
  function ensure() {
    if (!ready) {
      ready = pool.query(`
        CREATE TABLE IF NOT EXISTS eval_acks (
          eval_id INTEGER NOT NULL, user_id INTEGER NOT NULL, acked_at TIMESTAMP DEFAULT NOW(), comment TEXT,
          dispute_text TEXT, disputed_at TIMESTAMP, dispute_status TEXT, staff_reply TEXT, resolved_by TEXT, resolved_at TIMESTAMP,
          PRIMARY KEY (eval_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS daily_checkins (
          user_id INTEGER NOT NULL, day DATE NOT NULL, at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (user_id, day)
        );
        CREATE TABLE IF NOT EXISTS usage_events (
          id SERIAL PRIMARY KEY, user_id INTEGER, kind TEXT NOT NULL, item TEXT NOT NULL, results INTEGER, created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events (created_at DESC);
      `).catch(err => { ready = null; throw err; });
    }
    return ready;
  }
  const wrap = fn => async (req, res) => {
    try { await ensure(); await fn(req, res); } catch (err) { console.error('engagement:', err.message); res.status(500).json({ error: err.message }); }
  };
  const today = `(NOW() AT TIME ZONE '${TZ}')::date`;
  const evalsExist = async () => (await pool.query(`SELECT to_regclass('public.qa_evals') AS t`)).rows[0].t !== null;

  // the evaluation must belong to the caller (same Wave ID or email as the QA workbook rows)
  async function ownEval(user, evalId) {
    if (!(await evalsExist())) return null;
    const u = await pool.query('SELECT wave_id, email FROM users WHERE id=$1', [user.id]);
    const wave = u.rows[0] && u.rows[0].wave_id ? String(u.rows[0].wave_id).trim() : '';
    const email = ((u.rows[0] && u.rows[0].email) || '').toLowerCase().trim();
    const r = await pool.query(
      `SELECT e.id, e.created_at FROM qa_evals e WHERE e.id=$1 AND (($2 <> '' AND e.wave_id = $2) OR ($3 <> '' AND LOWER(TRIM(e.agent_email)) = $3))`,
      [evalId, wave, email]);
    return r.rows[0] || null;
  }

  // ───────── evaluation acknowledgement ─────────
  app.get('/api/qa/acks', authMiddleware(), wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT eval_id, acked_at, comment, dispute_text, disputed_at, dispute_status, staff_reply, resolved_at FROM eval_acks WHERE user_id=$1`, [req.user.id]);
    res.json({ acks: r.rows, disputeDays: DISPUTE_DAYS });
  }));

  // how many of the caller's evaluations they have not confirmed yet (red dot on the sidebar)
  app.get('/api/qa/unread-count', authMiddleware(), wrap(async (req, res) => {
    if (!(await evalsExist())) return res.json({ n: 0 });
    const u = await pool.query('SELECT wave_id, email FROM users WHERE id=$1', [req.user.id]);
    const wave = u.rows[0] && u.rows[0].wave_id ? String(u.rows[0].wave_id).trim() : '';
    const email = ((u.rows[0] && u.rows[0].email) || '').toLowerCase().trim();
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM qa_evals e LEFT JOIN eval_acks a ON a.eval_id = e.id AND a.user_id = $3
        WHERE a.acked_at IS NULL AND (($1 <> '' AND e.wave_id = $1) OR ($2 <> '' AND LOWER(TRIM(e.agent_email)) = $2))`, [wave, email, req.user.id]);
    res.json({ n: r.rows[0].n });
  }));

  app.post('/api/qa/acks/:evalId', authMiddleware(), wrap(async (req, res) => {
    const id = parseInt(req.params.evalId, 10);
    if (!(await ownEval(req.user, id))) return res.status(404).json({ error: 'Evaluation not found' });
    const comment = txt(req.body.comment, 600) || null;
    await pool.query(`INSERT INTO eval_acks (eval_id, user_id, comment) VALUES ($1,$2,$3)
      ON CONFLICT (eval_id, user_id) DO UPDATE SET comment = COALESCE(EXCLUDED.comment, eval_acks.comment)`, [id, req.user.id, comment]);
    res.json({ success: true });
  }));

  app.post('/api/qa/acks/:evalId/dispute', authMiddleware(), wrap(async (req, res) => {
    const id = parseInt(req.params.evalId, 10);
    const ev = await ownEval(req.user, id);
    if (!ev) return res.status(404).json({ error: 'Evaluation not found' });
    const text = txt(req.body.text, 1200);
    if (text.length < 10) return res.status(400).json({ error: 'Please explain what you disagree with (at least a short sentence).' });
    const ageDays = (Date.now() - new Date(ev.created_at).getTime()) / 86400000;
    if (ageDays > DISPUTE_DAYS) return res.status(400).json({ error: `Disputes must be sent within ${DISPUTE_DAYS} days of the evaluation being posted. Please talk to your coordinator.` });
    const cur = await pool.query('SELECT dispute_status FROM eval_acks WHERE eval_id=$1 AND user_id=$2', [id, req.user.id]);
    if (cur.rows[0] && cur.rows[0].dispute_status) return res.status(400).json({ error: 'You already sent a dispute for this evaluation.' });
    await pool.query(`INSERT INTO eval_acks (eval_id, user_id, dispute_text, disputed_at, dispute_status) VALUES ($1,$2,$3,NOW(),'open')
      ON CONFLICT (eval_id, user_id) DO UPDATE SET dispute_text=EXCLUDED.dispute_text, disputed_at=NOW(), dispute_status='open'`, [id, req.user.id, text]);
    res.json({ success: true });
  }));

  app.get('/api/admin/engagement/evals', authMiddleware(STAFF), wrap(async (req, res) => {
    if (!(await evalsExist())) return res.json({ agents: [], disputes: [], totals: { evals: 0, acked: 0 }, disputeDays: DISPUTE_DAYS });
    const agents = await pool.query(`
      WITH mine AS (
        SELECT u.id AS uid, u.name, u.wave_id, e.id AS eid, e.created_at
          FROM users u JOIN qa_evals e ON (u.wave_id IS NOT NULL AND u.wave_id <> '' AND e.wave_id = u.wave_id) OR (u.email IS NOT NULL AND LOWER(TRIM(e.agent_email)) = LOWER(TRIM(u.email)))
         WHERE u.role='agent' AND u.is_active=true)
      SELECT m.uid AS id, m.name, m.wave_id, COUNT(DISTINCT m.eid)::int AS total,
             COUNT(DISTINCT m.eid) FILTER (WHERE a.acked_at IS NOT NULL)::int AS acked,
             MIN(m.created_at) FILTER (WHERE a.acked_at IS NULL) AS oldest_unread
        FROM mine m LEFT JOIN eval_acks a ON a.eval_id = m.eid AND a.user_id = m.uid
       GROUP BY m.uid, m.name, m.wave_id ORDER BY (COUNT(DISTINCT m.eid) - COUNT(DISTINCT m.eid) FILTER (WHERE a.acked_at IS NOT NULL)) DESC, m.name`);
    const disputes = await pool.query(`
      SELECT a.eval_id, a.user_id, u.name, u.wave_id, a.dispute_text, a.disputed_at, a.dispute_status, a.staff_reply, a.resolved_by, a.resolved_at,
             e.call_date, e.eval_date, e.subject, e.ticket_ref, e.final_score, e.qa_officer, e.comments
        FROM eval_acks a JOIN users u ON u.id = a.user_id JOIN qa_evals e ON e.id = a.eval_id
       WHERE a.dispute_status IS NOT NULL
       ORDER BY (a.dispute_status = 'open') DESC, a.disputed_at DESC LIMIT 200`);
    const rows = agents.rows.map(a => ({ ...a, unread: a.total - a.acked }));
    res.json({
      agents: rows, disputes: disputes.rows, disputeDays: DISPUTE_DAYS,
      totals: { evals: rows.reduce((n, a) => n + a.total, 0), acked: rows.reduce((n, a) => n + a.acked, 0) },
    });
  }));

  app.post('/api/admin/engagement/disputes/:evalId/:userId/resolve', authMiddleware(STAFF), wrap(async (req, res) => {
    const reply = txt(req.body.reply, 800);
    const outcome = req.body.outcome === 'changed' ? 'changed' : 'kept';
    if (!reply) return res.status(400).json({ error: 'Write a short reply for the agent.' });
    const r = await pool.query(
      `UPDATE eval_acks SET dispute_status=$1, staff_reply=$2, resolved_by=$3, resolved_at=NOW() WHERE eval_id=$4 AND user_id=$5 AND dispute_status IS NOT NULL`,
      [outcome === 'changed' ? 'score changed' : 'score kept', reply, req.user.name || 'QA Team', req.params.evalId, req.params.userId]);
    if (!r.rowCount) return res.status(404).json({ error: 'Dispute not found' });
    res.json({ success: true });
  }));

  // ───────── daily check-in ─────────
  app.get('/api/checkin/today', authMiddleware(), wrap(async (req, res) => {
    const r = await pool.query(`SELECT 1 FROM daily_checkins WHERE user_id=$1 AND day=${today}`, [req.user.id]);
    res.json({ done: r.rows.length > 0 });
  }));
  app.post('/api/checkin', authMiddleware(), wrap(async (req, res) => {
    await pool.query(`INSERT INTO daily_checkins (user_id, day) VALUES ($1, ${today}) ON CONFLICT DO NOTHING`, [req.user.id]);
    res.json({ success: true });
  }));

  app.get('/api/admin/engagement/checkins', authMiddleware(STAFF), wrap(async (req, res) => {
    const n = Math.min(14, Math.max(3, parseInt(req.query.days, 10) || 7));
    const agents = await pool.query(`SELECT id, name, wave_id FROM users WHERE role='agent' AND is_active=true ORDER BY name`);
    const d = await pool.query(`SELECT c.user_id, to_char(c.day,'YYYY-MM-DD') AS day, to_char(c.at AT TIME ZONE '${TZ}','HH24:MI') AS at
      FROM daily_checkins c WHERE c.day > ${today} - $1::int`, [n]);
    const t = await pool.query(`SELECT to_char(${today},'YYYY-MM-DD') AS today`);
    const days = []; const base = new Date(t.rows[0].today + 'T00:00:00Z');
    for (let i = n - 1; i >= 0; i--) days.push(new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10));
    const by = new Map();
    d.rows.forEach(r => { if (!by.has(r.user_id)) by.set(r.user_id, {}); by.get(r.user_id)[r.day] = r.at; });
    const list = agents.rows.map(a => {
      const m = by.get(a.id) || {};
      let streak = 0; for (let i = days.length - 1; i >= 0; i--) { if (m[days[i]]) streak++; else if (i === days.length - 1) continue; else break; }
      return { id: a.id, name: a.name, wave_id: a.wave_id, today: m[days[days.length - 1]] || null, marks: days.map(x => !!m[x]), count: days.filter(x => m[x]).length, streak };
    });
    res.json({ today: days[days.length - 1], days, total: list.length, done: list.filter(a => a.today).length, agents: list });
  }));

  // ───────── usage ─────────
  app.post('/api/usage', authMiddleware(), wrap(async (req, res) => {
    const kind = String(req.body.kind || ''); const item = txt(req.body.item, 120);
    if (!KINDS.includes(kind) || !item) return res.json({ success: true });
    const results = Number.isFinite(+req.body.results) ? Math.max(0, Math.min(999, Math.round(+req.body.results))) : null;
    await pool.query('INSERT INTO usage_events (user_id, kind, item, results) VALUES ($1,$2,$3,$4)', [req.user.id, kind, item, results]);
    res.json({ success: true });
  }));

  app.get('/api/admin/engagement/usage', authMiddleware(STAFF), wrap(async (req, res) => {
    const days = Math.min(180, Math.max(1, parseInt(req.query.days, 10) || 30));
    const top = async kind => (await pool.query(
      `SELECT e.item, COUNT(*)::int AS n, COUNT(DISTINCT e.user_id)::int AS people FROM usage_events e JOIN users u ON u.id=e.user_id
        WHERE e.kind=$1 AND u.role='agent' AND e.created_at > NOW() - ($2::int * INTERVAL '1 day') GROUP BY e.item ORDER BY n DESC LIMIT 15`, [kind, days])).rows;
    const navMiss = await pool.query(
      `SELECT LOWER(e.item) AS item, COUNT(*)::int AS n, COUNT(DISTINCT e.user_id)::int AS people FROM usage_events e JOIN users u ON u.id=e.user_id
        WHERE e.kind='navsearch' AND e.results = 0 AND u.role='agent' AND e.created_at > NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY LOWER(e.item) ORDER BY n DESC LIMIT 20`, [days]);
    const navAll = await pool.query(
      `SELECT COUNT(*)::int AS n FROM usage_events e JOIN users u ON u.id=e.user_id WHERE e.kind='navsearch' AND u.role='agent' AND e.created_at > NOW() - ($1::int * INTERVAL '1 day')`, [days]);
    const faqs = await pool.query(`SELECT id, question_en, category, views FROM faqs WHERE is_published=true AND COALESCE(views,0) > 0 ORDER BY views DESC LIMIT 10`).catch(() => ({ rows: [] }));
    res.json({ days, pages: await top('page'), links: await top('link'), files: await top('file'), navSearches: await top('navsearch'), navMisses: navMiss.rows, navTotal: navAll.rows[0].n, faqs: faqs.rows });
  }));
};

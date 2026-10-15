// QA evaluations (from the monthly "Runaki QA Evaluation" workbook, Raw Data tab).
//
//  POST /api/qa/preview   team lead  what an upload would add / change / remove
//  POST /api/qa/upload    team lead  upsert a chunk of rows (same evaluation = updated, never duplicated)
//  POST /api/qa/finish    team lead  remove evaluations of the uploaded months that are no longer in the sheet
//  POST /api/qa/rubric    team lead  replace the scoring rubric (definitions + points)
//  DELETE /api/qa/all     team lead  wipe everything
//  GET  /api/qa/months    team lead  months that have data
//  GET  /api/qa/data      team lead  evaluations of one or more months (for the reports)
//  GET  /api/qa/mine      any agent  the logged-in agent's own evaluations

const ATTRS = [
  'Greeting Script', 'Customer ID & Info', 'Active Listening', 'FAQ Alignment', 'Communication', 'Problem Solving',
  'Tag / Topic', 'Tone of Voice', 'Ending', 'Rude Behaviour', 'Hang Up',
];

module.exports = function mountQa(app, pool, authMiddleware) {
  let ready = null;
  function ensure() {
    if (!ready) {
      ready = pool.query(`
        CREATE TABLE IF NOT EXISTS qa_evals (
          id SERIAL PRIMARY KEY,
          eval_key TEXT UNIQUE NOT NULL,
          month TEXT NOT NULL,
          eval_id TEXT,
          agent_name TEXT,
          agent_email TEXT,
          wave_id TEXT,
          qa_officer TEXT,
          coordinator TEXT,
          queue TEXT,
          eval_date TIMESTAMP,
          call_date DATE,
          subject TEXT,
          ticket_ref TEXT,
          wait_sec INTEGER,
          talk_sec INTEGER,
          fails JSONB,
          pts JSONB,
          raw_score INTEGER,
          final_score INTEGER,
          critical TEXT,
          comments TEXT,
          feedback_needed BOOLEAN,
          background_noise TEXT,
          coaching_status TEXT,
          coaching_date DATE,
          coaching_notes TEXT,
          dispute_status TEXT,
          dispute_result TEXT,
          cap_raised TEXT,
          row_hash TEXT,
          batch TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_qa_evals_month ON qa_evals (month);
        CREATE INDEX IF NOT EXISTS idx_qa_evals_wave ON qa_evals (wave_id);
        CREATE INDEX IF NOT EXISTS idx_qa_evals_email ON qa_evals (LOWER(agent_email));
        CREATE TABLE IF NOT EXISTS qa_rubric (
          id SERIAL PRIMARY KEY,
          attribute TEXT,
          attr_definition TEXT,
          reason TEXT,
          points INTEGER,
          definition TEXT,
          pass_example TEXT,
          sort INTEGER
        );
      `).catch(err => { ready = null; throw err; });
    }
    return ready;
  }

  const lead = authMiddleware(['team_lead']);
  const monthOf = d => (d || '').slice(0, 7);

  app.post('/api/qa/preview', lead, async (req, res) => {
    try {
      await ensure();
      const items = Array.isArray(req.body.items) ? req.body.items : [];
      const months = [...new Set(items.map(i => String(i.month || '')).filter(Boolean))];
      const { rows } = await pool.query('SELECT eval_key, row_hash, month FROM qa_evals WHERE month = ANY($1)', [months]);
      const have = new Map(rows.map(r => [r.eval_key, r.row_hash]));
      const keys = new Set(items.map(i => i.key));
      let added = 0, changed = 0, same = 0;
      items.forEach(i => {
        if (!have.has(i.key)) added++;
        else if (have.get(i.key) !== i.hash) changed++;
        else same++;
      });
      const removed = rows.filter(r => !keys.has(r.eval_key)).length;
      const total = (await pool.query('SELECT COUNT(*)::int AS n FROM qa_evals')).rows[0].n;
      res.json({ added, changed, same, removed, months, existing: total });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/qa/upload', lead, async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const batch = String(req.body.batch || '');
    if (!rows.length || !batch) return res.status(400).json({ error: 'No rows' });
    try {
      await ensure();
      const clean = rows.filter(r => r.eval_key && r.eval_date).map(r => ({
        ...r, month: monthOf(r.eval_date), batch,
      }));
      const q = await pool.query(
        `INSERT INTO qa_evals (eval_key, month, eval_id, agent_name, agent_email, wave_id, qa_officer, coordinator, queue, eval_date, call_date,
            subject, ticket_ref, wait_sec, talk_sec, fails, pts, raw_score, final_score, critical, comments, feedback_needed, background_noise,
            coaching_status, coaching_date, coaching_notes, dispute_status, dispute_result, cap_raised, row_hash, batch)
         SELECT eval_key, month, eval_id, agent_name, agent_email, wave_id, qa_officer, coordinator, queue, eval_date, call_date,
            subject, ticket_ref, wait_sec, talk_sec, fails, pts, raw_score, final_score, critical, comments, feedback_needed, background_noise,
            coaching_status, coaching_date, coaching_notes, dispute_status, dispute_result, cap_raised, row_hash, batch
           FROM jsonb_to_recordset($1::jsonb) AS x(
            eval_key text, month text, eval_id text, agent_name text, agent_email text, wave_id text, qa_officer text, coordinator text, queue text,
            eval_date timestamp, call_date date, subject text, ticket_ref text, wait_sec int, talk_sec int, fails jsonb, pts jsonb,
            raw_score int, final_score int, critical text, comments text, feedback_needed boolean, background_noise text,
            coaching_status text, coaching_date date, coaching_notes text, dispute_status text, dispute_result text, cap_raised text,
            row_hash text, batch text)
         ON CONFLICT (eval_key) DO UPDATE SET
            month=EXCLUDED.month, eval_id=EXCLUDED.eval_id, agent_name=EXCLUDED.agent_name, agent_email=EXCLUDED.agent_email,
            wave_id=EXCLUDED.wave_id, qa_officer=EXCLUDED.qa_officer, coordinator=EXCLUDED.coordinator, queue=EXCLUDED.queue,
            eval_date=EXCLUDED.eval_date, call_date=EXCLUDED.call_date, subject=EXCLUDED.subject, ticket_ref=EXCLUDED.ticket_ref,
            wait_sec=EXCLUDED.wait_sec, talk_sec=EXCLUDED.talk_sec, fails=EXCLUDED.fails, pts=EXCLUDED.pts, raw_score=EXCLUDED.raw_score,
            final_score=EXCLUDED.final_score, critical=EXCLUDED.critical, comments=EXCLUDED.comments, feedback_needed=EXCLUDED.feedback_needed,
            background_noise=EXCLUDED.background_noise, coaching_status=EXCLUDED.coaching_status, coaching_date=EXCLUDED.coaching_date,
            coaching_notes=EXCLUDED.coaching_notes, dispute_status=EXCLUDED.dispute_status, dispute_result=EXCLUDED.dispute_result,
            cap_raised=EXCLUDED.cap_raised, batch=EXCLUDED.batch,
            updated_at = CASE WHEN qa_evals.row_hash IS DISTINCT FROM EXCLUDED.row_hash THEN NOW() ELSE qa_evals.updated_at END,
            row_hash=EXCLUDED.row_hash
         RETURNING (xmax = 0) AS inserted`,
        [JSON.stringify(clean)]
      );
      const inserted = q.rows.filter(r => r.inserted).length;
      res.json({ received: clean.length, inserted, updated: q.rowCount - inserted });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/qa/finish', lead, async (req, res) => {
    try {
      await ensure();
      const months = Array.isArray(req.body.months) ? req.body.months.map(String) : [];
      let removed = 0;
      if (req.body.remove && months.length && req.body.batch) {
        const r = await pool.query('DELETE FROM qa_evals WHERE month = ANY($1) AND batch IS DISTINCT FROM $2', [months, String(req.body.batch)]);
        removed = r.rowCount;
      }
      res.json({ removed });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/qa/rubric', lead, async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.json({ saved: 0 });
    try {
      await ensure();
      await pool.query('DELETE FROM qa_rubric');
      await pool.query(
        `INSERT INTO qa_rubric (attribute, attr_definition, reason, points, definition, pass_example, sort)
         SELECT attribute, attr_definition, reason, points, definition, pass_example, sort
           FROM jsonb_to_recordset($1::jsonb) AS x(attribute text, attr_definition text, reason text, points int, definition text, pass_example text, sort int)`,
        [JSON.stringify(rows)]
      );
      res.json({ saved: rows.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/qa/all', lead, async (req, res) => {
    try {
      await ensure();
      await pool.query('TRUNCATE qa_evals RESTART IDENTITY');
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/qa/months', lead, async (req, res) => {
    try {
      await ensure();
      const { rows } = await pool.query(
        `SELECT month, COUNT(*)::int AS evals, COUNT(DISTINCT agent_name)::int AS agents, MAX(updated_at) AS updated
           FROM qa_evals GROUP BY month ORDER BY month DESC`);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  const SELECT_COLS = `e.id, e.eval_id, e.agent_name AS n, e.wave_id AS w, e.agent_email AS em, e.qa_officer AS q, e.coordinator AS c, e.queue AS u,
        to_char(e.eval_date, 'YYYY-MM-DD"T"HH24:MI:SS') AS d, to_char(e.call_date, 'YYYY-MM-DD') AS cd, e.subject AS s, e.ticket_ref AS t,
        e.wait_sec AS ws, e.talk_sec AS ts, e.fails AS fl, e.pts AS pt, e.raw_score AS r, e.final_score AS f, e.critical AS cr, e.comments AS cm,
        e.feedback_needed AS fn, e.background_noise AS bn, e.coaching_status AS cs, to_char(e.coaching_date, 'YYYY-MM-DD') AS cdt,
        e.coaching_notes AS cn, e.dispute_status AS ds, e.dispute_result AS dr, e.cap_raised AS cp`;

  app.get('/api/qa/data', lead, async (req, res) => {
    try {
      await ensure();
      const months = String(req.query.months || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
      if (!months.length) return res.json({ rows: [], rubric: [], roster: [] });
      const [rows, rubric, roster] = await Promise.all([
        pool.query(
          `SELECT ${SELECT_COLS}, u.id AS uid
             FROM qa_evals e LEFT JOIN users u ON u.role='agent' AND u.wave_id = e.wave_id
            WHERE e.month = ANY($1) ORDER BY e.eval_date, e.id`, [months]),
        pool.query('SELECT attribute, reason, points, definition FROM qa_rubric ORDER BY sort, id'),
        pool.query(`SELECT id, name, wave_id FROM users WHERE role='agent' AND is_active=true ORDER BY name`),
      ]);
      res.json({ rows: rows.rows, rubric: rubric.rows, roster: roster.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/qa/mine', authMiddleware(), async (req, res) => {
    try {
      await ensure();
      const u = await pool.query('SELECT wave_id, email FROM users WHERE id=$1', [req.user.id]);
      const wave = u.rows[0] && u.rows[0].wave_id ? String(u.rows[0].wave_id).trim() : '';
      const email = ((u.rows[0] && u.rows[0].email) || '').toLowerCase().trim();
      const [rows, rubric] = await Promise.all([
        pool.query(
          `SELECT ${SELECT_COLS} FROM qa_evals e
            WHERE ($1 <> '' AND e.wave_id = $1) OR ($2 <> '' AND LOWER(TRIM(e.agent_email)) = $2)
            ORDER BY e.eval_date DESC, e.id DESC`, [wave, email]),
        pool.query('SELECT attribute, reason, points, definition FROM qa_rubric ORDER BY sort, id'),
      ]);
      res.json({ rows: rows.rows, rubric: rubric.rows, attrs: ATTRS });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};

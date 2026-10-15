// Incident banner + daily quiz.
//  GET  /api/incident                 any user   the live incident line (or null)
//  POST /api/admin/incident           QA / lead  {message, severity:'info'|'warning'|'urgent', minutes}  post a line (replaces the current one)
//  POST /api/admin/incident/end       QA / lead  end it now
//  GET  /api/admin/incident/history   QA / lead  last 15 lines
//  GET  /api/quiz/today               agents     today's 3 questions (answers hidden) or, if done, the result
//  POST /api/quiz/answer              agents     {answers:[i,i,i]} graded on the server, once a day
//  GET  /api/quiz/stats               agents     streak, points, month rank
//  GET  /api/quiz/leaderboard         any user   this month's top 10 by quiz points + own rank
const STAFF = ['qa_officer', 'team_lead'];
const PER_CORRECT = 10, PERFECT_BONUS = 5, QUESTIONS = 3, OPTIONS = 4;
const SEV = ['info', 'warning', 'urgent'];

// small deterministic random generator so everybody gets the same quiz on the same day
function rng(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = Math.imul(h ^ (h >>> 15), 1 | h); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, rand) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function plain(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
}
function snippet(s) {
  const t = plain(s);
  if (t.length <= 150) return t;
  const cut = t.slice(0, 150); const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
  return (dot > 70 ? cut.slice(0, dot + 1) : cut.replace(/\s+\S*$/, '') + '…');
}
// the quiz day follows Erbil time (UTC+3), so it turns over at local midnight
const dayStr = d => new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);

module.exports = function mountTeamTools(app, pool, authMiddleware) {
  let ready = null;
  function ensure() {
    if (!ready) {
      ready = pool.query(`
        CREATE TABLE IF NOT EXISTS incidents (
          id SERIAL PRIMARY KEY, message TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'warning',
          created_by INTEGER, created_at TIMESTAMP DEFAULT NOW(), expires_at TIMESTAMP NOT NULL, ended_at TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS quiz_attempts (
          id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, quiz_date DATE NOT NULL, correct SMALLINT NOT NULL,
          total SMALLINT NOT NULL, points INTEGER NOT NULL, created_at TIMESTAMP DEFAULT NOW(), UNIQUE (user_id, quiz_date)
        );
      `).catch(err => { ready = null; throw err; });
    }
    return ready;
  }
  const wrap = fn => async (req, res) => {
    try { await ensure(); await fn(req, res); } catch (err) { console.error('team tools:', err.message); res.status(500).json({ error: err.message }); }
  };

  // ---------- Incident banner ----------
  async function activeIncident() {
    const r = await pool.query(`SELECT i.id, i.message, i.severity, i.created_at, i.expires_at, u.name AS by
        FROM incidents i LEFT JOIN users u ON u.id = i.created_by
        WHERE i.ended_at IS NULL AND i.expires_at > NOW() ORDER BY i.id DESC LIMIT 1`);
    return r.rows[0] || null;
  }
  app.get('/api/incident', authMiddleware(), wrap(async (req, res) => { res.json({ incident: await activeIncident() }); }));
  app.post('/api/admin/incident', authMiddleware(STAFF), wrap(async (req, res) => {
    const message = String(req.body.message || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (message.length < 5) return res.status(400).json({ error: 'Write the incident in one short line (at least 5 characters).' });
    const severity = SEV.includes(req.body.severity) ? req.body.severity : 'warning';
    const minutes = Math.min(Math.max(parseInt(req.body.minutes, 10) || 120, 5), 60 * 24 * 3);
    await pool.query(`UPDATE incidents SET ended_at = NOW() WHERE ended_at IS NULL AND expires_at > NOW()`);
    await pool.query(`INSERT INTO incidents(message, severity, created_by, expires_at) VALUES($1,$2,$3, NOW() + ($4 || ' minutes')::interval)`, [message, severity, req.user.id, String(minutes)]);
    res.json({ incident: await activeIncident() });
  }));
  app.post('/api/admin/incident/end', authMiddleware(STAFF), wrap(async (req, res) => {
    await pool.query(`UPDATE incidents SET ended_at = NOW() WHERE ended_at IS NULL AND expires_at > NOW()`);
    res.json({ incident: null });
  }));
  app.get('/api/admin/incident/history', authMiddleware(STAFF), wrap(async (req, res) => {
    const r = await pool.query(`SELECT i.id, i.message, i.severity, i.created_at, i.expires_at, i.ended_at, u.name AS by
        FROM incidents i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.id DESC LIMIT 15`);
    res.json({ rows: r.rows, active: await activeIncident() });
  }));

  // ---------- Daily quiz ----------
  // Question: "Which answer goes with this FAQ question?" with 4 answer openings, one correct, three from other FAQs.
  async function buildQuiz(date) {
    const r = await pool.query(`SELECT id, category, question_en, answer_en FROM faqs WHERE is_published = true
        AND COALESCE(question_en,'') <> '' AND COALESCE(answer_en,'') <> '' ORDER BY id`);
    const pool_ = r.rows.map(f => ({ id: f.id, category: f.category, q: plain(f.question_en), a: snippet(f.answer_en) })).filter(f => f.a.length >= 40 && f.q.length >= 8);
    if (pool_.length < OPTIONS + QUESTIONS) return null;
    const rand = rng('runaki-quiz-' + date);
    const picked = []; const usedA = new Set();
    for (const f of shuffle(pool_, rand)) { if (usedA.has(f.a)) continue; usedA.add(f.a); picked.push(f); if (picked.length === QUESTIONS) break; }
    return picked.map(f => {
      const same = shuffle(pool_.filter(o => o.id !== f.id && o.a !== f.a && o.category === f.category), rand);
      const other = shuffle(pool_.filter(o => o.id !== f.id && o.a !== f.a && o.category !== f.category), rand);
      const wrong = []; const seen = new Set([f.a]);
      for (const o of [...same, ...other]) { if (seen.has(o.a)) continue; seen.add(o.a); wrong.push(o); if (wrong.length === OPTIONS - 1) break; }
      const opts = shuffle([{ a: f.a, ok: true }, ...wrong.map(o => ({ a: o.a, ok: false }))], rand);
      return { faq_id: f.id, category: f.category, question: f.q, options: opts.map(o => o.a), correct: opts.findIndex(o => o.ok) };
    });
  }
  const todayStr = () => dayStr(new Date());
  async function streakOf(uid) {
    const r = await pool.query(`SELECT quiz_date::text AS d FROM quiz_attempts WHERE user_id = $1 ORDER BY quiz_date DESC LIMIT 400`, [uid]);
    const days = new Set(r.rows.map(x => x.d)); let n = 0; const d = new Date();
    if (!days.has(dayStr(d))) d.setUTCDate(d.getUTCDate() - 1);
    while (days.has(dayStr(d))) { n++; d.setUTCDate(d.getUTCDate() - 1); }
    return { current: n, best: bestStreak([...days].sort()) };
  }
  function bestStreak(sorted) {
    let best = 0, run = 0, prev = null;
    for (const s of sorted) { const t = Date.parse(s + 'T00:00:00Z'); run = prev !== null && t - prev === 86400000 ? run + 1 : 1; prev = t; if (run > best) best = run; }
    return best;
  }
  async function monthBoard(uid) {
    const month = todayStr().slice(0, 7);
    const r = await pool.query(`SELECT a.user_id, u.name, SUM(a.points)::int AS points, COUNT(*)::int AS days, SUM(a.correct)::int AS correct, SUM(a.total)::int AS total
        FROM quiz_attempts a JOIN users u ON u.id = a.user_id WHERE to_char(a.quiz_date,'YYYY-MM') = $1 AND u.is_active = true
        GROUP BY a.user_id, u.name ORDER BY points DESC, days DESC, u.name`, [month]);
    let rank = 0, prevP = null, shown = 0;
    const rows = r.rows.map((x, i) => { if (x.points !== prevP) { rank = i + 1; prevP = x.points; } return { ...x, rank }; });
    const meRow = rows.find(x => x.user_id === uid) || null;
    return { month, top: rows.slice(0, 10).map(x => ({ rank: x.rank, name: x.name, points: x.points, days: x.days, accuracy: x.total ? x.correct / x.total : 0, me: x.user_id === uid })), me: meRow && { rank: meRow.rank, points: meRow.points, days: meRow.days }, players: rows.length };
  }

  app.get('/api/quiz/today', authMiddleware(), wrap(async (req, res) => {
    const date = todayStr();
    const quiz = await buildQuiz(date);
    if (!quiz) return res.json({ available: false, message: 'The quiz needs a few more published FAQs.' });
    const done = await pool.query('SELECT correct, total, points FROM quiz_attempts WHERE user_id = $1 AND quiz_date = $2', [req.user.id, date]);
    const out = { available: true, date, streak: (await streakOf(req.user.id)).current,
      questions: quiz.map(q => ({ question: q.question, category: q.category, options: q.options })) };
    if (done.rows[0]) { out.done = done.rows[0]; out.answers = quiz.map(q => ({ correct: q.correct, faq_id: q.faq_id })); }
    res.json(out);
  }));
  app.post('/api/quiz/answer', authMiddleware(), wrap(async (req, res) => {
    const date = todayStr();
    const quiz = await buildQuiz(date);
    if (!quiz) return res.status(400).json({ error: 'No quiz today.' });
    const ans = Array.isArray(req.body.answers) ? req.body.answers.map(x => parseInt(x, 10)) : [];
    if (ans.length !== quiz.length) return res.status(400).json({ error: 'Answer all three questions.' });
    const correct = quiz.reduce((n, q, i) => n + (ans[i] === q.correct ? 1 : 0), 0);
    const points = correct * PER_CORRECT + (correct === quiz.length ? PERFECT_BONUS : 0);
    const ins = await pool.query(`INSERT INTO quiz_attempts(user_id, quiz_date, correct, total, points) VALUES($1,$2,$3,$4,$5) ON CONFLICT (user_id, quiz_date) DO NOTHING RETURNING id`,
      [req.user.id, date, correct, quiz.length, points]);
    if (!ins.rows.length) return res.status(409).json({ error: 'You already played today. Come back tomorrow.' });
    res.json({ correct, total: quiz.length, points, perfect: correct === quiz.length, answers: quiz.map((q, i) => ({ correct: q.correct, picked: ans[i], faq_id: q.faq_id })), streak: (await streakOf(req.user.id)).current });
  }));
  app.get('/api/quiz/stats', authMiddleware(), wrap(async (req, res) => {
    const s = await streakOf(req.user.id);
    const t = await pool.query(`SELECT COALESCE(SUM(points),0)::int AS points, COUNT(*)::int AS days FROM quiz_attempts WHERE user_id = $1`, [req.user.id]);
    const today = await pool.query('SELECT 1 FROM quiz_attempts WHERE user_id = $1 AND quiz_date = $2', [req.user.id, todayStr()]);
    res.json({ streak: s.current, best: s.best, points: t.rows[0].points, days: t.rows[0].days, played_today: !!today.rows.length, board: await monthBoard(req.user.id) });
  }));
  app.get('/api/quiz/leaderboard', authMiddleware(), wrap(async (req, res) => { res.json(await monthBoard(req.user.id)); }));
};

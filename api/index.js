const express = require('express');
const app = express();

// Vercel-compatible CORS - must handle OPTIONS preflight
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});
app.use(express.json());

// ─── AUTH ────────────────────────────────────────────────────────────────────
const pool = require('../lib/db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const authMiddleware = require('../lib/auth');

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await pool.query('SELECT * FROM users WHERE email=$1 AND is_active=true', [email.toLowerCase().trim()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name, title: user.title }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
    await pool.query('UPDATE users SET last_seen=NOW() WHERE id=$1', [user.id]);
    await pool.query(`INSERT INTO active_sessions(user_id,last_ping) VALUES($1,NOW()) ON CONFLICT(user_id) DO UPDATE SET last_ping=NOW()`, [user.id]).catch(() => {});
    await pool.query(`INSERT INTO activity_log(user_id,action,details) VALUES($1,'LOGIN',$2)`, [user.id, `Login`]).catch(() => {});
    await pool.query(`INSERT INTO login_events(user_id) VALUES($1)`, [user.id]).catch(() => {});
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, title: user.title } });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware(), async (req, res) => {
  const r = await pool.query('SELECT id,name,email,role,title FROM users WHERE id=$1', [req.user.id]).catch(() => null);
  r?.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
});

// POST /api/auth/ping
app.post('/api/auth/ping', authMiddleware(), async (req, res) => {
  await pool.query(`INSERT INTO active_sessions(user_id,last_ping) VALUES($1,NOW()) ON CONFLICT(user_id) DO UPDATE SET last_ping=NOW()`, [req.user.id]).catch(() => {});
  await pool.query('UPDATE users SET last_seen=NOW() WHERE id=$1', [req.user.id]).catch(() => {});
  res.json({ ok: true });
});

// POST /api/auth/logout
app.post('/api/auth/logout', authMiddleware(), async (req, res) => {
  await pool.query('DELETE FROM active_sessions WHERE user_id=$1', [req.user.id]).catch(() => {});
  res.json({ ok: true });
});

// ─── USERS ───────────────────────────────────────────────────────────────────
app.get('/api/users', authMiddleware(['team_lead']), async (req, res) => {
  const r = await pool.query('SELECT id,name,email,role,title,is_active,created_at,last_seen FROM users ORDER BY role,name').catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/users/stats', authMiddleware(['team_lead']), async (req, res) => {
  try {
    const [tu, au, tf, tl, by_role, logins_week] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query(`SELECT COUNT(*) FROM active_sessions WHERE last_ping > NOW()-INTERVAL '5 minutes'`),
      pool.query('SELECT COUNT(*) FROM faqs WHERE is_published=true'),
      pool.query(`SELECT COUNT(*) FROM activity_log WHERE action='LOGIN'`),
      pool.query(`SELECT role, COUNT(*) as count FROM users GROUP BY role`),
      pool.query(`SELECT DATE(created_at) as day, COUNT(*) as count FROM activity_log WHERE action='LOGIN' AND created_at > NOW()-INTERVAL '7 days' GROUP BY DATE(created_at) ORDER BY day`),
    ]);
    res.json({ totalUsers: parseInt(tu.rows[0].count), activeNow: parseInt(au.rows[0].count), totalFaqs: parseInt(tf.rows[0].count), totalLogins: parseInt(tl.rows[0].count), byRole: by_role.rows, loginsWeek: logins_week.rows });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/users/active-list', authMiddleware(['team_lead','qa_officer']), async (req, res) => {
  const r = await pool.query(`SELECT u.id,u.name,u.email,u.role,u.title,s.last_ping FROM active_sessions s JOIN users u ON u.id=s.user_id WHERE s.last_ping > NOW()-INTERVAL '10 minutes' ORDER BY s.last_ping DESC`).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/users/active-count', authMiddleware(), async (req, res) => {
  const r = await pool.query(`SELECT COUNT(*) FROM active_sessions WHERE last_ping > NOW()-INTERVAL '10 minutes'`).catch(() => null);
  r ? res.json({ count: parseInt(r.rows[0].count) }) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/users/activity', authMiddleware(['team_lead']), async (req, res) => {
  const r = await pool.query(`SELECT a.*,u.name FROM activity_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100`).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/users/leaderboard', authMiddleware(['team_lead']), async (req, res) => {
  try {
    const r = await pool.query(`SELECT u.id,u.name,u.title,u.role, COUNT(DISTINCT fv.faq_id) as faqs_viewed, COUNT(DISTINCT b.faq_id) as bookmarks, COUNT(DISTINCT fr.faq_id) FILTER (WHERE fr.helpful=true) as helpful_ratings, MAX(u.last_seen) as last_seen FROM users u LEFT JOIN faq_views fv ON fv.user_id=u.id LEFT JOIN bookmarks b ON b.user_id=u.id LEFT JOIN faq_ratings fr ON fr.user_id=u.id WHERE u.role='agent' AND u.is_active=true GROUP BY u.id,u.name,u.title,u.role ORDER BY faqs_viewed DESC,bookmarks DESC LIMIT 20`);
    res.json(r.rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/users/profile/me', authMiddleware(), async (req, res) => {
  try {
    const [b,r,v,t] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM bookmarks WHERE user_id=$1', [req.user.id]),
      pool.query('SELECT COUNT(*) FILTER (WHERE helpful=true) as helpful, COUNT(*) as total FROM faq_ratings WHERE user_id=$1', [req.user.id]),
      pool.query('SELECT COUNT(DISTINCT faq_id) FROM faq_views WHERE user_id=$1', [req.user.id]),
      pool.query('SELECT COUNT(*) FROM login_events WHERE user_id=$1', [req.user.id]),
    ]);
    res.json({ bookmarks:parseInt(b.rows[0].count), helpful_ratings:parseInt(r.rows[0].helpful), total_ratings:parseInt(r.rows[0].total), faqs_viewed:parseInt(v.rows[0].count), total_logins:parseInt(t.rows[0].count) });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/users/stats/weekly', authMiddleware(['team_lead']), async (req, res) => {
  const r = await pool.query(`SELECT DATE(logged_in_at) as day, COUNT(*) as logins FROM login_events WHERE logged_in_at > NOW()-INTERVAL '14 days' GROUP BY DATE(logged_in_at) ORDER BY day`).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/users/stats/peak-hours', authMiddleware(['team_lead']), async (req, res) => {
  const r = await pool.query(`SELECT hour_of_day as hour, COUNT(*) as logins FROM login_events WHERE logged_in_at > NOW()-INTERVAL '30 days' GROUP BY hour_of_day ORDER BY hour_of_day`).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});


app.patch('/api/users/:id', authMiddleware(['team_lead']), async (req, res) => {
  const { name, email, role, title, password } = req.body;
  const updates = []; const vals = [];
  if (name)     { updates.push(`name=$${updates.length+1}`);  vals.push(name); }
  if (email)    { updates.push(`email=$${updates.length+1}`); vals.push(email); }
  if (role)     { updates.push(`role=$${updates.length+1}`);  vals.push(role); }
  if (title !== undefined) { updates.push(`title=$${updates.length+1}`); vals.push(title); }
  if (password) {
    const bcrypt = require('bcryptjs');
    const hashed = await bcrypt.hash(password, 10);
    updates.push(`password_hash=$${updates.length+1}`); vals.push(hashed);
  }
  if (!updates.length) return res.json({ success: true });
  vals.push(req.params.id);
  await pool.query(`UPDATE users SET ${updates.join(',')} WHERE id=$${vals.length}`, vals).catch(() => {});
  res.json({ success: true });
});

app.patch('/api/users/:id/reset-password', authMiddleware(['team_lead']), async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hash, req.params.id]);
    await pool.query(`INSERT INTO activity_log(user_id,action,details) VALUES($1,'RESET_PASSWORD',$2)`, [req.user.id, `Reset password for user ID ${req.params.id}`]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/users/:id/toggle', authMiddleware(['team_lead']), async (req, res) => {
  try {
    const r = await pool.query('UPDATE users SET is_active=NOT is_active WHERE id=$1 RETURNING is_active', [req.params.id]);
    res.json({ is_active: r.rows[0].is_active });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/users/:id', authMiddleware(['team_lead']), async (req, res) => {
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]).catch(() => {});
  res.json({ ok: true });
});

app.post('/api/users', authMiddleware(['team_lead']), async (req, res) => {
  const { name, email, password, role, title } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query('INSERT INTO users(name,email,password,role,title) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,title', [name, email.toLowerCase(), hash, role, title]);
    res.status(201).json(r.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ─── FAQS ────────────────────────────────────────────────────────────────────
app.get('/api/faqs', authMiddleware(), async (req, res) => {
  const r = await pool.query(`SELECT f.*,u.name as created_by_name,u2.name as updated_by_name FROM faqs f LEFT JOIN users u ON u.id=f.created_by LEFT JOIN users u2 ON u2.id=f.updated_by WHERE f.is_published=true ORDER BY f.category,f.subcategory,f.id`).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/faqs/all', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const r = await pool.query(`SELECT f.*,u.name as created_by_name FROM faqs f LEFT JOIN users u ON u.id=f.created_by ORDER BY f.created_at DESC`).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/faqs/top-viewed', authMiddleware(['team_lead','qa_officer']), async (req, res) => {
  const r = await pool.query(`SELECT id,question_en,category,views FROM faqs WHERE is_published=true ORDER BY views DESC LIMIT 10`).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/faqs/notifications/all', authMiddleware(), async (req, res) => {
  const r = await pool.query(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT 20`).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/faqs/tags/all', authMiddleware(), async (req, res) => {
  const r = await pool.query(`SELECT DISTINCT unnest(tags_arr) as tag FROM faqs WHERE array_length(tags_arr,1)>0 ORDER BY tag`).catch(() => null);
  r ? res.json(r.rows.map(x => x.tag)) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/faqs/by-tag/:tag', authMiddleware(), async (req, res) => {
  const r = await pool.query(`SELECT * FROM faqs WHERE $1=ANY(tags_arr) AND is_published=true ORDER BY category,subcategory`, [req.params.tag]).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/faqs/views-by-category', authMiddleware(['team_lead','qa_officer']), async (req, res) => {
  const r = await pool.query(`SELECT category, SUM(views) as total_views FROM faqs WHERE is_published=true GROUP BY category ORDER BY total_views DESC`).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/faqs/:id', authMiddleware(), async (req, res) => {
  const r = await pool.query('SELECT * FROM faqs WHERE id=$1', [req.params.id]).catch(() => null);
  r?.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/faqs', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const { category, subcategory, question_en, answer_en, question_ku, answer_ku, tags, is_published } = req.body;
  try {
    const r = await pool.query(`INSERT INTO faqs(category,subcategory,question_en,answer_en,question_ku,answer_ku,tags,is_published,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [category, subcategory||null, question_en, answer_en, question_ku||null, answer_ku||null, tags||null, is_published||false, req.user.id]);
    await pool.query(`INSERT INTO activity_log(user_id,action,details) VALUES($1,'CREATE_FAQ',$2)`, [req.user.id, `Created FAQ: "${question_en}"`]);
    res.status(201).json(r.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/faqs/:id', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const { category, subcategory, question_en, answer_en, question_ku, answer_ku, tags, is_published } = req.body;
  try {
    const r = await pool.query(`UPDATE faqs SET category=$1,subcategory=$2,question_en=$3,answer_en=$4,question_ku=$5,answer_ku=$6,tags=$7,is_published=$8,updated_by=$9,updated_at=NOW() WHERE id=$10 RETURNING *`,
      [category, subcategory||null, question_en, answer_en, question_ku||null, answer_ku||null, tags||null, is_published, req.user.id, req.params.id]);
    res.json(r.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/faqs/:id/toggle-publish', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const r = await pool.query('UPDATE faqs SET is_published=NOT is_published WHERE id=$1 RETURNING is_published', [req.params.id]).catch(() => null);
  r ? res.json({ is_published: r.rows[0].is_published }) : res.status(500).json({ error: 'Server error' });
});

app.patch('/api/faqs/:id/view', authMiddleware(), async (req, res) => {
  await pool.query('UPDATE faqs SET views=views+1 WHERE id=$1', [req.params.id]).catch(() => {});
  await pool.query(`INSERT INTO faq_views(faq_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, req.user.id]).catch(() => {});
  res.json({ ok: true });
});

app.delete('/api/faqs/:id', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  await pool.query('DELETE FROM faqs WHERE id=$1', [req.params.id]).catch(() => {});
  res.json({ ok: true });
});

// Notify
app.post('/api/faqs/notifications', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const { title, message } = req.body;
  const r = await pool.query('INSERT INTO notifications(title,message,created_by) VALUES($1,$2,$3) RETURNING *', [title, message, req.user.id]).catch(() => null);
  r ? res.json(r.rows[0]) : res.status(500).json({ error: 'Server error' });
});

// ─── TIPS ─────────────────────────────────────────────────────────────────────
app.get('/api/tips/latest', authMiddleware(), async (req, res) => {
  const r = await pool.query(`SELECT t.*,u.name as author FROM daily_tips t LEFT JOIN users u ON u.id=t.created_by WHERE t.is_active=true ORDER BY t.created_at DESC LIMIT 1`).catch(() => null);
  r ? res.json(r.rows[0] || null) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/tips', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const r = await pool.query(`SELECT t.*,u.name as author FROM daily_tips t LEFT JOIN users u ON u.id=t.created_by ORDER BY t.created_at DESC LIMIT 20`).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.post('/api/tips', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const { title, content, category, publish_at } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content required' });
  try {
    if (!publish_at) await pool.query('UPDATE daily_tips SET is_active=false');
    const r = await pool.query('INSERT INTO daily_tips(title,content,category,is_active,created_by,publish_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [title, content, category||'General', !publish_at, req.user.id, publish_at||null]);
    res.status(201).json(r.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/tips/:id/toggle', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  try {
    await pool.query('UPDATE daily_tips SET is_active=false');
    await pool.query('UPDATE daily_tips SET is_active=true WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/tips/:id', authMiddleware(['team_lead']), async (req, res) => {
  await pool.query('DELETE FROM daily_tips WHERE id=$1', [req.params.id]).catch(() => {});
  res.json({ ok: true });
});

// ─── BOOKMARKS ────────────────────────────────────────────────────────────────
app.get('/api/bookmarks', authMiddleware(), async (req, res) => {
  const r = await pool.query(`SELECT f.*,b.created_at as bookmarked_at FROM bookmarks b JOIN faqs f ON f.id=b.faq_id WHERE b.user_id=$1 AND f.is_published=true ORDER BY b.created_at DESC`, [req.user.id]).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.get('/api/bookmarks/ids', authMiddleware(), async (req, res) => {
  const r = await pool.query('SELECT faq_id FROM bookmarks WHERE user_id=$1', [req.user.id]).catch(() => null);
  r ? res.json(r.rows.map(x => x.faq_id)) : res.status(500).json({ error: 'Server error' });
});

app.post('/api/bookmarks/:faq_id', authMiddleware(), async (req, res) => {
  try {
    const existing = await pool.query('SELECT id FROM bookmarks WHERE user_id=$1 AND faq_id=$2', [req.user.id, req.params.faq_id]);
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM bookmarks WHERE user_id=$1 AND faq_id=$2', [req.user.id, req.params.faq_id]);
      res.json({ bookmarked: false });
    } else {
      await pool.query('INSERT INTO bookmarks(user_id,faq_id) VALUES($1,$2)', [req.user.id, req.params.faq_id]);
      res.json({ bookmarked: true });
    }
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ─── RATINGS ─────────────────────────────────────────────────────────────────
app.post('/api/ratings/:faq_id', authMiddleware(), async (req, res) => {
  const { helpful } = req.body;
  try {
    await pool.query(`INSERT INTO faq_ratings(user_id,faq_id,helpful) VALUES($1,$2,$3) ON CONFLICT(user_id,faq_id) DO UPDATE SET helpful=$3`, [req.user.id, req.params.faq_id, helpful]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/ratings/mine/all', authMiddleware(), async (req, res) => {
  const r = await pool.query('SELECT faq_id,helpful FROM faq_ratings WHERE user_id=$1', [req.user.id]).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

// ─── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
app.get('/api/announcements', authMiddleware(), async (req, res) => {
  const limit = req.user.role === 'team_lead' ? 100 : 5;
  const r = await pool.query(`SELECT a.*,u.name as created_by_name FROM announcements a LEFT JOIN users u ON u.id=a.created_by ORDER BY a.created_at DESC LIMIT $1`, [limit]).catch(() => null);
  r ? res.json(r.rows) : res.status(500).json({ error: 'Server error' });
});

app.post('/api/announcements', authMiddleware(['team_lead']), async (req, res) => {
  const { title, message, priority } = req.body;
  try {
    const r = await pool.query('INSERT INTO announcements(title,message,priority,created_by) VALUES($1,$2,$3,$4) RETURNING *', [title, message, priority||'normal', req.user.id]);
    await pool.query(`INSERT INTO activity_log(user_id,action,details) VALUES($1,'ANNOUNCEMENT',$2)`, [req.user.id, `Sent announcement: ${title}`]);
    res.json(r.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/announcements/:id', authMiddleware(['team_lead']), async (req, res) => {
  await pool.query('DELETE FROM announcements WHERE id=$1', [req.params.id]).catch(() => null);
  res.json({ success: true });
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────

// ── CALL FLOWS ──────────────────────────────────────────────────────────────
app.get('/api/callflows', authMiddleware(), async (req, res) => {
  const r = await pool.query(`SELECT cf.*,u.name as created_by_name FROM call_flows cf LEFT JOIN users u ON u.id=cf.created_by WHERE cf.is_active=true ORDER BY cf.display_order,cf.id`).catch(() => null);
  res.json(r ? r.rows : []);
});

app.get('/api/callflows/all', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const r = await pool.query(`SELECT cf.*,u.name as created_by_name FROM call_flows cf LEFT JOIN users u ON u.id=cf.created_by ORDER BY cf.display_order,cf.id`).catch(() => null);
  res.json(r ? r.rows : []);
});

app.post('/api/callflows', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const { title, icon, color, description, note, steps, display_order } = req.body;
  if (!title || !steps) return res.status(400).json({ error: 'title and steps required' });
  const r = await pool.query(
    'INSERT INTO call_flows(title,icon,color,description,note,steps,display_order,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [title, icon||'📞', color||'#3b82f6', description||'', note||null, JSON.stringify(steps), display_order||0, req.user.id]
  ).catch(e => ({ error: e.message }));
  if (r.error) return res.status(500).json({ error: r.error });
  res.json(r.rows[0]);
});

app.put('/api/callflows/:id', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const { title, icon, color, description, note, steps, display_order, is_active } = req.body;
  const r = await pool.query(
    'UPDATE call_flows SET title=$1,icon=$2,color=$3,description=$4,note=$5,steps=$6,display_order=$7,is_active=$8,updated_at=NOW() WHERE id=$9 RETURNING *',
    [title, icon, color, description, note||null, JSON.stringify(steps), display_order||0, is_active!==false, req.params.id]
  ).catch(e => ({ error: e.message }));
  if (r.error) return res.status(500).json({ error: r.error });
  res.json(r.rows[0]);
});

app.delete('/api/callflows/:id', authMiddleware(['team_lead']), async (req, res) => {
  await pool.query('DELETE FROM call_flows WHERE id=$1', [req.params.id]).catch(() => null);
  res.json({ success: true });
});

app.patch('/api/callflows/:id/toggle', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const r = await pool.query('UPDATE call_flows SET is_active=NOT is_active WHERE id=$1 RETURNING is_active', [req.params.id]).catch(() => null);
  res.json(r ? r.rows[0] : { error: 'failed' });
});

app.get('/api/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date() });
  } catch(e) {
    res.status(500).json({ status: 'error', db: 'failed', error: e.message });
  }
});

module.exports = app;
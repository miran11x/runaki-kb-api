// Folders (file links), SMS templates and the Updates channel.
//  FOLDERS   GET  /api/folders                       any user   visible folders with their visible links (staff: ?all=1 for everything)
//            POST/PUT/DELETE /api/admin/folders[/:id]            staff   manage folders
//            POST/PUT/DELETE /api/admin/folder-links[/:id]       staff   manage the links inside a folder
//  SMS       GET  /api/sms                           any user   active categories with their active templates (staff: ?all=1)
//            POST/PUT/DELETE /api/admin/sms-types[/:id], /api/admin/sms-templates[/:id]   staff
//  CHANNEL   GET  /api/channel?after=<id>            any user   latest messages (with reaction counts and my reactions)
//            GET  /api/channel/unread?after=<id>     any user   how many messages are newer than <id>
//            POST /api/channel                       staff      {body}
//            DELETE /api/channel/:id                 staff
//            POST /api/channel/:id/react             any user   {emoji} toggles my reaction
const express = require('express');
const STAFF = ['qa_officer', 'team_lead'];
const MAX_FILE = 4 * 1000 * 1000; // Vercel rejects request bodies over ~4.5 MB
const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain' };
const extOf = n => (String(n || '').split('.').pop() || '').toLowerCase();
const rawBody = express.raw({ type: () => true, limit: '4mb' });
const EMOJI = ['👍', '✅', '❤️', '👀', '🙏', '😂'];
const url = u => { const t = String(u || '').trim(); return /^https?:\/\/[^\s]+$/i.test(t) ? t : null; };
const txt = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const num = v => (Number.isFinite(+v) ? +v : 0);
const isStaff = u => STAFF.includes(String(u.role || '').trim().toLowerCase());

module.exports = function mountAgentHub(app, pool, authMiddleware) {
  let ready = null;
  function ensure() {
    if (!ready) {
      ready = (async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS kb_folders (id SERIAL PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '📁', description TEXT, sort_order INTEGER DEFAULT 0, is_visible BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT NOW());
          CREATE TABLE IF NOT EXISTS kb_folder_links (id SERIAL PRIMARY KEY, folder_id INTEGER NOT NULL REFERENCES kb_folders(id) ON DELETE CASCADE, title TEXT NOT NULL, url TEXT NOT NULL, description TEXT, sort_order INTEGER DEFAULT 0, is_visible BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT NOW());
          ALTER TABLE kb_folder_links ADD COLUMN IF NOT EXISTS file_name TEXT;
          ALTER TABLE kb_folder_links ADD COLUMN IF NOT EXISTS file_type TEXT;
          ALTER TABLE kb_folder_links ADD COLUMN IF NOT EXISTS file_size INTEGER;
          ALTER TABLE kb_folder_links ADD COLUMN IF NOT EXISTS file_data BYTEA;
          ALTER TABLE kb_folder_links ADD COLUMN IF NOT EXISTS file_updated_at TIMESTAMP;
          CREATE TABLE IF NOT EXISTS sms_types (id SERIAL PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '💬', sort_order INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT TRUE);
          CREATE TABLE IF NOT EXISTS sms_templates (id SERIAL PRIMARY KEY, type_id INTEGER NOT NULL REFERENCES sms_types(id) ON DELETE CASCADE, title TEXT NOT NULL, body_en TEXT, body_ku TEXT, body_ba TEXT, body_ar TEXT, sort_order INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT TRUE, updated_at TIMESTAMP DEFAULT NOW());
          CREATE TABLE IF NOT EXISTS channel_messages (id SERIAL PRIMARY KEY, author_id INTEGER, author_name TEXT, author_title TEXT, body TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());
          CREATE TABLE IF NOT EXISTS channel_reactions (message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY (message_id, user_id, emoji));
        `);
        const c = await pool.query('SELECT COUNT(*)::int AS n FROM sms_types');
        if (!c.rows[0].n) {
          // four starter types; the team lead can rename, add or remove them in the Admin Panel
          for (const [i, [n, ic]] of [['Billing', '💳'], ['Service request', '🛠️'], ['Complaint follow-up', '📣'], ['General information', 'ℹ️']].entries())
            await pool.query('INSERT INTO sms_types (name, icon, sort_order) VALUES ($1,$2,$3)', [n, ic, i + 1]);
        }
      })().catch(e => { ready = null; throw e; });
    }
    return ready;
  }
  const wrap = fn => async (req, res) => { try { await ensure(); await fn(req, res); } catch (err) { console.error('agent hub:', err.message); res.status(500).json({ error: err.message }); } };
  const all = req => isStaff(req.user) && req.query.all === '1';

  // ───────── Folders ─────────
  app.get('/api/folders', authMiddleware(), wrap(async (req, res) => {
    const a = all(req);
    const f = await pool.query(`SELECT id, name, icon, description, sort_order, is_visible FROM kb_folders ${a ? '' : 'WHERE is_visible'} ORDER BY sort_order, id`);
    const l = await pool.query(`SELECT id, folder_id, title, url, description, sort_order, is_visible, (file_data IS NOT NULL) AS has_file, file_name, file_size, file_updated_at FROM kb_folder_links ${a ? '' : 'WHERE is_visible'} ORDER BY sort_order, id`);
    res.json(f.rows.map(x => ({ ...x, links: l.rows.filter(k => k.folder_id === x.id) })));
  }));
  app.post('/api/admin/folders', authMiddleware(STAFF), wrap(async (req, res) => {
    const name = txt(req.body.name, 120); if (!name) return res.status(400).json({ error: 'Folder name is required' });
    const r = await pool.query('INSERT INTO kb_folders (name, icon, description, sort_order, is_visible) VALUES ($1,$2,$3,$4,COALESCE($5,TRUE)) RETURNING *',
      [name, txt(req.body.icon, 16) || '📁', txt(req.body.description, 300) || null, num(req.body.sort_order), req.body.is_visible]);
    res.json(r.rows[0]);
  }));
  app.put('/api/admin/folders/:id', authMiddleware(STAFF), wrap(async (req, res) => {
    const name = txt(req.body.name, 120); if (!name) return res.status(400).json({ error: 'Folder name is required' });
    const r = await pool.query('UPDATE kb_folders SET name=$1, icon=$2, description=$3, sort_order=$4, is_visible=$5 WHERE id=$6 RETURNING *',
      [name, txt(req.body.icon, 16) || '📁', txt(req.body.description, 300) || null, num(req.body.sort_order), req.body.is_visible !== false, req.params.id]);
    r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
  }));
  app.delete('/api/admin/folders/:id', authMiddleware(STAFF), wrap(async (req, res) => { await pool.query('DELETE FROM kb_folders WHERE id=$1', [req.params.id]); res.json({ success: true }); }));
  app.post('/api/admin/folder-links', authMiddleware(STAFF), wrap(async (req, res) => {
    const title = txt(req.body.title, 200), u = url(req.body.url);
    if (!title) return res.status(400).json({ error: 'File name is required' });
    if (!u) return res.status(400).json({ error: 'The link must start with http:// or https://' });
    const r = await pool.query('INSERT INTO kb_folder_links (folder_id, title, url, description, sort_order, is_visible) VALUES ($1,$2,$3,$4,$5,COALESCE($6,TRUE)) RETURNING *',
      [req.body.folder_id, title, u, txt(req.body.description, 300) || null, num(req.body.sort_order), req.body.is_visible]);
    res.json(r.rows[0]);
  }));
  app.put('/api/admin/folder-links/:id', authMiddleware(STAFF), wrap(async (req, res) => {
    const title = txt(req.body.title, 200);
    const cur = await pool.query('SELECT (file_data IS NOT NULL) AS has_file FROM kb_folder_links WHERE id=$1', [req.params.id]);
    const isFile = cur.rows[0] && cur.rows[0].has_file;
    const u = isFile ? '' : url(req.body.url);
    if (!title) return res.status(400).json({ error: 'File name is required' });
    if (!isFile && !u) return res.status(400).json({ error: 'The link must start with http:// or https://' });
    const r = await pool.query('UPDATE kb_folder_links SET folder_id=COALESCE($1,folder_id), title=$2, url=$3, description=$4, sort_order=$5, is_visible=$6 WHERE id=$7 RETURNING *',
      [req.body.folder_id || null, title, u, txt(req.body.description, 300) || null, num(req.body.sort_order), req.body.is_visible !== false, req.params.id]);
    r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
  }));
  // upload an Excel / PDF / Word file into a folder (raw body, name in the query string)
  const readFile = req => {
    const filename = txt(req.query.filename, 200), ext = extOf(filename);
    if (!MIME[ext]) return { error: 'Allowed files: Excel (.xlsx, .xls, .csv), PDF, Word, PowerPoint, text.' };
    if (!Buffer.isBuffer(req.body) || !req.body.length) return { error: 'The file is empty.' };
    if (req.body.length > MAX_FILE) return { error: 'The file is larger than 4 MB. Put it on SharePoint and add the link instead.' };
    return { filename, type: MIME[ext], data: req.body };
  };
  app.post('/api/admin/folder-files', authMiddleware(STAFF), rawBody, wrap(async (req, res) => {
    const f = readFile(req); if (f.error) return res.status(400).json({ error: f.error });
    const title = txt(req.query.title, 200) || f.filename.replace(/\.[^.]+$/, '');
    const r = await pool.query(`INSERT INTO kb_folder_links (folder_id, title, url, description, sort_order, is_visible, file_name, file_type, file_size, file_data, file_updated_at)
      VALUES ($1,$2,'',$3,$4,TRUE,$5,$6,$7,$8,NOW()) RETURNING id, folder_id, title, file_name, file_size`,
      [req.query.folder_id, title, txt(req.query.description, 300) || null, num(req.query.sort_order), f.filename, f.type, f.data.length, f.data]);
    res.json(r.rows[0]);
  }));
  app.post('/api/admin/folder-links/:id/file', authMiddleware(STAFF), rawBody, wrap(async (req, res) => {
    const f = readFile(req); if (f.error) return res.status(400).json({ error: f.error });
    const r = await pool.query(`UPDATE kb_folder_links SET url='', file_name=$1, file_type=$2, file_size=$3, file_data=$4, file_updated_at=NOW() WHERE id=$5 RETURNING id`, [f.filename, f.type, f.data.length, f.data, req.params.id]);
    r.rows[0] ? res.json({ success: true }) : res.status(404).json({ error: 'Not found' });
  }));
  app.get('/api/folder-files/:id/download', authMiddleware(), wrap(async (req, res) => {
    const r = await pool.query(`SELECT l.file_name, l.file_type, l.file_data, l.is_visible, f.is_visible AS folder_visible FROM kb_folder_links l JOIN kb_folders f ON f.id = l.folder_id WHERE l.id=$1 AND l.file_data IS NOT NULL`, [req.params.id]);
    const x = r.rows[0];
    if (!x || (!isStaff(req.user) && !(x.is_visible && x.folder_visible))) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', x.file_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${String(x.file_name).replace(/[^\w.\- ]/g, '_')}"`);
    res.send(x.file_data);
  }));
  app.delete('/api/admin/folder-links/:id', authMiddleware(STAFF), wrap(async (req, res) => { await pool.query('DELETE FROM kb_folder_links WHERE id=$1', [req.params.id]); res.json({ success: true }); }));

  // ───────── SMS templates ─────────
  app.get('/api/sms', authMiddleware(), wrap(async (req, res) => {
    const a = all(req);
    const t = await pool.query(`SELECT id, name, icon, sort_order, is_active FROM sms_types ${a ? '' : 'WHERE is_active'} ORDER BY sort_order, id`);
    const m = await pool.query(`SELECT id, type_id, title, body_en, body_ku, body_ba, body_ar, sort_order, is_active FROM sms_templates ${a ? '' : 'WHERE is_active'} ORDER BY sort_order, id`);
    res.json(t.rows.map(x => ({ ...x, templates: m.rows.filter(k => k.type_id === x.id) })));
  }));
  app.post('/api/admin/sms-types', authMiddleware(STAFF), wrap(async (req, res) => {
    const name = txt(req.body.name, 80); if (!name) return res.status(400).json({ error: 'Type name is required' });
    const r = await pool.query('INSERT INTO sms_types (name, icon, sort_order, is_active) VALUES ($1,$2,$3,COALESCE($4,TRUE)) RETURNING *', [name, txt(req.body.icon, 16) || '💬', num(req.body.sort_order), req.body.is_active]);
    res.json(r.rows[0]);
  }));
  app.put('/api/admin/sms-types/:id', authMiddleware(STAFF), wrap(async (req, res) => {
    const name = txt(req.body.name, 80); if (!name) return res.status(400).json({ error: 'Type name is required' });
    const r = await pool.query('UPDATE sms_types SET name=$1, icon=$2, sort_order=$3, is_active=$4 WHERE id=$5 RETURNING *', [name, txt(req.body.icon, 16) || '💬', num(req.body.sort_order), req.body.is_active !== false, req.params.id]);
    r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
  }));
  app.delete('/api/admin/sms-types/:id', authMiddleware(STAFF), wrap(async (req, res) => { await pool.query('DELETE FROM sms_types WHERE id=$1', [req.params.id]); res.json({ success: true }); }));
  const tpl = b => [txt(b.title, 160), txt(b.body_en, 2000) || null, txt(b.body_ku, 2000) || null, txt(b.body_ba, 2000) || null, txt(b.body_ar, 2000) || null];
  app.post('/api/admin/sms-templates', authMiddleware(STAFF), wrap(async (req, res) => {
    const v = tpl(req.body); if (!v[0]) return res.status(400).json({ error: 'Title is required' });
    if (!v.slice(1).some(Boolean)) return res.status(400).json({ error: 'Write the SMS text in at least one language' });
    const r = await pool.query('INSERT INTO sms_templates (type_id, title, body_en, body_ku, body_ba, body_ar, sort_order, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,TRUE)) RETURNING *', [req.body.type_id, ...v, num(req.body.sort_order), req.body.is_active]);
    res.json(r.rows[0]);
  }));
  app.put('/api/admin/sms-templates/:id', authMiddleware(STAFF), wrap(async (req, res) => {
    const v = tpl(req.body); if (!v[0]) return res.status(400).json({ error: 'Title is required' });
    if (!v.slice(1).some(Boolean)) return res.status(400).json({ error: 'Write the SMS text in at least one language' });
    const r = await pool.query('UPDATE sms_templates SET type_id=COALESCE($1,type_id), title=$2, body_en=$3, body_ku=$4, body_ba=$5, body_ar=$6, sort_order=$7, is_active=$8, updated_at=NOW() WHERE id=$9 RETURNING *', [req.body.type_id || null, ...v, num(req.body.sort_order), req.body.is_active !== false, req.params.id]);
    r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
  }));
  app.delete('/api/admin/sms-templates/:id', authMiddleware(STAFF), wrap(async (req, res) => { await pool.query('DELETE FROM sms_templates WHERE id=$1', [req.params.id]); res.json({ success: true }); }));

  // ───────── Updates channel ─────────
  app.get('/api/channel', authMiddleware(), wrap(async (req, res) => {
    const before = Math.max(0, parseInt(req.query.before, 10) || 0);
    const m = await pool.query(`SELECT id, author_name, author_title, body, created_at FROM channel_messages ${before ? 'WHERE id < $1' : ''} ORDER BY id DESC LIMIT 40`, before ? [before] : []);
    const ids = m.rows.map(r => r.id);
    const rx = ids.length ? await pool.query('SELECT message_id, emoji, user_id FROM channel_reactions WHERE message_id = ANY($1::int[])', [ids]) : { rows: [] };
    const me = req.user.id;
    res.json({ canPost: isStaff(req.user), emoji: EMOJI, messages: m.rows.reverse().map(r => {
      const mine = rx.rows.filter(x => x.message_id === r.id);
      return { ...r, reactions: EMOJI.map(e => ({ emoji: e, count: mine.filter(x => x.emoji === e).length, mine: mine.some(x => x.emoji === e && x.user_id === me) })).filter(x => x.count) };
    }) });
  }));
  app.get('/api/channel/unread', authMiddleware(), wrap(async (req, res) => {
    const after = Math.max(0, parseInt(req.query.after, 10) || 0);
    const r = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(MAX(id),0)::int AS last FROM channel_messages WHERE id > $1', [after]);
    res.json(r.rows[0]);
  }));
  app.post('/api/channel', authMiddleware(STAFF), wrap(async (req, res) => {
    const body = txt(req.body.body, 4000); if (!body) return res.status(400).json({ error: 'Write a message first' });
    const r = await pool.query('INSERT INTO channel_messages (author_id, author_name, author_title, body) VALUES ($1,$2,$3,$4) RETURNING id, author_name, author_title, body, created_at',
      [req.user.id, req.user.name || 'QA Team', req.user.title || null, body]);
    res.json({ ...r.rows[0], reactions: [] });
  }));
  app.delete('/api/channel/:id', authMiddleware(STAFF), wrap(async (req, res) => { await pool.query('DELETE FROM channel_messages WHERE id=$1', [req.params.id]); res.json({ success: true }); }));
  app.post('/api/channel/:id/react', authMiddleware(), wrap(async (req, res) => {
    const emoji = String(req.body.emoji || ''); if (!EMOJI.includes(emoji)) return res.status(400).json({ error: 'Unknown reaction' });
    const ex = await pool.query('SELECT 1 FROM channel_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3', [req.params.id, req.user.id, emoji]);
    if (ex.rows.length) await pool.query('DELETE FROM channel_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3', [req.params.id, req.user.id, emoji]);
    else await pool.query('INSERT INTO channel_reactions (message_id, user_id, emoji) SELECT $1,$2,$3 WHERE EXISTS (SELECT 1 FROM channel_messages WHERE id=$1)', [req.params.id, req.user.id, emoji]);
    res.json({ success: true });
  }));
};

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
const CHUNK = 3 * 1000 * 1000;     // Vercel rejects request/response bodies over ~4.5 MB
const MAX_TOTAL = 25 * 1000 * 1000;
const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain' };
const extOf = n => (String(n || '').split('.').pop() || '').toLowerCase();
const rawBody = express.raw({ type: () => true, limit: '3.5mb' });
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
          ALTER TABLE kb_folder_links ADD COLUMN IF NOT EXISTS file_version INTEGER DEFAULT 0;
          ALTER TABLE kb_folder_links ADD COLUMN IF NOT EXISTS file_pending_name TEXT;
          CREATE TABLE IF NOT EXISTS kb_file_chunks (link_id INTEGER NOT NULL REFERENCES kb_folder_links(id) ON DELETE CASCADE, version INTEGER NOT NULL, idx INTEGER NOT NULL, data BYTEA NOT NULL, PRIMARY KEY (link_id, version, idx));
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
    const l = await pool.query(`SELECT id, folder_id, title, url, description, sort_order, is_visible, (file_size IS NOT NULL) AS has_file, file_name, file_size, file_updated_at FROM kb_folder_links WHERE NOT (file_size IS NULL AND file_pending_name IS NOT NULL) ${a ? '' : 'AND is_visible'} ORDER BY sort_order, id`);
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
    const cur = await pool.query('SELECT (file_size IS NOT NULL) AS has_file FROM kb_folder_links WHERE id=$1', [req.params.id]);
    const isFile = cur.rows[0] && cur.rows[0].has_file;
    const u = isFile ? '' : url(req.body.url);
    if (!title) return res.status(400).json({ error: 'File name is required' });
    if (!isFile && !u) return res.status(400).json({ error: 'The link must start with http:// or https://' });
    const r = await pool.query('UPDATE kb_folder_links SET folder_id=COALESCE($1,folder_id), title=$2, url=$3, description=$4, sort_order=$5, is_visible=$6 WHERE id=$7 RETURNING *',
      [req.body.folder_id || null, title, u, txt(req.body.description, 300) || null, num(req.body.sort_order), req.body.is_visible !== false, req.params.id]);
    r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'Not found' });
  }));
  // Files are sent in pieces of up to 3 MB because the hosting rejects any single request or response over ~4.5 MB.
  // upload: init -> chunk (x n) -> finish.   download: info -> download?part=i (x n)
  const checkName = name => { const ext = extOf(name); return MIME[ext] ? { type: MIME[ext] } : { error: 'Allowed files: Excel (.xlsx, .xls, .csv), PDF, Word, PowerPoint, text.' }; };
  app.post('/api/admin/folder-files/init', authMiddleware(STAFF), wrap(async (req, res) => {
    const filename = txt(req.body.filename, 200), size = +req.body.size;
    const c = checkName(filename); if (c.error) return res.status(400).json({ error: c.error });
    if (!(size > 0)) return res.status(400).json({ error: 'The file is empty.' });
    if (size > MAX_TOTAL) return res.status(400).json({ error: `The file is larger than ${MAX_TOTAL / 1e6} MB. Put it on SharePoint and add the link instead.` });
    if (req.body.link_id) { // replacing the file of an existing card
      const r = await pool.query('UPDATE kb_folder_links SET file_pending_name=$1 WHERE id=$2 AND file_size IS NOT NULL RETURNING id, file_version', [filename, req.body.link_id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
      return res.json({ id: r.rows[0].id, version: r.rows[0].file_version + 1 });
    }
    const title = txt(req.body.title, 200) || filename.replace(/\.[^.]+$/, '');
    const r = await pool.query(`INSERT INTO kb_folder_links (folder_id, title, url, description, sort_order, is_visible, file_name, file_type, file_pending_name, file_version)
      VALUES ($1,$2,'',$3,$4,FALSE,$5,$6,$5,0) RETURNING id`, [req.body.folder_id, title, txt(req.body.description, 300) || null, num(req.body.sort_order), filename, c.type]);
    res.json({ id: r.rows[0].id, version: 1, isNew: true });
  }));
  app.post('/api/admin/folder-files/:id/chunk', authMiddleware(STAFF), rawBody, wrap(async (req, res) => {
    const idx = parseInt(req.query.idx, 10), version = parseInt(req.query.version, 10);
    if (!Buffer.isBuffer(req.body) || !req.body.length || !(idx >= 0) || !(version > 0)) return res.status(400).json({ error: 'Bad upload piece.' });
    if (req.body.length > CHUNK) return res.status(400).json({ error: 'Upload piece too large.' });
    await pool.query(`INSERT INTO kb_file_chunks (link_id, version, idx, data) VALUES ($1,$2,$3,$4) ON CONFLICT (link_id, version, idx) DO UPDATE SET data = EXCLUDED.data`, [req.params.id, version, idx, req.body]);
    res.json({ ok: true });
  }));
  app.post('/api/admin/folder-files/:id/finish', authMiddleware(STAFF), wrap(async (req, res) => {
    const version = parseInt(req.body.version, 10), size = +req.body.size;
    const got = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(LENGTH(data)),0)::bigint AS bytes FROM kb_file_chunks WHERE link_id=$1 AND version=$2', [req.params.id, version]);
    if (+got.rows[0].bytes !== size) { await pool.query('DELETE FROM kb_file_chunks WHERE link_id=$1 AND version=$2', [req.params.id, version]); return res.status(400).json({ error: 'The upload was incomplete. Please try again.' }); }
    const cur = await pool.query('SELECT file_pending_name, file_size FROM kb_folder_links WHERE id=$1', [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Not found' });
    const name = cur.rows[0].file_pending_name; const c = checkName(name);
    const wasNew = cur.rows[0].file_size == null;
    await pool.query(`UPDATE kb_folder_links SET file_name=$1, file_type=$2, file_size=$3, file_version=$4, file_data=NULL, file_updated_at=NOW(), file_pending_name=NULL, is_visible = CASE WHEN $6 THEN TRUE ELSE is_visible END WHERE id=$5`, [name, c.type, size, version, req.params.id, wasNew]);
    await pool.query('DELETE FROM kb_file_chunks WHERE link_id=$1 AND version<>$2', [req.params.id, version]);
    res.json({ success: true, parts: got.rows[0].n });
  }));
  const loadFile = async (req, res) => {
    const r = await pool.query(`SELECT l.file_name, l.file_type, l.file_size, l.file_version, (l.file_data IS NOT NULL) AS legacy, l.is_visible, f.is_visible AS folder_visible FROM kb_folder_links l JOIN kb_folders f ON f.id = l.folder_id WHERE l.id=$1 AND l.file_size IS NOT NULL`, [req.params.id]);
    const x = r.rows[0];
    if (!x || (!isStaff(req.user) && !(x.is_visible && x.folder_visible))) { res.status(404).json({ error: 'File not found' }); return null; }
    return x;
  };
  app.get('/api/folder-files/:id/info', authMiddleware(), wrap(async (req, res) => {
    const x = await loadFile(req, res); if (!x) return;
    const n = x.legacy ? 1 : (await pool.query('SELECT COUNT(*)::int AS n FROM kb_file_chunks WHERE link_id=$1 AND version=$2', [req.params.id, x.file_version])).rows[0].n;
    res.json({ name: x.file_name, type: x.file_type, size: x.file_size, parts: n });
  }));
  app.get('/api/folder-files/:id/download', authMiddleware(), wrap(async (req, res) => {
    const x = await loadFile(req, res); if (!x) return;
    const part = Math.max(0, parseInt(req.query.part, 10) || 0);
    const d = x.legacy
      ? (await pool.query('SELECT file_data AS data FROM kb_folder_links WHERE id=$1', [req.params.id])).rows[0]
      : (await pool.query('SELECT data FROM kb_file_chunks WHERE link_id=$1 AND version=$2 AND idx=$3', [req.params.id, x.file_version, part])).rows[0];
    if (!d || (x.legacy && part > 0)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', x.file_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${String(x.file_name).replace(/[^\w.\- ]/g, '_')}"`);
    res.send(d.data);
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

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
// FAQ imports carry long multi-language answers, so allow bigger JSON bodies than the 100kb default
app.use(express.json({ limit: '4mb' }));

// ─── AUTH ────────────────────────────────────────────────────────────────────
const pool = require('../lib/db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const authMiddleware = require('../lib/auth');

// ─── FAQ HELPERS ─────────────────────────────────────────────────────────────

// Adds the is_shortlisted flag and widens a few text columns (tags was
// VARCHAR(255) and subcategory VARCHAR(100) — too small for imported
// "key terms"). All statements are idempotent and safe to repeat.
let faqSchemaReady = null;
function ensureFaqSchema() {
  if (!faqSchemaReady) {
    faqSchemaReady = (async () => {
      await pool.query(`ALTER TABLE faqs ADD COLUMN IF NOT EXISTS is_shortlisted BOOLEAN DEFAULT false`);
      for (const col of ['tags', 'subcategory', 'third_level']) {
        try { await pool.query(`ALTER TABLE faqs ALTER COLUMN ${col} TYPE TEXT`); } catch (e) { /* column missing or already fine */ }
      }
    })().catch(err => { faqSchemaReady = null; throw err; });
  }
  return faqSchemaReady;
}

// Deletes FAQs plus every row in other tables that references them
// (bookmarks, ratings, ...), discovered from the database itself so a newly
// added table can't break deletion. All-or-nothing: runs in one transaction.
async function deleteFaqsWithDependents(ids) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fk = await client.query(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'faqs' AND ccu.column_name = 'id'
        AND tc.table_name <> 'faqs'
    `);
    const clearedTables = [];
    for (const { table_name, column_name } of fk.rows) {
      await client.query(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1::int[])`, [ids]);
      clearedTables.push(table_name);
    }
    const r = await client.query(`DELETE FROM faqs WHERE id = ANY($1::int[]) RETURNING id`, [ids]);
    await client.query('COMMIT');
    return { deleted: r.rows.length, clearedTables };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The master sheet says "Service Request"; the app's category is "Service Requests".
const FAQ_CATEGORY_ALIASES = {
  'inquiries': 'Inquiries', 'inquiry': 'Inquiries',
  'billing complaints': 'Billing Complaints', 'billing complaint': 'Billing Complaints',
  'general complaints': 'General Complaints', 'general complaint': 'General Complaints',
  'service request': 'Service Requests', 'service requests': 'Service Requests',
  'feedback & others': 'Feedback & Others', 'feedback and others': 'Feedback & Others',
  'new updates': 'New Updates',
};
function normalizeFaqCategory(c) {
  const raw = (c || '').toString().trim();
  return FAQ_CATEGORY_ALIASES[raw.toLowerCase()] || raw || 'General';
}

// GET /api/public/stats
// Unauthenticated — powers the login screen's live counters.
// Only returns aggregate counts, never names/emails/per-record data.
app.get('/api/public/stats', async (req, res) => {
  try {
    const [users, faqs, categories] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users WHERE is_active = true'),
      pool.query('SELECT COUNT(*) FROM faqs WHERE is_published = true'),
      pool.query('SELECT COUNT(DISTINCT category) FROM faqs WHERE is_published = true'),
    ]);
    res.json({
      totalUsers: parseInt(users.rows[0].count, 10),
      totalFAQs: parseInt(faqs.rows[0].count, 10),
      totalCategories: parseInt(categories.rows[0].count, 10),
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { identifier, password } = req.body;
  try {
    const r = await pool.query(
  `
  SELECT *
  FROM users
  WHERE is_active = true
    AND (
      (role = 'agent' AND wave_id = $1)
      OR
      (role <> 'agent' AND LOWER(email) = LOWER($1))
    )
  LIMIT 1
  `,
  [identifier.trim()]
);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password);
if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

if (user.mfa_enabled) {
  const challengeToken = jwt.sign(
    {
      userId: user.id,
      purpose: 'mfa'
    },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );

  return res.json({
    mfaRequired: true,
    challengeToken
  });
}

const token = jwt.sign(
  {
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    title: user.title
  },
  process.env.JWT_SECRET,
  { expiresIn: '30d' }
);

    await pool.query('UPDATE users SET last_seen=NOW() WHERE id=$1', [user.id]);
    await pool.query(`INSERT INTO active_sessions(user_id,last_ping) VALUES($1,NOW()) ON CONFLICT(user_id) DO UPDATE SET last_ping=NOW()`, [user.id]).catch(() => {});
    await pool.query(`INSERT INTO activity_log(user_id,action,details) VALUES($1,'LOGIN',$2)`, [user.id, `Login`]).catch(() => {});
    await pool.query(`INSERT INTO login_events(user_id) VALUES($1)`, [user.id]).catch(() => {});
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, title: user.title } });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware(), async (req, res) => {
  const r = await pool.query(
    'SELECT id,name,email,role,title,mfa_enabled FROM users WHERE id=$1',
    [req.user.id]
  ).catch(() => null);
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

app.post('/api/auth/mfa/setup', authMiddleware(), async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({
      name: `Runaki-KB (${req.user.email})`
    });

    const result = await pool.query(
      `
      UPDATE users
      SET mfa_secret = $1
      WHERE id = $2
      RETURNING id,email,mfa_secret
      `,
      [secret.base32, req.user.id]
    );

    console.log('UPDATE RESULT:', result.rows);

    const qrCode = await QRCode.toDataURL(secret.otpauth_url);

    res.json({
      success: true,
      secret: secret.base32,
      qrCode
    });
  } catch (err) {
    console.error('MFA SETUP ERROR:', err);

    res.status(500).json({
      error: err.message
    });
  }
});

app.post('/api/auth/mfa/verify', authMiddleware(), async (req, res) => {
  try {
    console.log('VERIFY USER:', req.user);

    const { code } = req.body;

    const r = await pool.query(
      'SELECT id, email, mfa_secret FROM users WHERE id = $1',
      [req.user.id]
    );

    console.log('DB RESULT:', r.rows);


    if (!r.rows.length || !r.rows[0].mfa_secret) {
      return res.status(400).json({
        error: 'MFA secret not found'
      });
    }

    const verified = speakeasy.totp.verify({
      secret: r.rows[0].mfa_secret,
      encoding: 'base32',
      token: code,
      window: 1
    });

    if (!verified) {
      return res.status(400).json({
        error: 'Invalid MFA code'
      });
    }

    await pool.query(
      `UPDATE users SET mfa_enabled = true WHERE id = $1`,
      [req.user.id]
    );

    res.json({
      success: true
    });

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.post('/api/auth/mfa/login', async (req, res) => {
  try {
    const { challengeToken, code } = req.body;

    let payload;

try {
  payload = jwt.verify(
    challengeToken,
    process.env.JWT_SECRET,
    { algorithms: ['HS256'] }
  );
} catch (err) {
  return res.status(401).json({
    error: 'Invalid or expired MFA challenge'
  });
}

    if (payload.purpose !== 'mfa') {
      return res.status(401).json({
        error: 'Invalid challenge token'
      });
    }

    const userId = payload.userId;

    const r = await pool.query(
      'SELECT * FROM users WHERE id=$1 AND is_active=true AND mfa_enabled=true',
      [userId]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const user = r.rows[0];

   const verified = speakeasy.totp.verify({
  secret: user.mfa_secret,
  encoding: 'base32',
  token: code,
  window: 1
});


    if (!verified) {
      return res.status(401).json({
        error: 'Invalid MFA code'
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        title: user.title
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    await pool.query(
  'UPDATE users SET last_seen=NOW() WHERE id=$1',
  [user.id]
).catch(() => {});

await pool.query(
  `INSERT INTO active_sessions(user_id,last_ping)
   VALUES($1,NOW())
   ON CONFLICT(user_id)
   DO UPDATE SET last_ping=NOW()`,
  [user.id]
).catch(() => {});

await pool.query(
  `INSERT INTO activity_log(user_id,action,details)
   VALUES($1,'LOGIN',$2)`,
  [user.id, 'MFA Login']
).catch(() => {});

await pool.query(
  `INSERT INTO login_events(user_id)
   VALUES($1)`,
  [user.id]
).catch(() => {});


    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        title: user.title
      }
    });

    

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }

});

app.post('/api/auth/mfa/disable', authMiddleware(), async (req, res) => {
  try {
    await pool.query(
      `UPDATE users
       SET mfa_enabled = false,
           mfa_secret = null
       WHERE id = $1`,
      [req.user.id]
    );


    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});


// ─── USERS ───────────────────────────────────────────────────────────────────
app.get('/api/users', authMiddleware(['team_lead']), async (req, res) => {
  const r = await pool.query(`
    SELECT
      id,
      name,
      email,
      role,
      title,
      wave_id,
      is_active,
      mfa_enabled,
      created_at,
      last_seen
    FROM users
    ORDER BY name
  `).catch(() => null);

  r
    ? res.json(r.rows)
    : res.status(500).json({ error: 'Server error' });
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
  const { name, email, role, title, password, wave_id } = req.body;

  const updates = [];
  const vals = [];

  if (name) {
    updates.push(`name=$${updates.length + 1}`);
    vals.push(name);
  }

  if (email) {
    updates.push(`email=$${updates.length + 1}`);
    vals.push(email.toLowerCase());
  }

  if (role) {
    updates.push(`role=$${updates.length + 1}`);
    vals.push(role);
  }

  if (title !== undefined) {
    updates.push(`title=$${updates.length + 1}`);
    vals.push(title);
  }

  if (wave_id !== undefined) {
    updates.push(`wave_id=$${updates.length + 1}`);
    vals.push(wave_id ? wave_id.toString().trim() : null);
  }

  if (password) {
  const hashed = await bcrypt.hash(password, 10);
  updates.push(`password=$${updates.length + 1}`);
  vals.push(hashed);
}

  if (!updates.length) {
    return res.json({ success: true });
  }

  vals.push(req.params.id);

  try {
    await pool.query(
      `UPDATE users SET ${updates.join(',')} WHERE id=$${vals.length}`,
      vals
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That Wave ID or email is already in use.' });
    res.status(500).json({ error: 'Server error' });
  }
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

// NOTE: these two routes must stay registered BEFORE '/api/users/:id' below —
// Express matches routes top-to-bottom, and ':id' matches any single path
// segment, including the literal word "bulk-agents". Registered in the wrong
// order, every call here would silently hit the single-user delete instead
// (id="bulk-agents" matches no real user, so it would appear to succeed
// while deleting nothing — exactly the bug this ordering fixes).
app.delete('/api/users/bulk-agents', authMiddleware(['team_lead']), async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Refusing to bulk-delete without confirm:true in the request body.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const agentRows = await client.query(`SELECT id FROM users WHERE LOWER(TRIM(role)) = 'agent'`);
    const agentIds = agentRows.rows.map(r => r.id);

    if (!agentIds.length) {
      await client.query('COMMIT');
      return res.json({ deletedCount: 0, matchedBefore: 0, remainingAfter: 0, clearedTables: [] });
    }

    // Find every table with a foreign key pointing at users(id) and clear
    // matching rows there first. This is discovered from the database
    // itself rather than a hardcoded table list, so it automatically covers
    // activity_log, bookmarks, ratings, feedback, etc. — including any
    // table added later that references users, without this code needing
    // to be updated every time a new feature adds a user_id column.
    const fkResult = await client.query(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'users'
        AND ccu.column_name = 'id'
        AND tc.table_name <> 'users'
    `);

    const clearedTables = [];
    for (const { table_name, column_name } of fkResult.rows) {
      await client.query(`DELETE FROM "${table_name}" WHERE "${column_name}" = ANY($1::int[])`, [agentIds]);
      clearedTables.push(table_name);
    }

    const r = await client.query(`DELETE FROM users WHERE id = ANY($1::int[]) RETURNING id`, [agentIds]);
    await client.query('COMMIT');

    res.json({
      deletedCount: r.rows.length,
      matchedBefore: agentIds.length,
      remainingAfter: agentIds.length - r.rows.length,
      clearedTables,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/users/:id', authMiddleware(['team_lead']), async (req, res) => {
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]).catch(() => {});
  res.json({ ok: true });
});

app.post('/api/users', authMiddleware(['team_lead']), async (req, res) => {
  const { name, email, password, role, title, wave_id } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const waveId = wave_id ? wave_id.toString().trim() : null;
    const r = await pool.query(
      'INSERT INTO users(name,email,password,role,title,wave_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,title,wave_id',
      [name, email.toLowerCase(), hash, role, title, waveId]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That Wave ID or email is already in use.' });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/users/bulk-agents — team_lead only.
// Creates many agent accounts at once. Each agent logs in with their Wave ID
// as the identifier and a password of the form Wave@<waveId> — matching the
// existing login query, which already resolves agents by wave_id. Re-running
// this with the same list is safe: existing wave_ids are skipped, not
// duplicated or overwritten.
app.post('/api/users/bulk-agents', authMiddleware(['team_lead']), async (req, res) => {
  const { agents } = req.body;
  if (!Array.isArray(agents) || !agents.length) {
    return res.status(400).json({ error: 'agents array required' });
  }
  const created = [];
  const skipped = [];
  const failed = [];
  for (const a of agents) {
    const waveId = (a.wave_id || '').toString().trim();
    const name = (a.name || '').toString().trim();
    const title = (a.title || '').toString().trim();
    const providedEmail = (a.email || '').toString().trim().toLowerCase();
    if (!waveId || !name) {
      failed.push({ ...a, reason: 'missing name or wave_id' });
      continue;
    }
    const email = providedEmail || `wave${waveId}@agents.runaki.local`;
    try {
      const exists = await pool.query('SELECT id FROM users WHERE wave_id=$1 OR email=$2', [waveId, email]);
      if (exists.rows.length) {
        skipped.push({ wave_id: waveId, name, reason: 'wave_id or email already exists' });
        continue;
      }
      const password = `Wave@${waveId}`;
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        `INSERT INTO users(name, email, password, role, title, wave_id)
         VALUES ($1,$2,$3,'agent',$4,$5)`,
        [name, email, hash, title || null, waveId]
      );
      created.push({ wave_id: waveId, name, email });
    } catch (err) {
      failed.push({ wave_id: waveId, name, reason: err.message });
    }
  }
  res.json({ created, skipped, failed, summary: `${created.length} created, ${skipped.length} skipped, ${failed.length} failed` });
});

// POST /api/users/bulk-staff — team_lead only.
// Bulk-creates management/QA/coordinator/trainer accounts. These get FAQ
// editor access (role: qa_officer), never admin — admin stays exclusive to
// team_lead. Unlike agents, staff have no Wave ID, so each account gets a
// strong randomly generated password instead of a predictable pattern —
// these accounts can edit official FAQ content, so a guessable password
// scheme is a real risk here in a way it isn't for read-mostly agent
// accounts. The plaintext passwords are only ever returned in this one
// response, never stored or logged — copy them out before closing this.
const crypto = require('crypto');
function generateStaffPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, c => ({ '+': '8', '/': '9', '=': '' }[c]));
}

app.post('/api/users/bulk-staff', authMiddleware(['team_lead']), async (req, res) => {
  const { staff } = req.body;
  if (!Array.isArray(staff) || !staff.length) {
    return res.status(400).json({ error: 'staff array required' });
  }
  const created = [];
  const skipped = [];
  const failed = [];
  for (const s of staff) {
    const name = (s.name || '').toString().trim();
    const email = (s.email || '').toString().trim().toLowerCase();
    const title = (s.title || '').toString().trim();
    if (!name || !email) {
      failed.push({ ...s, reason: 'missing name or email' });
      continue;
    }
    try {
      const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
      if (exists.rows.length) {
        skipped.push({ name, email, reason: 'email already exists' });
        continue;
      }
      const password = generateStaffPassword();
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        `INSERT INTO users(name, email, password, role, title) VALUES ($1,$2,$3,'qa_officer',$4)`,
        [name, email, hash, title || null]
      );
      created.push({ name, email, title, password });
    } catch (err) {
      failed.push({ name, email, reason: err.message });
    }
  }
  res.json({ created, skipped, failed, summary: `${created.length} created, ${skipped.length} skipped, ${failed.length} failed` });
});

// ─── FEEDBACK ────────────────────────────────────────────────────────────────

app.get('/api/feedback/my-feedback', authMiddleware(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT *
      FROM feedback_messages
      WHERE LOWER(agent_email) = LOWER($1)
      ORDER BY created_at DESC
      `,
      [req.user.email]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
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

// PATCH /api/faqs/:id/shortlist — QA officer / team lead only.
// Toggles whether an FAQ appears in the agent-facing "Shortlisted FAQ's" tab.
// Lazily adds the column so no manual migration is needed.
app.patch('/api/faqs/:id/shortlist', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  try {
    await pool.query(`ALTER TABLE faqs ADD COLUMN IF NOT EXISTS is_shortlisted BOOLEAN DEFAULT false`);
    const r = await pool.query(
      `UPDATE faqs SET is_shortlisted = NOT COALESCE(is_shortlisted, false) WHERE id=$1 RETURNING is_shortlisted`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'FAQ not found' });
    res.json({ is_shortlisted: r.rows[0].is_shortlisted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
const {
  category,
  subcategory,
  question_en,
  answer_en,
  question_ku,
  answer_ku,
  question_ba,
  answer_ba,
  question_ar,
  answer_ar,
  tags,
  is_published,
  third_level,
  is_shortlisted
} = req.body;

  try {
   await ensureFaqSchema();
   const r = await pool.query(`
  INSERT INTO faqs(
    category,
    subcategory,
    question_en,
    answer_en,
    question_ku,
    answer_ku,
    question_ba,
    answer_ba,
    question_ar,
    answer_ar,
    tags,
    is_published,
    created_by,
    third_level,
    is_shortlisted
  )
  VALUES(
    $1,$2,$3,$4,$5,$6,
    $7,$8,$9,$10,
    $11,$12,$13,
    $14,$15
  )
  RETURNING *
`, [
  category,
  subcategory || null,
  question_en,
  answer_en,
  question_ku || null,
  answer_ku || null,
  question_ba || null,
  answer_ba || null,
  question_ar || null,
  answer_ar || null,
  tags || null,
  is_published || false,
  req.user.id,
  third_level || null,
  is_shortlisted === true
]);
    await pool.query(`INSERT INTO activity_log(user_id,action,details) VALUES($1,'CREATE_FAQ',$2)`, [req.user.id, `Created FAQ: "${question_en}"`]);
    res.status(201).json(r.rows[0]);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/faqs/:id', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
 const {
  category,
  subcategory,
  question_en,
  answer_en,
  question_ku,
  answer_ku,
  question_ba,
  answer_ba,
  question_ar,
  answer_ar,
  tags,
  is_published,
  third_level,
  is_shortlisted
} = req.body;

 try {
  await ensureFaqSchema();
  const r = await pool.query(`
    UPDATE faqs SET
      category=$1,
      subcategory=$2,
      question_en=$3,
      answer_en=$4,
      question_ku=$5,
      answer_ku=$6,
      question_ba=$7,
      answer_ba=$8,
      question_ar=$9,
      answer_ar=$10,
      tags=$11,
      is_published=$12,
      updated_by=$13,
      third_level=COALESCE($15, third_level),
      is_shortlisted=COALESCE($16, is_shortlisted),
      updated_at=NOW()
    WHERE id=$14
    RETURNING *
  `, [
    category,
    subcategory || null,
    question_en,
    answer_en,
    question_ku || null,
    answer_ku || null,
    question_ba || null,
    answer_ba || null,
    question_ar || null,
    answer_ar || null,
    tags || null,
    is_published,
    req.user.id,
    req.params.id,
    third_level === undefined ? null : third_level,
    typeof is_shortlisted === 'boolean' ? is_shortlisted : null
  ]);

  res.json(r.rows[0]);
} catch {
  res.status(500).json({ error: 'Server error' });
}
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

app.post(
  '/api/faqs/bulk-delete',
  authMiddleware(['team_lead', 'qa_officer']),
  async (req, res) => {
    try {
      const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
      if (!ids.length) {
        return res.status(400).json({ error: 'No IDs supplied' });
      }
      const result = await deleteFaqsWithDependents(ids);
      res.json({ success: true, deleted: result.deleted, clearedTables: result.clearedTables });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message || 'Failed to delete FAQs' });
    }
  }
);
app.delete('/api/faqs/:id', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid FAQ id' });
    const result = await deleteFaqsWithDependents([id]);
    res.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete FAQ' });
  }
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

// ─── MAINTENANCE MODE ────────────────────────────────────────────────────────
// Stored in DB as a simple key-value in a settings table
// GET  /api/maintenance        → public, returns { active, message }
// POST /api/maintenance        → team_lead only, sets active + message
// Lazy-create settings table if needed

app.get('/api/maintenance', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key   VARCHAR(100) PRIMARY KEY,
        value TEXT
      )
    `);
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'maintenance'`);
    if (!rows.length) return res.json({ active: false, message: '' });
    const data = JSON.parse(rows[0].value);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/maintenance', authMiddleware(['team_lead']), async (req, res) => {
  const { active, message } = req.body;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key   VARCHAR(100) PRIMARY KEY,
        value TEXT
      )
    `);
    await pool.query(`
      INSERT INTO settings (key, value)
      VALUES ('maintenance', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1
    `, [JSON.stringify({ active: !!active, message: message || '' })]);
    res.json({ success: true, active: !!active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── EVALUATIONS ─────────────────────────────────────────────────────────────

// Upload evaluations from parsed Excel JSON (sent from frontend)
app.post('/api/evaluations/upload', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'No rows provided' });

  try {
    let inserted = 0;
    for (const r of rows) {
      // Skip rows with no agent email or name
      if (!r.agent_email && !r.agent_name) continue;

      // Parse date safely
      let evalDate = null;
      if (r.evaluation_date) {
        try { evalDate = new Date(r.evaluation_date).toISOString().split('T')[0]; } catch {}
      }

      await pool.query(`
        INSERT INTO evaluations (
          agent_name, agent_email, coordinator, qa_officer, subject,
          phone_number, ticket_id, waiting_time, call_duration,
          greeting_script, customer_info, faq_alignment, correct_tagging,
          communication, tone_of_voice, ending, rude_behaviour, hang_up, active_listening,
          improvement_areas, overall_score, positive_comments, bad_comments,
          feedback, hold_unhold, coaching_status, evaluation_date
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,
          $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
          $20,$21,$22,$23,$24,$25,$26,$27
        )
        ON CONFLICT (agent_email, ticket_id, evaluation_date, qa_officer)
        DO UPDATE SET
          coaching_status   = EXCLUDED.coaching_status,
          overall_score     = EXCLUDED.overall_score,
          improvement_areas = EXCLUDED.improvement_areas,
          positive_comments = EXCLUDED.positive_comments,
          bad_comments      = EXCLUDED.bad_comments,
          feedback          = EXCLUDED.feedback,
          greeting_script   = EXCLUDED.greeting_script,
          customer_info     = EXCLUDED.customer_info,
          faq_alignment     = EXCLUDED.faq_alignment,
          correct_tagging   = EXCLUDED.correct_tagging,
          communication     = EXCLUDED.communication,
          tone_of_voice     = EXCLUDED.tone_of_voice,
          ending            = EXCLUDED.ending,
          rude_behaviour    = EXCLUDED.rude_behaviour,
          hang_up           = EXCLUDED.hang_up,
          active_listening  = EXCLUDED.active_listening
      `, [
        r.agent_name || null,
        (r.agent_email || '').toLowerCase().trim() || null,
        r.coordinator || null,
        r.qa_officer || null,
        r.subject || null,
        r.phone_number || null,
        r.ticket_id || null,
        r.waiting_time || null,
        r.call_duration || null,
        parseInt(r.greeting_script) || 0,
        parseInt(r.customer_info) || 0,
        parseInt(r.faq_alignment) || 0,
        parseInt(r.correct_tagging) || 0,
        parseInt(r.communication) || 0,
        parseInt(r.tone_of_voice) || 0,
        parseInt(r.ending) || 0,
        parseInt(r.rude_behaviour) || 0,
        parseInt(r.hang_up) || 0,
        parseInt(r.active_listening) || 0,
        r.improvement_areas || null,
        parseFloat(r.overall_score) || null,
        r.positive_comments || null,
        r.bad_comments || null,
        r.feedback || null,
        r.hold_unhold || null,
        r.coaching_status || null,
        evalDate
      ]);
      inserted++;
    }
    res.json({ success: true, inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get evaluations for logged-in agent.
// Matched by email; agents imported by Wave ID have a placeholder email, so for them the
// name on the evaluation sheet is matched too.
app.get('/api/evaluations/mine', authMiddleware(), async (req, res) => {
  try {
    const u = await pool.query('SELECT name, email FROM users WHERE id=$1', [req.user.id]);
    const email = ((u.rows[0] && u.rows[0].email) || req.user.email || '').toLowerCase().trim();
    const name = ((u.rows[0] && u.rows[0].name) || req.user.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const placeholder = email.endsWith('@agents.runaki.local');
    const { rows } = await pool.query(
      `SELECT * FROM evaluations
        WHERE LOWER(TRIM(agent_email)) = $1
           OR ($3::boolean AND $2 <> '' AND LOWER(REGEXP_REPLACE(TRIM(agent_name), '\\s+', ' ', 'g')) = $2)
        ORDER BY evaluation_date DESC, id DESC`,
      [email, name, placeholder]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all evaluations (admin/QA only)
app.get('/api/evaluations', authMiddleware(['qa_officer','team_lead']), async (req, res) => {
  try {
    const { agent_email, qa_officer, from, to } = req.query;
    let q = `SELECT * FROM evaluations WHERE 1=1`;
    const params = [];
    if (agent_email) { params.push(agent_email.toLowerCase()); q += ` AND LOWER(agent_email)=$${params.length}`; }
    if (qa_officer)  { params.push(qa_officer);  q += ` AND qa_officer=$${params.length}`; }
    if (from)        { params.push(from);         q += ` AND evaluation_date>=$${params.length}`; }
    if (to)          { params.push(to);           q += ` AND evaluation_date<=$${params.length}`; }
    q += ` ORDER BY evaluation_date DESC, id DESC LIMIT 500`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete all evaluations (for re-upload, team_lead only)
app.delete('/api/evaluations/all', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await pool.query(`TRUNCATE TABLE evaluations RESTART IDENTITY`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/faqs/import — qa_officer / team_lead.
// rows: normalized FAQ objects (the editor converts the Excel sheet first).
// shortlisted:true puts every imported FAQ in the "Shortlisted FAQ's" tab only
// (and keeps it out of the general category lists). Re-importing is safe:
// an FAQ whose English question already exists in the same list is skipped.
app.post('/api/faqs/import',
  authMiddleware(['qa_officer', 'team_lead']),
  async (req, res) => {
    const rows = req.body.rows;
    const shortlisted = req.body.shortlisted === true;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No FAQs provided' });
    }

    const clean = v => {
      if (v === undefined || v === null) return null;
      const t = v.toString().trim();
      return t === '' || t === '-' ? null : t;
    };

    const client = await pool.connect();
    try {
      await ensureFaqSchema();
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT id, LOWER(TRIM(question_en)) AS q FROM faqs WHERE COALESCE(is_shortlisted,false) = $1`,
        [shortlisted]
      );
      const seen = new Set(existing.rows.map(r => r.q));
      const existingId = new Map(existing.rows.map(r => [r.q, r.id]));
      const TRANSLATION_COLS = ['question_ku', 'answer_ku', 'question_ba', 'answer_ba', 'question_ar', 'answer_ar'];

      let imported = 0;
      let updated = 0;
      const skipped = [];

      for (let i = 0; i < rows.length; i++) {
        const faq = rows[i] || {};
        const question = clean(faq.question_en);
        const answer = clean(faq.answer_en);
        if (!question || !answer) {
          skipped.push({ row: i + 1, reason: 'missing English question or answer' });
          continue;
        }
        const key = question.toLowerCase();
        if (seen.has(key)) {
          // Already in the database: never overwrite anything, but DO fill translations that are still empty
          // (this is how a Badini column added later gets in without deleting and re-importing).
          const id = existingId.get(key);
          const sets = [];
          const vals = [];
          TRANSLATION_COLS.forEach(col => {
            const v = clean(faq[col]);
            if (id && v) {
              vals.push(v);
              sets.push(`${col} = CASE WHEN ${col} IS NULL OR TRIM(${col}) = '' THEN $${vals.length} ELSE ${col} END`);
            }
          });
          let changed = 0;
          if (sets.length) {
            vals.push(id);
            const before = await client.query(`SELECT ${TRANSLATION_COLS.join(', ')} FROM faqs WHERE id = $1`, [id]);
            await client.query(`UPDATE faqs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
            const after = await client.query(`SELECT ${TRANSLATION_COLS.join(', ')} FROM faqs WHERE id = $1`, [id]);
            changed = TRANSLATION_COLS.filter(c => (before.rows[0] || {})[c] !== (after.rows[0] || {})[c]).length;
          }
          if (changed > 0) updated++;
          else skipped.push({ row: i + 1, question, reason: 'already exists' });
          continue;
        }
        seen.add(key);

        await client.query(`
          INSERT INTO faqs (
            category, subcategory, third_level,
            question_en, answer_en,
            question_ku, answer_ku,
            question_ba, answer_ba,
            question_ar, answer_ar,
            tags, is_published, is_shortlisted, created_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14)
        `, [
          normalizeFaqCategory(faq.category),
          clean(faq.subcategory),
          clean(faq.third_level),
          question, answer,
          clean(faq.question_ku), clean(faq.answer_ku),
          clean(faq.question_ba), clean(faq.answer_ba),
          clean(faq.question_ar), clean(faq.answer_ar),
          clean(faq.tags),
          shortlisted,
          req.user.id
        ]);
        imported++;
      }

      await client.query('COMMIT');
      res.json({ success: true, imported, updated, skipped });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
});

// ─── UPDATE SCRIPTS ──────────────────────────────────────────────────────────

// GET /api/scripts — public, returns published script (agents)
app.get('/api/scripts/published', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS update_scripts (
        id SERIAL PRIMARY KEY, topic VARCHAR(300) NOT NULL,
        sorani TEXT, badini TEXT, arabic TEXT, english TEXT,
        is_published BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    const { rows } = await pool.query(
      `SELECT * FROM update_scripts WHERE is_published = TRUE LIMIT 1`
    );
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/scripts — all scripts (team lead only)
app.get('/api/scripts', authMiddleware(['team_lead']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM update_scripts ORDER BY updated_at DESC`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/scripts — create new script
app.post('/api/scripts', authMiddleware(['team_lead']), async (req, res) => {
  const { topic, sorani, badini, arabic, english } = req.body;
  if (!topic) return res.status(400).json({ error: 'Topic is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO update_scripts (topic, sorani, badini, arabic, english)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [topic, sorani||null, badini||null, arabic||null, english||null]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/scripts/:id — update script
app.put('/api/scripts/:id', authMiddleware(['team_lead']), async (req, res) => {
  const { topic, sorani, badini, arabic, english } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE update_scripts SET topic=$1, sorani=$2, badini=$3, arabic=$4, english=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [topic, sorani||null, badini||null, arabic||null, english||null, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/scripts/:id/publish — publish this, unpublish all others
app.patch('/api/scripts/:id/publish', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await pool.query(`UPDATE update_scripts SET is_published=FALSE`);
    const { rows } = await pool.query(
      `UPDATE update_scripts SET is_published=TRUE, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/scripts/:id/unpublish — archive (unpublish)
app.patch('/api/scripts/:id/unpublish', authMiddleware(['team_lead']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE update_scripts SET is_published=FALSE, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/scripts/:id
app.delete('/api/scripts/:id', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await pool.query(`DELETE FROM update_scripts WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date() });
  } catch(e) {
    res.status(500).json({ status: 'error', db: 'failed', error: e.message });
  }
});

app.get('/api/debug/db', async (req, res) => {
  try {
    const users = await pool.query(`
      SELECT id, email
      FROM users
      ORDER BY id
      LIMIT 10
    `);

    res.json(users.rows);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.get('/api/debug/me', authMiddleware(), async (req, res) => {
  res.json(req.user);
});

// ─────────────────────────────────────────────────────────────
// Editable page content (Scripts, Hold & Unhold, KYC pages) and external tools
// ─────────────────────────────────────────────────────────────
const PAGE_CONTENT_KEYS = ['scripts', 'hold', 'kyc'];
let contentTablesReady = null;
function ensureContentTables() {
  if (!contentTablesReady) {
    contentTablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS page_content (
          key VARCHAR(40) PRIMARY KEY,
          data JSONB NOT NULL,
          updated_by INTEGER,
          updated_at TIMESTAMP DEFAULT NOW()
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS external_tools (
          id SERIAL PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          icon VARCHAR(16) DEFAULT '🧩',
          url TEXT NOT NULL,
          sort_order INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW()
        )`);
    })().catch(err => { contentTablesReady = null; throw err; });
  }
  return contentTablesReady;
}

// Any signed-in user can read; returns { data: null } when nothing has been customised
app.get('/api/page-content/:key', authMiddleware(), async (req, res) => {
  if (!PAGE_CONTENT_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Unknown page' });
  try {
    await ensureContentTables();
    const { rows } = await pool.query('SELECT data, updated_at FROM page_content WHERE key = $1', [req.params.key]);
    res.json(rows[0] ? { data: rows[0].data, updated_at: rows[0].updated_at } : { data: null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/page-content/:key', authMiddleware(['team_lead']), async (req, res) => {
  if (!PAGE_CONTENT_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Unknown page' });
  const data = req.body && req.body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Invalid content' });
  try {
    await ensureContentTables();
    await pool.query(
      `INSERT INTO page_content (key, data, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [req.params.key, JSON.stringify(data), req.user.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reset to the built-in default text
app.delete('/api/page-content/:key', authMiddleware(['team_lead']), async (req, res) => {
  if (!PAGE_CONTENT_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Unknown page' });
  try {
    await ensureContentTables();
    await pool.query('DELETE FROM page_content WHERE key = $1', [req.params.key]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const cleanToolUrl = u => {
  const t = (u || '').toString().trim();
  return /^https?:\/\/[^\s]+$/i.test(t) ? t : null;
};

// Signed-in users see active tools; team leads can ask for all with ?all=1
app.get('/api/external-tools', authMiddleware(), async (req, res) => {
  try {
    await ensureContentTables();
    const isLead = (req.user.role || '').toString().trim().toLowerCase() === 'team_lead';
    const all = isLead && req.query.all === '1';
    const { rows } = await pool.query(
      `SELECT id, name, icon, url, sort_order, is_active FROM external_tools
       ${all ? '' : 'WHERE is_active = TRUE'} ORDER BY sort_order, id`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/external-tools', authMiddleware(['team_lead']), async (req, res) => {
  const name = (req.body.name || '').toString().trim();
  const url = cleanToolUrl(req.body.url);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!url) return res.status(400).json({ error: 'URL must start with http:// or https://' });
  try {
    await ensureContentTables();
    const { rows } = await pool.query(
      `INSERT INTO external_tools (name, icon, url, sort_order, is_active)
       VALUES ($1, $2, $3, COALESCE($4, 0), COALESCE($5, TRUE)) RETURNING *`,
      [name.slice(0, 120), (req.body.icon || '🧩').toString().slice(0, 16), url,
       Number.isFinite(+req.body.sort_order) ? +req.body.sort_order : 0, req.body.is_active]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/external-tools/:id', authMiddleware(['team_lead']), async (req, res) => {
  const name = (req.body.name || '').toString().trim();
  const url = cleanToolUrl(req.body.url);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!url) return res.status(400).json({ error: 'URL must start with http:// or https://' });
  try {
    await ensureContentTables();
    const { rows } = await pool.query(
      `UPDATE external_tools SET name=$1, icon=$2, url=$3, sort_order=$4, is_active=$5 WHERE id=$6 RETURNING *`,
      [name.slice(0, 120), (req.body.icon || '🧩').toString().slice(0, 16), url,
       Number.isFinite(+req.body.sort_order) ? +req.body.sort_order : 0, req.body.is_active !== false, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/external-tools/:id', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await ensureContentTables();
    await pool.query('DELETE FROM external_tools WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─────────────────────────────────────────────────────────────
// Ticket Descriptions (merged from the old "Agent Call Description Tool")
// ─────────────────────────────────────────────────────────────
let tdTablesReady = null;
function ensureTdTables() {
  if (!tdTablesReady) {
    tdTablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS td_categories (
          id SERIAL PRIMARY KEY,
          legacy_id TEXT UNIQUE,
          level1 TEXT NOT NULL,
          level2 TEXT,
          level3 TEXT,
          english TEXT NOT NULL,
          kurdish TEXT,
          keywords TEXT,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS td_copy_log (
          id SERIAL PRIMARY KEY,
          user_id INTEGER,
          user_name TEXT,
          category_id INTEGER,
          level1 TEXT, level2 TEXT, level3 TEXT,
          copied_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_td_copy_time ON td_copy_log (copied_at DESC);
        CREATE INDEX IF NOT EXISTS idx_td_copy_user ON td_copy_log (user_id);
        CREATE TABLE IF NOT EXISTS td_recent (
          user_id INTEGER NOT NULL,
          category_id INTEGER NOT NULL REFERENCES td_categories(id) ON DELETE CASCADE,
          pinned BOOLEAN NOT NULL DEFAULT FALSE,
          last_used TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (user_id, category_id)
        );
        CREATE TABLE IF NOT EXISTS td_flags (
          id SERIAL PRIMARY KEY,
          category_id INTEGER REFERENCES td_categories(id) ON DELETE CASCADE,
          user_name TEXT,
          note TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
    })().catch(err => { tdTablesReady = null; throw err; });
  }
  return tdTablesReady;
}

const tdClean = v => {
  if (v === undefined || v === null) return null;
  const t = v.toString().trim();
  return t === '' ? null : t;
};

// Active categories for everyone signed in; team leads can ask for all with ?all=1
app.get('/api/td/categories', authMiddleware(), async (req, res) => {
  try {
    await ensureTdTables();
    const isLead = (req.user.role || '').toString().trim().toLowerCase() === 'team_lead';
    const all = isLead && req.query.all === '1';
    const { rows } = await pool.query(
      `SELECT id, level1, level2, level3, english, kurdish, keywords, is_active, updated_at
       FROM td_categories ${all ? '' : 'WHERE is_active = TRUE'} ORDER BY level1, level2 NULLS FIRST, level3 NULLS FIRST, id`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/td/categories', authMiddleware(['team_lead']), async (req, res) => {
  const level1 = tdClean(req.body.level1), english = tdClean(req.body.english);
  if (!level1 || !english) return res.status(400).json({ error: 'Category and English text are required' });
  try {
    await ensureTdTables();
    const { rows } = await pool.query(
      `INSERT INTO td_categories (level1, level2, level3, english, kurdish, keywords, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,TRUE)) RETURNING *`,
      [level1, tdClean(req.body.level2), tdClean(req.body.level3), english, tdClean(req.body.kurdish), tdClean(req.body.keywords), req.body.is_active]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/td/categories/:id', authMiddleware(['team_lead']), async (req, res) => {
  const level1 = tdClean(req.body.level1), english = tdClean(req.body.english);
  if (!level1 || !english) return res.status(400).json({ error: 'Category and English text are required' });
  try {
    await ensureTdTables();
    const { rows } = await pool.query(
      `UPDATE td_categories SET level1=$1, level2=$2, level3=$3, english=$4, kurdish=$5, keywords=$6,
         is_active=COALESCE($7, is_active), updated_at=NOW() WHERE id=$8 RETURNING *`,
      [level1, tdClean(req.body.level2), tdClean(req.body.level3), english, tdClean(req.body.kurdish), tdClean(req.body.keywords), req.body.is_active, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/td/categories/:id', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await ensureTdTables();
    await pool.query('DELETE FROM td_categories WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Excel import: adds new rows; a row whose Category + Sub-category + Third-level already exists is skipped
app.post('/api/td/categories/import', authMiddleware(['team_lead']), async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });
  const key = (a, b, c) => [a, b, c].map(x => (x || '').toString().trim().toLowerCase()).join('|');
  try {
    await ensureTdTables();
    const existing = await pool.query('SELECT level1, level2, level3 FROM td_categories');
    const seen = new Set(existing.rows.map(r => key(r.level1, r.level2, r.level3)));
    let imported = 0; const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const level1 = tdClean(r.level1), english = tdClean(r.english);
      if (!level1 || !english) { skipped.push({ row: i + 1, reason: 'missing category or English text' }); continue; }
      const k = key(level1, r.level2, r.level3);
      if (seen.has(k)) { skipped.push({ row: i + 1, reason: 'already exists' }); continue; }
      seen.add(k);
      await pool.query(
        `INSERT INTO td_categories (level1, level2, level3, english, kurdish, keywords) VALUES ($1,$2,$3,$4,$5,$6)`,
        [level1, tdClean(r.level2), tdClean(r.level3), english, tdClean(r.kurdish), tdClean(r.keywords)]
      );
      imported++;
    }
    res.json({ success: true, imported, skipped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// An agent pressed "Copy": log it (once per user+category per 60 s) and remember it as recently used
app.post('/api/td/copy', authMiddleware(), async (req, res) => {
  const categoryId = parseInt(req.body.category_id, 10);
  if (!categoryId) return res.status(400).json({ error: 'category_id required' });
  try {
    await ensureTdTables();
    const cat = await pool.query('SELECT id, level1, level2, level3 FROM td_categories WHERE id = $1', [categoryId]);
    if (!cat.rows[0]) return res.status(404).json({ error: 'Not found' });
    const c = cat.rows[0];
    const dup = await pool.query(
      `SELECT 1 FROM td_copy_log WHERE user_id = $1 AND category_id = $2 AND copied_at > NOW() - INTERVAL '60 seconds' LIMIT 1`,
      [req.user.id, categoryId]
    );
    if (!dup.rows.length) {
      await pool.query(
        `INSERT INTO td_copy_log (user_id, user_name, category_id, level1, level2, level3) VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.user.id, req.user.name || null, categoryId, c.level1, c.level2, c.level3]
      );
    }
    await pool.query(
      `INSERT INTO td_recent (user_id, category_id, last_used) VALUES ($1,$2,NOW())
       ON CONFLICT (user_id, category_id) DO UPDATE SET last_used = NOW()`,
      [req.user.id, categoryId]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/td/recent', authMiddleware(), async (req, res) => {
  try {
    await ensureTdTables();
    const { rows } = await pool.query(
      `SELECT r.category_id, r.pinned, c.id, c.level1, c.level2, c.level3, c.english, c.kurdish, c.keywords
       FROM td_recent r JOIN td_categories c ON c.id = r.category_id AND c.is_active = TRUE
       WHERE r.user_id = $1 ORDER BY r.pinned DESC, r.last_used DESC LIMIT 6`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/td/recent/:categoryId/pin', authMiddleware(), async (req, res) => {
  try {
    await ensureTdTables();
    await pool.query(
      `INSERT INTO td_recent (user_id, category_id, pinned, last_used) VALUES ($1,$2,TRUE,NOW())
       ON CONFLICT (user_id, category_id) DO UPDATE SET pinned = NOT td_recent.pinned, last_used = NOW()`,
      [req.user.id, req.params.categoryId]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// "Flag as outdated"
app.post('/api/td/flags', authMiddleware(), async (req, res) => {
  try {
    await ensureTdTables();
    await pool.query(
      `INSERT INTO td_flags (category_id, user_name, note) VALUES ($1,$2,$3)`,
      [parseInt(req.body.category_id, 10) || null, req.user.name || null, tdClean(req.body.note)]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/td/flags', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await ensureTdTables();
    const { rows } = await pool.query(
      `SELECT f.id, f.user_name, f.note, f.status, f.created_at, c.level1, c.level2, c.level3
       FROM td_flags f LEFT JOIN td_categories c ON c.id = f.category_id
       ORDER BY (f.status = 'open') DESC, f.created_at DESC LIMIT 300`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/td/flags/:id', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await ensureTdTables();
    await pool.query(`UPDATE td_flags SET status = $1 WHERE id = $2`, [req.body.status === 'open' ? 'open' : 'resolved', req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// One-time import from the old site's backup file. The browser sends it one table at a time, in small batches.
// Log rows arrive with the agent's wave_id so they can be attached to the matching KB account.
app.post('/api/td/import-backup', authMiddleware(['team_lead']), async (req, res) => {
  const { table, rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });
  try {
    await ensureTdTables();
    let done = 0;
    if (table === 'categories') {
      for (const r of rows) {
        if (!r.id || !tdClean(r.level1) || !tdClean(r.english)) continue;
        const q = await pool.query(
          `INSERT INTO td_categories (legacy_id, level1, level2, level3, english, kurdish, keywords, is_active, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,TRUE),COALESCE($9,NOW()),COALESCE($10,NOW()))
           ON CONFLICT (legacy_id) DO NOTHING`,
          [String(r.id), tdClean(r.level1), tdClean(r.level2), tdClean(r.level3), tdClean(r.english), tdClean(r.kurdish), tdClean(r.keywords), r.is_active, r.created_at, r.updated_at]
        );
        done += q.rowCount;
      }
    } else if (table === 'copy_log') {
      const waves = [...new Set(rows.map(r => r.wave_id).filter(Boolean))];
      const u = waves.length ? await pool.query('SELECT id, wave_id FROM users WHERE wave_id = ANY($1)', [waves]) : { rows: [] };
      const byWave = new Map(u.rows.map(x => [x.wave_id, x.id]));
      const legacy = [...new Set(rows.map(r => r.category_id).filter(Boolean).map(String))];
      const c = legacy.length ? await pool.query('SELECT id, legacy_id FROM td_categories WHERE legacy_id = ANY($1)', [legacy]) : { rows: [] };
      const byLegacy = new Map(c.rows.map(x => [x.legacy_id, x.id]));
      for (const r of rows) {
        // the old export has no unique key for log rows, so skip a row that is already there (same person, category and second)
        const uid = byWave.get(r.wave_id) || null;
        const cid = r.category_id ? byLegacy.get(String(r.category_id)) || null : null;
        const q = await pool.query(
          `INSERT INTO td_copy_log (user_id, user_name, category_id, level1, level2, level3, copied_at)
           SELECT $1,$2,$3,$4,$5,$6,$7::timestamp
           WHERE NOT EXISTS (SELECT 1 FROM td_copy_log WHERE user_name IS NOT DISTINCT FROM $2 AND copied_at = $7::timestamp AND level1 IS NOT DISTINCT FROM $4 AND level2 IS NOT DISTINCT FROM $5 AND level3 IS NOT DISTINCT FROM $6)`,
          [uid, tdClean(r.account_name), cid, tdClean(r.level1), tdClean(r.level2), tdClean(r.level3), r.copied_at]
        );
        done += q.rowCount;
      }
    } else if (table === 'flags') {
      for (const r of rows) {
        const c = r.category_id ? await pool.query('SELECT id FROM td_categories WHERE legacy_id = $1', [String(r.category_id)]) : { rows: [] };
        const q = await pool.query(
          `INSERT INTO td_flags (category_id, user_name, note, status, created_at) VALUES ($1,$2,$3,$4,COALESCE($5,NOW()))`,
          [c.rows[0] ? c.rows[0].id : null, tdClean(r.account_name), tdClean(r.note), r.status === 'resolved' ? 'resolved' : 'open', r.created_at]
        );
        done += q.rowCount;
      }
    } else if (table === 'zones') {
      await ensureZoneTables();
      const ok = rows.filter(r => tdClean(r.city) && tdClean(r.neighborhood) && tdClean(r.zone));
      if (ok.length) {
        const q = await pool.query(
          `INSERT INTO td_zones (city, neighborhood, zone, keywords, is_active)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::boolean[])
           ON CONFLICT (city, neighborhood, zone) DO NOTHING`,
          [ok.map(r => tdClean(r.city)), ok.map(r => tdClean(r.neighborhood)), ok.map(r => tdClean(r.zone)), ok.map(r => tdClean(r.keywords)), ok.map(r => r.is_active !== false)]
        );
        done += q.rowCount;
      }
    } else if (table === 'zone_lookup_log') {
      await ensureZoneTables();
      const waves = [...new Set(rows.map(r => r.wave_id).filter(Boolean))];
      const u = waves.length ? await pool.query('SELECT id, wave_id FROM users WHERE wave_id = ANY($1)', [waves]) : { rows: [] };
      const byWave = new Map(u.rows.map(x => [x.wave_id, x.id]));
      for (const r of rows) {
        const z = await pool.query('SELECT id FROM td_zones WHERE city=$1 AND neighborhood=$2 AND zone=$3', [tdClean(r.city), tdClean(r.neighborhood), tdClean(r.zone)]);
        const q = await pool.query(
          `INSERT INTO td_zone_log (user_id, user_name, zone_id, city, neighborhood, zone, looked_up_at)
           SELECT $1,$2,$3,$4,$5,$6,$7::timestamp
           WHERE NOT EXISTS (SELECT 1 FROM td_zone_log WHERE user_name IS NOT DISTINCT FROM $2 AND looked_up_at = $7::timestamp AND zone IS NOT DISTINCT FROM $6 AND neighborhood IS NOT DISTINCT FROM $5)`,
          [byWave.get(r.wave_id) || null, tdClean(r.account_name), z.rows[0] ? z.rows[0].id : null, tdClean(r.city), tdClean(r.neighborhood), tdClean(r.zone), r.looked_up_at]
        );
        done += q.rowCount;
      }
    } else {
      return res.status(400).json({ error: 'Unknown table' });
    }
    res.json({ success: true, done, received: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ─────────────────────────────────────────────────────────────
// Zones lookup (merged from the old tool)
// ─────────────────────────────────────────────────────────────
let zoneTablesReady = null;
function ensureZoneTables() {
  if (!zoneTablesReady) {
    zoneTablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS td_zones (
          id SERIAL PRIMARY KEY,
          city TEXT NOT NULL,
          neighborhood TEXT NOT NULL,
          zone TEXT NOT NULL,
          keywords TEXT,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE (city, neighborhood, zone)
        );
        CREATE TABLE IF NOT EXISTS td_zone_log (
          id SERIAL PRIMARY KEY,
          user_id INTEGER,
          user_name TEXT,
          zone_id INTEGER,
          city TEXT, neighborhood TEXT, zone TEXT,
          looked_up_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_td_zone_log_time ON td_zone_log (looked_up_at DESC);
      `);
    })().catch(err => { zoneTablesReady = null; throw err; });
  }
  return zoneTablesReady;
}

const isLeadReq = req => (req.user.role || '').toString().trim().toLowerCase() === 'team_lead';

app.get('/api/td/zones', authMiddleware(), async (req, res) => {
  try {
    await ensureZoneTables();
    const all = isLeadReq(req) && req.query.all === '1';
    const { rows } = await pool.query(
      `SELECT id, city, neighborhood, zone, keywords, is_active FROM td_zones ${all ? '' : 'WHERE is_active = TRUE'} ORDER BY city, neighborhood, id`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/td/zones', authMiddleware(['team_lead']), async (req, res) => {
  const city = tdClean(req.body.city), neighborhood = tdClean(req.body.neighborhood), zone = tdClean(req.body.zone);
  if (!city || !neighborhood || !zone) return res.status(400).json({ error: 'City, neighborhood and zone are required' });
  try {
    await ensureZoneTables();
    const { rows } = await pool.query(
      `INSERT INTO td_zones (city, neighborhood, zone, keywords, is_active) VALUES ($1,$2,$3,$4,COALESCE($5,TRUE)) RETURNING *`,
      [city, neighborhood, zone, tdClean(req.body.keywords), req.body.is_active]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That zone already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/td/zones/:id', authMiddleware(['team_lead']), async (req, res) => {
  const city = tdClean(req.body.city), neighborhood = tdClean(req.body.neighborhood), zone = tdClean(req.body.zone);
  if (!city || !neighborhood || !zone) return res.status(400).json({ error: 'City, neighborhood and zone are required' });
  try {
    await ensureZoneTables();
    const { rows } = await pool.query(
      `UPDATE td_zones SET city=$1, neighborhood=$2, zone=$3, keywords=$4, is_active=COALESCE($5,is_active), updated_at=NOW() WHERE id=$6 RETURNING *`,
      [city, neighborhood, zone, tdClean(req.body.keywords), req.body.is_active, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That zone already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/td/zones/:id', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await ensureZoneTables();
    await pool.query('DELETE FROM td_zones WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/td/zones/bulk-delete', authMiddleware(['team_lead']), async (req, res) => {
  const ids = (req.body.ids || []).map(n => parseInt(n, 10)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'No ids' });
  try {
    await ensureZoneTables();
    const q = await pool.query('DELETE FROM td_zones WHERE id = ANY($1)', [ids]);
    res.json({ success: true, deleted: q.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Excel import: rows {city, neighborhood, zone, keywords}; ones that already exist are skipped
app.post('/api/td/zones/import', authMiddleware(['team_lead']), async (req, res) => {
  const rows = req.body.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });
  try {
    await ensureZoneTables();
    const ok = rows.filter(r => r && tdClean(r.city) && tdClean(r.neighborhood) && tdClean(r.zone));
    let imported = 0;
    if (ok.length) {
      const q = await pool.query(
        `INSERT INTO td_zones (city, neighborhood, zone, keywords)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
         ON CONFLICT (city, neighborhood, zone) DO NOTHING`,
        [ok.map(r => tdClean(r.city)), ok.map(r => tdClean(r.neighborhood)), ok.map(r => tdClean(r.zone)), ok.map(r => tdClean(r.keywords))]
      );
      imported = q.rowCount;
    }
    res.json({ success: true, imported, skipped: rows.length - imported });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// An agent opened a zone: log it once per user+zone per 60 s
app.post('/api/td/zone-lookup', authMiddleware(), async (req, res) => {
  const zoneId = parseInt(req.body.zone_id, 10);
  if (!zoneId) return res.status(400).json({ error: 'zone_id required' });
  try {
    await ensureZoneTables();
    const z = await pool.query('SELECT id, city, neighborhood, zone FROM td_zones WHERE id = $1', [zoneId]);
    if (!z.rows[0]) return res.status(404).json({ error: 'Not found' });
    const dup = await pool.query(
      `SELECT 1 FROM td_zone_log WHERE user_id=$1 AND zone_id=$2 AND looked_up_at > NOW() - INTERVAL '60 seconds' LIMIT 1`,
      [req.user.id, zoneId]
    );
    if (!dup.rows.length) {
      await pool.query(
        `INSERT INTO td_zone_log (user_id, user_name, zone_id, city, neighborhood, zone) VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.user.id, req.user.name || null, zoneId, z.rows[0].city, z.rows[0].neighborhood, z.rows[0].zone]
      );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─────────────────────────────────────────────────────────────
// My Stats + agent feedback (merged from the old tool)
// ─────────────────────────────────────────────────────────────
let fbTablesReady = null;
function ensureFeedbackTables() {
  if (!fbTablesReady) {
    fbTablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS td_feedback (
          id SERIAL PRIMARY KEY,
          user_id INTEGER,
          user_name TEXT,
          rating INTEGER,
          message TEXT,
          category_request TEXT,
          status TEXT NOT NULL DEFAULT 'new',
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_td_feedback_user ON td_feedback (user_id);
      `);
    })().catch(err => { fbTablesReady = null; throw err; });
  }
  return fbTablesReady;
}

// Personal numbers for the signed-in user. Days are counted in Erbil time (UTC+3).
app.get('/api/td/my-stats', authMiddleware(), async (req, res) => {
  try {
    await ensureTdTables();
    await ensureZoneTables();
    const OFFSET = 3 * 3600 * 1000;
    const dayKey = ms => new Date(ms + OFFSET).toISOString().slice(0, 10);
    const copies = await pool.query(
      `SELECT to_char(copied_at + INTERVAL '3 hours', 'YYYY-MM-DD') AS d, COUNT(*)::int AS n FROM td_copy_log WHERE user_id = $1 GROUP BY d`, [req.user.id]);
    const zones = await pool.query(
      `SELECT to_char(looked_up_at + INTERVAL '3 hours', 'YYYY-MM-DD') AS d, COUNT(*)::int AS n FROM td_zone_log WHERE user_id = $1 GROUP BY d`, [req.user.id]);
    const perDay = new Map();
    let copyTotal = 0, zoneTotal = 0;
    copies.rows.forEach(r => { perDay.set(r.d, (perDay.get(r.d) || 0) + r.n); copyTotal += r.n; });
    zones.rows.forEach(r => { perDay.set(r.d, (perDay.get(r.d) || 0) + r.n); zoneTotal += r.n; });

    const now = Date.now();
    const sumDays = (from, to) => { let t = 0; for (let i = from; i <= to; i++) t += perDay.get(dayKey(now - i * 86400000)) || 0; return t; };
    const thisWeek = sumDays(0, 6), lastWeek = sumDays(7, 13);
    let streak = 0, i = perDay.has(dayKey(now)) ? 0 : 1;   // today not yet active does not break the streak
    while (perDay.has(dayKey(now - i * 86400000))) { streak++; i++; }
    const last14 = [];
    for (let k = 13; k >= 0; k--) last14.push({ day: dayKey(now - k * 86400000), n: perDay.get(dayKey(now - k * 86400000)) || 0 });
    res.json({ copies: copyTotal, zones: zoneTotal, total: copyTotal + zoneTotal, thisWeek, lastWeek, streak, last14 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/td/feedback', authMiddleware(), async (req, res) => {
  let rating = parseInt(req.body.rating, 10);
  if (!(rating >= 1 && rating <= 5)) rating = null;
  const message = tdClean(req.body.message), request = tdClean(req.body.category_request);
  if (!rating && !message && !request) return res.status(400).json({ error: 'Nothing to send' });
  try {
    await ensureFeedbackTables();
    await pool.query(
      `INSERT INTO td_feedback (user_id, user_name, rating, message, category_request) VALUES ($1,$2,$3,$4,$5)`,
      [req.user.id, req.user.name || null, rating, message, request]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/td/feedback/mine', authMiddleware(), async (req, res) => {
  try {
    await ensureFeedbackTables();
    const { rows } = await pool.query(
      `SELECT id, rating, message, category_request, status, created_at FROM td_feedback WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/td/feedback', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await ensureFeedbackTables();
    const { rows } = await pool.query(`SELECT * FROM td_feedback ORDER BY created_at DESC LIMIT 1000`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/td/feedback/:id', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await ensureFeedbackTables();
    await pool.query('UPDATE td_feedback SET status = $1 WHERE id = $2', [req.body.status === 'new' ? 'new' : 'reviewed', req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─────────────────────────────────────────────────────────────
// Reports for the merged tools (team lead only). Days are Erbil time (UTC+3).
// ─────────────────────────────────────────────────────────────
const dateOrNull = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
// SQL fragment limiting column `col` to the local-date range given as $1 (from) and $2 (to), both optional
const RANGE = col => `($1::date IS NULL OR ${col} + INTERVAL '3 hours' >= $1::date) AND ($2::date IS NULL OR ${col} + INTERVAL '3 hours' < $2::date + 1)`;

app.get('/api/td/reports/dashboard', authMiddleware(['team_lead']), async (req, res) => {
  const f = dateOrNull(req.query.from), t = dateOrNull(req.query.to);
  const P = [f, t];
  const CR = RANGE('copied_at'), ZR = RANGE('looked_up_at');
  try {
    await ensureTdTables(); await ensureZoneTables();
    const q = (sql, params = P) => pool.query(sql, params).then(r => r.rows);
    const [agents, copies, zones, active, topCats, share, board, topZones, trend, heat] = await Promise.all([
      q(`SELECT COUNT(*)::int AS n FROM users WHERE LOWER(role)='agent' AND is_active = TRUE`, []),
      q(`SELECT COUNT(*)::int AS n FROM td_copy_log WHERE ${CR}`),
      q(`SELECT COUNT(*)::int AS n FROM td_zone_log WHERE ${ZR}`),
      q(`SELECT COUNT(DISTINCT uid)::int AS n FROM (
           SELECT user_id AS uid FROM td_copy_log WHERE user_id IS NOT NULL AND ${CR}
           UNION ALL SELECT user_id FROM td_zone_log WHERE user_id IS NOT NULL AND ${ZR}) x`),
      q(`SELECT COALESCE(level2, level1) AS name, COUNT(*)::int AS count FROM td_copy_log WHERE ${CR} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      q(`SELECT COALESCE(level1,'(deleted)') AS name, COUNT(*)::int AS value FROM td_copy_log WHERE ${CR} GROUP BY 1 ORDER BY 2 DESC`),
      q(`SELECT COALESCE(user_name,'(unknown)') AS name, COUNT(*)::int AS count FROM td_copy_log WHERE ${CR} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      q(`SELECT neighborhood || ' (' || city || ')' AS name, COUNT(*)::int AS count FROM td_zone_log WHERE neighborhood IS NOT NULL AND ${ZR} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      q(`SELECT d AS day, SUM(c)::int AS copies, SUM(z)::int AS zones FROM (
           SELECT to_char(copied_at + INTERVAL '3 hours','YYYY-MM-DD') AS d, 1 AS c, 0 AS z FROM td_copy_log WHERE ${CR}
           UNION ALL SELECT to_char(looked_up_at + INTERVAL '3 hours','YYYY-MM-DD'), 0, 1 FROM td_zone_log WHERE ${ZR}) x
         GROUP BY d ORDER BY d`),
      q(`SELECT EXTRACT(DOW FROM ts + INTERVAL '3 hours')::int AS dow, EXTRACT(HOUR FROM ts + INTERVAL '3 hours')::int AS hr, COUNT(*)::int AS n FROM (
           SELECT copied_at AS ts FROM td_copy_log WHERE ${CR}
           UNION ALL SELECT looked_up_at FROM td_zone_log WHERE ${ZR}) x GROUP BY 1, 2`),
    ]);
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    heat.forEach(h => { grid[h.dow][h.hr] = h.n; });
    res.json({
      agents: agents[0].n, copies: copies[0].n, zones: zones[0].n, activeAgents: active[0].n,
      topCategories: topCats, share, leaderboard: board, topZones, trend: trend.slice(-60), heatmap: grid,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/td/reports/digest', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await ensureTdTables(); await ensureZoneTables();
    const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
    const [topCats, topZones, counts, inactive, idle] = await Promise.all([
      q(`SELECT COALESCE(level2, level1) AS name, COUNT(*)::int AS count FROM td_copy_log WHERE copied_at > NOW() - INTERVAL '7 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`),
      q(`SELECT neighborhood || ' (' || city || ')' AS name, COUNT(*)::int AS count FROM td_zone_log WHERE neighborhood IS NOT NULL AND looked_up_at > NOW() - INTERVAL '7 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`),
      q(`SELECT
           (SELECT COUNT(*)::int FROM td_copy_log WHERE copied_at > NOW() - INTERVAL '7 days') AS copies,
           (SELECT COUNT(*)::int FROM td_copy_log WHERE copied_at > NOW() - INTERVAL '14 days' AND copied_at <= NOW() - INTERVAL '7 days') AS copies_prev,
           (SELECT COUNT(*)::int FROM td_zone_log WHERE looked_up_at > NOW() - INTERVAL '7 days') AS zones,
           (SELECT COUNT(*)::int FROM td_zone_log WHERE looked_up_at > NOW() - INTERVAL '14 days' AND looked_up_at <= NOW() - INTERVAL '7 days') AS zones_prev`),
      q(`SELECT id, name, last_seen FROM users WHERE LOWER(role)='agent' AND is_active = TRUE AND (last_seen IS NULL OR last_seen < NOW() - INTERVAL '7 days') ORDER BY last_seen NULLS FIRST LIMIT 200`),
      q(`SELECT u.id, u.name, u.last_seen FROM users u
         WHERE LOWER(u.role)='agent' AND u.is_active = TRUE AND u.last_seen >= NOW() - INTERVAL '7 days'
           AND NOT EXISTS (SELECT 1 FROM td_copy_log c WHERE c.user_id = u.id AND c.copied_at > NOW() - INTERVAL '7 days')
           AND NOT EXISTS (SELECT 1 FROM td_zone_log z WHERE z.user_id = u.id AND z.looked_up_at > NOW() - INTERVAL '7 days')
         ORDER BY u.name LIMIT 200`),
    ]);
    res.json({ topCategories: topCats, topZones, totals: counts[0], inactive, idle });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Combined copy + zone-lookup log, newest first
app.get('/api/td/reports/activity', authMiddleware(['team_lead']), async (req, res) => {
  const f = dateOrNull(req.query.from), t = dateOrNull(req.query.to);
  const type = ['copy', 'zone'].includes(req.query.type) ? req.query.type : 'all';
  const search = (req.query.q || '').toString().trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  try {
    await ensureTdTables(); await ensureZoneTables();
    const base = `
      SELECT 'copy' AS type, user_name, concat_ws(' → ', level1, level2, level3) AS detail, copied_at AS at FROM td_copy_log WHERE ${RANGE('copied_at')}
      UNION ALL
      SELECT 'zone', user_name, neighborhood || ' (' || city || ')' || COALESCE(' — Zone ' || zone, ''), looked_up_at FROM td_zone_log WHERE ${RANGE('looked_up_at')}`;
    const where = `WHERE ($3 = 'all' OR type = $3) AND ($4 = '' OR user_name ILIKE '%' || $4 || '%' OR detail ILIKE '%' || $4 || '%')`;
    const rows = await pool.query(`SELECT * FROM (${base}) x ${where} ORDER BY at DESC LIMIT ${limit}`, [f, t, type, search]);
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM (${base}) x ${where}`, [f, t, type, search]);
    res.json({ rows: rows.rows, total: total.rows[0].n });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Duplicate log rows = same person + same item inside the same minute. dry=true only counts.
app.post('/api/td/maintenance/duplicates', authMiddleware(['team_lead']), async (req, res) => {
  const dry = req.body.dry !== false;
  try {
    await ensureTdTables(); await ensureZoneTables();
    const copyCond = `a.id > b.id AND a.user_name IS NOT DISTINCT FROM b.user_name AND a.level1 IS NOT DISTINCT FROM b.level1
      AND a.level2 IS NOT DISTINCT FROM b.level2 AND a.level3 IS NOT DISTINCT FROM b.level3
      AND date_trunc('minute', a.copied_at) = date_trunc('minute', b.copied_at)`;
    const zoneCond = `a.id > b.id AND a.user_name IS NOT DISTINCT FROM b.user_name AND a.city IS NOT DISTINCT FROM b.city
      AND a.neighborhood IS NOT DISTINCT FROM b.neighborhood AND a.zone IS NOT DISTINCT FROM b.zone
      AND date_trunc('minute', a.looked_up_at) = date_trunc('minute', b.looked_up_at)`;
    let copies, zones;
    if (dry) {
      copies = (await pool.query(`SELECT COUNT(*)::int AS n FROM td_copy_log a WHERE EXISTS (SELECT 1 FROM td_copy_log b WHERE ${copyCond})`)).rows[0].n;
      zones = (await pool.query(`SELECT COUNT(*)::int AS n FROM td_zone_log a WHERE EXISTS (SELECT 1 FROM td_zone_log b WHERE ${zoneCond})`)).rows[0].n;
    } else {
      copies = (await pool.query(`DELETE FROM td_copy_log a USING td_copy_log b WHERE ${copyCond}`)).rowCount;
      zones = (await pool.query(`DELETE FROM td_zone_log a USING td_zone_log b WHERE ${zoneCond}`)).rowCount;
    }
    res.json({ dry, copies, zones });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Everything the merged tools store, as one JSON file (descriptions, zones, logs, flags, feedback)
app.get('/api/td/export', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await ensureTdTables(); await ensureZoneTables(); await ensureFeedbackTables();
    const all = t => pool.query(`SELECT * FROM ${t} ORDER BY id`).then(r => r.rows);
    const [categories, zones, copy_log, zone_log, flags, feedback] = await Promise.all(
      ['td_categories', 'td_zones', 'td_copy_log', 'td_zone_log', 'td_flags', 'td_feedback'].map(all));
    res.json({ exported_at: new Date().toISOString(), categories, zones, copy_log, zone_lookup_log: zone_log, flags, feedback });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────
// Contact Reasons tree (category → reason → sub-reason)
// ─────────────────────────────────────────────────────────────
let crReady = null;
function ensureCrTables() {
  if (!crReady) {
    crReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cr_nodes (
          id SERIAL PRIMARY KEY,
          parent_id INTEGER REFERENCES cr_nodes(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          note TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_cr_nodes_parent ON cr_nodes (parent_id);
      `);
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM cr_nodes');
      if (rows[0].n === 0) {
        const seed = require('../lib/contactReasonsSeed');
        for (let i = 0; i < seed.length; i++) {
          const a = await pool.query('INSERT INTO cr_nodes (parent_id, name, sort_order) VALUES (NULL,$1,$2) RETURNING id', [seed[i][0], i]);
          for (let j = 0; j < seed[i][1].length; j++) {
            const [reason, subs] = seed[i][1][j];
            const b = await pool.query('INSERT INTO cr_nodes (parent_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id', [a.rows[0].id, reason, j]);
            for (let k = 0; k < subs.length; k++) {
              await pool.query('INSERT INTO cr_nodes (parent_id, name, sort_order) VALUES ($1,$2,$3)', [b.rows[0].id, subs[k], k]);
            }
          }
        }
      }
    })().catch(err => { crReady = null; throw err; });
  }
  return crReady;
}

app.get('/api/contact-reasons', authMiddleware(), async (req, res) => {
  try {
    await ensureCrTables();
    const all = isLeadReq(req) && req.query.all === '1';
    const { rows } = await pool.query(
      `SELECT id, parent_id, name, note, sort_order, is_active FROM cr_nodes ${all ? '' : 'WHERE is_active = TRUE'} ORDER BY sort_order, id`
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contact-reasons', authMiddleware(['team_lead']), async (req, res) => {
  const name = tdClean(req.body.name);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    await ensureCrTables();
    const parent = req.body.parent_id ? Number(req.body.parent_id) : null;
    if (parent) {
      const p = await pool.query(
        `WITH RECURSIVE up AS (SELECT id, parent_id, 1 AS depth FROM cr_nodes WHERE id=$1
           UNION ALL SELECT n.id, n.parent_id, up.depth+1 FROM cr_nodes n JOIN up ON n.id = up.parent_id)
         SELECT MAX(depth)::int AS depth FROM up`, [parent]);
      if (!p.rows[0].depth) return res.status(404).json({ error: 'Parent not found' });
      if (p.rows[0].depth >= 3) return res.status(400).json({ error: 'The tree has 3 levels only' });
    }
    const m = await pool.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM cr_nodes WHERE parent_id IS NOT DISTINCT FROM $1', [parent]);
    const { rows } = await pool.query(
      'INSERT INTO cr_nodes (parent_id, name, note, sort_order) VALUES ($1,$2,$3,$4) RETURNING id, parent_id, name, note, sort_order, is_active',
      [parent, name, tdClean(req.body.note) || null, m.rows[0].next]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/contact-reasons/:id', authMiddleware(['team_lead']), async (req, res) => {
  const name = tdClean(req.body.name);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    await ensureCrTables();
    const { rows } = await pool.query(
      `UPDATE cr_nodes SET name=$1, note=$2, is_active=COALESCE($3, is_active), updated_at=NOW() WHERE id=$4
       RETURNING id, parent_id, name, note, sort_order, is_active`,
      [name, tdClean(req.body.note) || null, typeof req.body.is_active === 'boolean' ? req.body.is_active : null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contact-reasons/:id/move', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await ensureCrTables();
    const cur = await pool.query('SELECT id, parent_id FROM cr_nodes WHERE id=$1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const sibs = (await pool.query('SELECT id FROM cr_nodes WHERE parent_id IS NOT DISTINCT FROM $1 ORDER BY sort_order, id', [cur.rows[0].parent_id])).rows.map(r => r.id);
    const i = sibs.indexOf(cur.rows[0].id);
    const j = req.body.direction === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < sibs.length) {
      [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
      await pool.query('UPDATE cr_nodes SET sort_order = x.pos FROM (SELECT id, ord-1 AS pos FROM unnest($1::int[]) WITH ORDINALITY AS t(id, ord)) x WHERE cr_nodes.id = x.id', [sibs]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/contact-reasons/:id', authMiddleware(['team_lead']), async (req, res) => {
  try {
    await ensureCrTables();
    await pool.query('DELETE FROM cr_nodes WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─────────────────────────────────────────────────────────────
// Admin dashboard (team lead): everything agents do, in one call
// ─────────────────────────────────────────────────────────────
let searchLogReady = null;
function ensureSearchLog() {
  if (!searchLogReady) {
    searchLogReady = pool.query(`
      CREATE TABLE IF NOT EXISTS search_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        query TEXT NOT NULL,
        results INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_search_log_time ON search_log (created_at DESC);
    `).catch(err => { searchLogReady = null; throw err; });
  }
  return searchLogReady;
}

app.post('/api/search-log', authMiddleware(), async (req, res) => {
  const query = tdClean(req.body.query);
  if (!query || query.length < 2) return res.json({ ok: true });
  try {
    await ensureSearchLog();
    await pool.query('INSERT INTO search_log (user_id, query, results, source) VALUES ($1,$2,$3,$4)',
      [req.user.id, query.slice(0, 200), Math.max(0, parseInt(req.body.results, 10) || 0), tdClean(req.body.source) || null]);
  } catch { /* logging must never break search */ }
  res.json({ ok: true });
});

// one failing query must not take the whole dashboard down
const safeQ = async (sql, params, fallback = []) => {
  try { return (await pool.query(sql, params)).rows; } catch (e) { console.error('dashboard query failed:', e.message); return fallback; }
};
const rangeDays = req => (req.query.days === 'all' ? 36500 : Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 7)));

app.get('/api/admin/dashboard', authMiddleware(['team_lead']), async (req, res) => {
  const d = rangeDays(req);
  try {
    await Promise.all([ensureTdTables(), ensureZoneTables(), ensureFeedbackTables(), ensureSearchLog()]).catch(() => {});
    const I = `make_interval(days => $1::int)`;
    const [
      agentsTotal, online, loginsRange, activeUsersRange, inactive, copies, zones, searches, noResult, feedbackNew, flagsOpen, coachingPending,
      dailyLogins, dailyTools, peak, agents, topFaqs, neverViewed, unhelpful, noResultTop, evalDaily, evalLow, inactiveList, recentFeedback,
    ] = await Promise.all([
      safeQ(`SELECT COUNT(*)::int AS n FROM users WHERE role='agent' AND is_active=true`, []),
      safeQ(`SELECT COUNT(*)::int AS n FROM active_sessions s JOIN users u ON u.id=s.user_id WHERE u.role='agent' AND s.last_ping > NOW()-INTERVAL '5 minutes'`, []),
      safeQ(`SELECT COUNT(*)::int AS n FROM login_events le JOIN users u ON u.id=le.user_id WHERE u.role='agent' AND le.logged_in_at > NOW()-${I}`, [d]),
      safeQ(`SELECT COUNT(DISTINCT le.user_id)::int AS n FROM login_events le JOIN users u ON u.id=le.user_id WHERE u.role='agent' AND le.logged_in_at > NOW()-${I}`, [d]),
      safeQ(`SELECT COUNT(*)::int AS n FROM users u WHERE u.role='agent' AND u.is_active=true AND NOT EXISTS (SELECT 1 FROM login_events le WHERE le.user_id=u.id AND le.logged_in_at > NOW()-INTERVAL '7 days')`, []),
      safeQ(`SELECT COUNT(*)::int AS n FROM td_copy_log WHERE copied_at > NOW()-${I}`, [d]),
      safeQ(`SELECT COUNT(*)::int AS n FROM td_zone_log WHERE looked_up_at > NOW()-${I}`, [d]),
      safeQ(`SELECT COUNT(*)::int AS n FROM search_log WHERE created_at > NOW()-${I}`, [d]),
      safeQ(`SELECT COUNT(*)::int AS n FROM search_log WHERE results=0 AND created_at > NOW()-${I}`, [d]),
      safeQ(`SELECT COUNT(*)::int AS n FROM td_feedback WHERE status='new'`, []),
      safeQ(`SELECT COUNT(*)::int AS n FROM td_flags WHERE status='open'`, []),
      safeQ(`SELECT COUNT(*)::int AS n FROM qa_evals WHERE feedback_needed = true AND LOWER(COALESCE(coaching_status,'')) NOT LIKE '%deliver%' AND eval_date > NOW()-INTERVAL '60 days'`, []),
      safeQ(`SELECT to_char((le.logged_in_at + INTERVAL '3 hours')::date,'YYYY-MM-DD') AS day, COUNT(*)::int AS logins, COUNT(DISTINCT le.user_id)::int AS people
             FROM login_events le JOIN users u ON u.id=le.user_id WHERE u.role='agent' AND le.logged_in_at > NOW()-${I} GROUP BY 1 ORDER BY 1`, [d]),
      safeQ(`SELECT day, SUM(copies)::int AS copies, SUM(zones)::int AS zones FROM (
               SELECT to_char((copied_at + INTERVAL '3 hours')::date,'YYYY-MM-DD') AS day, COUNT(*) AS copies, 0 AS zones FROM td_copy_log WHERE copied_at > NOW()-${I} GROUP BY 1
               UNION ALL
               SELECT to_char((looked_up_at + INTERVAL '3 hours')::date,'YYYY-MM-DD'), 0, COUNT(*) FROM td_zone_log WHERE looked_up_at > NOW()-${I} GROUP BY 1
             ) t GROUP BY day ORDER BY day`, [d]),
      safeQ(`SELECT EXTRACT(HOUR FROM (logged_in_at + INTERVAL '3 hours'))::int AS hour, COUNT(*)::int AS logins FROM login_events WHERE logged_in_at > NOW()-${I} GROUP BY 1 ORDER BY 1`, [d]),
      safeQ(`SELECT u.id, u.name, u.wave_id, u.title, u.last_seen,
               (SELECT COUNT(*)::int FROM login_events le WHERE le.user_id=u.id AND le.logged_in_at > NOW()-${I}) AS logins,
               (SELECT COUNT(DISTINCT faq_id)::int FROM faq_views fv WHERE fv.user_id=u.id) AS faqs_viewed,
               (SELECT COUNT(*)::int FROM bookmarks b WHERE b.user_id=u.id) AS bookmarks,
               (SELECT COUNT(*)::int FROM td_copy_log c WHERE c.user_id=u.id AND c.copied_at > NOW()-${I}) AS copies,
               (SELECT COUNT(*)::int FROM td_zone_log z WHERE z.user_id=u.id AND z.looked_up_at > NOW()-${I}) AS zones,
               (SELECT COUNT(*)::int FROM search_log sl WHERE sl.user_id=u.id AND sl.created_at > NOW()-${I}) AS searches,
               (SELECT COUNT(*)::int FROM td_feedback f WHERE f.user_id=u.id AND f.created_at > NOW()-${I}) AS feedback,
               (SELECT ROUND(AVG(e.final_score)*100.0/33,1) FROM qa_evals e WHERE e.wave_id=u.wave_id AND e.eval_date > NOW()-${I}) AS avg_score,
               (SELECT COUNT(*)::int FROM qa_evals e WHERE e.wave_id=u.wave_id AND e.eval_date > NOW()-${I}) AS evals,
               EXISTS (SELECT 1 FROM active_sessions s WHERE s.user_id=u.id AND s.last_ping > NOW()-INTERVAL '5 minutes') AS online
             FROM users u WHERE u.role='agent' AND u.is_active=true ORDER BY u.name`, [d]),
      safeQ(`SELECT id, question_en, category, views FROM faqs WHERE is_published=true ORDER BY views DESC NULLS LAST LIMIT 8`, []),
      safeQ(`SELECT id, question_en, category FROM faqs WHERE is_published=true AND COALESCE(views,0)=0 ORDER BY id DESC LIMIT 10`, []),
      safeQ(`SELECT f.id, f.question_en, f.category, COUNT(*) FILTER (WHERE fr.helpful=false)::int AS down, COUNT(*) FILTER (WHERE fr.helpful=true)::int AS up
             FROM faq_ratings fr JOIN faqs f ON f.id=fr.faq_id GROUP BY f.id, f.question_en, f.category
             HAVING COUNT(*) FILTER (WHERE fr.helpful=false) > 0 ORDER BY down DESC, up ASC LIMIT 8`, []),
      safeQ(`SELECT LOWER(query) AS query, COUNT(*)::int AS times, COUNT(DISTINCT user_id)::int AS people FROM search_log WHERE results=0 AND created_at > NOW()-${I} GROUP BY 1 ORDER BY times DESC, query LIMIT 15`, [d]),
      safeQ(`SELECT to_char(eval_date,'YYYY-MM-DD') AS day, ROUND(AVG(final_score)*100.0/33,1) AS avg, COUNT(*)::int AS n FROM qa_evals WHERE eval_date > NOW()-${I} GROUP BY 1 ORDER BY 1`, [d]),
      safeQ(`SELECT agent_name, ROUND(AVG(final_score)*100.0/33,1) AS avg, COUNT(*)::int AS n FROM qa_evals WHERE eval_date > NOW()-${I} GROUP BY agent_name HAVING COUNT(*) >= 2 ORDER BY avg ASC NULLS LAST LIMIT 8`, [d]),
      safeQ(`SELECT u.id, u.name, u.wave_id, u.last_seen FROM users u WHERE u.role='agent' AND u.is_active=true
             AND NOT EXISTS (SELECT 1 FROM login_events le WHERE le.user_id=u.id AND le.logged_in_at > NOW()-INTERVAL '7 days') ORDER BY u.last_seen ASC NULLS FIRST LIMIT 15`, []),
      safeQ(`SELECT id, user_name, rating, message, created_at FROM td_feedback WHERE status='new' ORDER BY created_at DESC LIMIT 5`, []),
    ]);
    const n = r => (r[0] ? r[0].n : 0);
    res.json({
      days: d,
      kpis: {
        agents: n(agentsTotal), online: n(online), logins: n(loginsRange), activeAgents: n(activeUsersRange), inactive7: n(inactive),
        copies: n(copies), zones: n(zones), searches: n(searches), noResult: n(noResult),
        feedbackNew: n(feedbackNew), flagsOpen: n(flagsOpen), coachingPending: n(coachingPending),
      },
      series: { logins: dailyLogins, tools: dailyTools, peak },
      agents,
      content: { topFaqs, neverViewed, unhelpful, noResult: noResultTop },
      quality: { daily: evalDaily, lowest: evalLow },
      attention: { inactive: inactiveList, feedback: recentFeedback },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/agents/:id', authMiddleware(['team_lead']), async (req, res) => {
  const d = req.query.days === 'all' ? 36500 : Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Bad id' });
  try {
    await Promise.all([ensureTdTables(), ensureZoneTables(), ensureFeedbackTables(), ensureSearchLog()]).catch(() => {});
    const I = `make_interval(days => $2::int)`;
    const [user, logins, activity, copies, zones, searches, evals, feedback, faqs] = await Promise.all([
      safeQ(`SELECT id, name, email, wave_id, title, role, last_seen, is_active FROM users WHERE id=$1`, [id]),
      safeQ(`SELECT to_char((logged_in_at + INTERVAL '3 hours')::date,'YYYY-MM-DD') AS day, COUNT(*)::int AS logins FROM login_events WHERE user_id=$1 AND logged_in_at > NOW()-${I} GROUP BY 1 ORDER BY 1`, [id, d]),
      safeQ(`SELECT action, details, created_at FROM activity_log WHERE user_id=$1 ORDER BY created_at DESC LIMIT 15`, [id]),
      safeQ(`SELECT level1, level2, level3, copied_at FROM td_copy_log WHERE user_id=$1 AND copied_at > NOW()-${I} ORDER BY copied_at DESC LIMIT 15`, [id, d]),
      safeQ(`SELECT city, neighborhood, zone, looked_up_at FROM td_zone_log WHERE user_id=$1 AND looked_up_at > NOW()-${I} ORDER BY looked_up_at DESC LIMIT 15`, [id, d]),
      safeQ(`SELECT query, results, created_at FROM search_log WHERE user_id=$1 AND created_at > NOW()-${I} ORDER BY created_at DESC LIMIT 15`, [id, d]),
      safeQ(`SELECT to_char(eval_date,'YYYY-MM-DD') AS day, ROUND(final_score*100.0/33,0) AS score, qa_officer, coaching_status, subject AS improvement_areas
             FROM qa_evals WHERE wave_id = (SELECT wave_id FROM users WHERE id=$1) ORDER BY eval_date DESC, id DESC LIMIT 10`, [id]),
      safeQ(`SELECT rating, message, status, created_at FROM td_feedback WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`, [id]),
      safeQ(`SELECT f.question_en, f.category FROM faq_views fv JOIN faqs f ON f.id=fv.faq_id WHERE fv.user_id=$1 ORDER BY fv.faq_id DESC LIMIT 8`, [id]),
    ]);
    if (!user.length) return res.status(404).json({ error: 'Not found' });
    res.json({ days: d, user: user[0], logins, activity, copies, zones, searches, evaluations: evals, feedback, faqs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


require('../lib/qaEvals')(app, pool, authMiddleware);
require('../lib/searchTools')(app, pool, authMiddleware);
require('../lib/translationReview')(app, pool, authMiddleware);
require('../lib/teamTools')(app, pool, authMiddleware);

module.exports = app;
// Bulk export of agent and staff accounts to Excel — team leads only.
//   GET /api/users/export
// Passwords are stored as one-way hashes, so they cannot be exported. For agents the
// sign-in rule is known (Wave ID + the password Wave@<Wave ID> set at creation), so the
// sheet shows that initial password; it stops working if the agent changed it. Staff
// passwords are random and shown only once at creation, so they are not in the file.
const ExcelJS = require('exceljs');

module.exports = function mountAccountsExport(app, pool, authMiddleware) {
  app.get('/api/users/export', authMiddleware(['team_lead']), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, email, role, title, wave_id, is_active, mfa_enabled, created_at, last_seen FROM users ORDER BY LOWER(name)`);
      const fmt = d => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'Never');
      const agents = rows.filter(u => String(u.role).trim().toLowerCase() === 'agent');
      const staff = rows.filter(u => String(u.role).trim().toLowerCase() !== 'agent');
      const ROLE = { team_lead: 'Team Lead', qa_officer: 'QA Officer', editor: 'Editor', admin: 'Admin' };

      const wb = new ExcelJS.Workbook(); wb.creator = 'Runaki Knowledge Base';
      const HEAD = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 11 };
      const sheet = (name, cols, data) => {
        const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
        ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
        ws.getRow(1).eachCell(c => { c.font = HEAD; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14213D' } }; c.alignment = { vertical: 'middle' }; });
        ws.getRow(1).height = 24;
        data.forEach(d => ws.addRow(d).eachCell(c => { c.font = { name: 'Arial', size: 10 }; }));
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
        return ws;
      };
      sheet('Agents', [['Name', 'name', 30], ['Wave ID (username)', 'wave', 20], ['Initial password', 'pw', 22], ['Email', 'email', 36], ['Title', 'title', 22],
        ['Status', 'status', 12], ['2-step sign-in', 'mfa', 14], ['Last seen', 'seen', 22], ['Created', 'created', 22]],
        agents.map(u => ({ name: u.name, wave: u.wave_id || '', pw: u.wave_id ? `Wave@${u.wave_id}` : '', email: u.email, title: u.title || '',
          status: u.is_active ? 'Active' : 'Inactive', mfa: u.mfa_enabled ? 'On' : 'Off', seen: fmt(u.last_seen), created: fmt(u.created_at) })));
      sheet('Staff', [['Name', 'name', 30], ['Email (username)', 'email', 38], ['Role', 'role', 16], ['Title', 'title', 24], ['Status', 'status', 12],
        ['2-step sign-in', 'mfa', 14], ['Last seen', 'seen', 22], ['Password', 'pw', 44]],
        staff.map(u => ({ name: u.name, email: u.email, role: ROLE[u.role] || u.role, title: u.title || '', status: u.is_active ? 'Active' : 'Inactive',
          mfa: u.mfa_enabled ? 'On' : 'Off', seen: fmt(u.last_seen), pw: 'Not stored. Use Reset password if needed' })));
      const rd = wb.addWorksheet('Read me');
      rd.columns = [{ width: 110 }];
      ['Runaki accounts export', `Exported ${fmt(new Date())} by ${req.user.name || 'a team lead'}. ${agents.length} agents, ${staff.length} staff.`, '',
        'Agents sign in with their Wave ID and the initial password shown (Wave@ followed by the Wave ID).',
        'The initial password stops working if the agent changed it. Passwords are stored as one-way hashes, so current passwords cannot be read.',
        'Staff passwords were generated once at creation and are not stored. Use Reset password in the Admin Panel to give someone a new one.',
        'This file contains sign-in details. Share it only with people who need it and delete your copy afterwards.'].forEach((t, i) => { const c = rd.addRow([t]).getCell(1); c.font = { name: 'Arial', size: i === 0 ? 14 : 11, bold: i === 0 }; c.alignment = { wrapText: true }; });
      wb.views = [{ activeTab: 0 }];

      await pool.query(`INSERT INTO activity_log(user_id,action,details) VALUES($1,'EXPORT_ACCOUNTS',$2)`, [req.user.id, `Exported ${agents.length} agents and ${staff.length} staff`]).catch(() => {});
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Runaki_Accounts_${new Date().toISOString().slice(0, 10)}.xlsx"`);
      await wb.xlsx.write(res); res.end();
    } catch (err) { console.error('accounts export:', err.message); if (!res.headersSent) res.status(500).json({ error: 'Could not build the export.' }); }
  });
};

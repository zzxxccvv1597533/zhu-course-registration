const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'zhuwax001';
const ADMIN_PASS = process.env.ADMIN_PASS || 'a123456789';
const DEADLINE = new Date('2026-04-06T23:59:59+08:00').getTime();
const CAPACITY = 20;
const PRICE = 16800;

// ── Database ──
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    line_id TEXT DEFAULT '',
    track TEXT NOT NULL,
    goal TEXT DEFAULT '',
    transfer_last5 TEXT NOT NULL,
    transfer_date TEXT NOT NULL,
    status TEXT DEFAULT '待確認',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', '+8 hours')),
    updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
  )
`);

// ── Middleware ──
app.use(express.json());

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Admin auth middleware
function adminAuth(req, res, next) {
  const user = req.headers['x-admin-user'] || req.query.user;
  const pass = req.headers['x-admin-pass'] || req.query.pass;
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  next();
}

// ── API: Submit registration (public) ──
app.post('/api/register', (req, res) => {
  try {
    const { name, phone, email, line_id, track, goal, transfer_last5, transfer_date } = req.body;

    // Required fields
    if (!name || !phone || !email || !track || !transfer_last5 || !transfer_date) {
      return res.status(400).json({ error: '請填寫所有必填欄位' });
    }

    // Deadline check
    if (Date.now() > DEADLINE) {
      return res.status(400).json({ error: '報名已截止' });
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email 格式不正確' });
    }

    // Validate phone (Taiwan format: 09xx-xxx-xxx or 09xxxxxxxx)
    if (!/^09\d{2}-?\d{3}-?\d{3}$/.test(phone)) {
      return res.status(400).json({ error: '手機號碼格式不正確' });
    }

    // Validate transfer_last5
    if (!/^\d{5}$/.test(transfer_last5)) {
      return res.status(400).json({ error: '匯款末五碼格式不正確' });
    }

    // Validate track
    const validTracks = ['A — 有產品', 'B — 有店面', 'C — 想創業'];
    if (!validTracks.includes(track)) {
      return res.status(400).json({ error: '請選擇有效的路線' });
    }

    // Sanitize text inputs (trim + limit length)
    const clean = {
      name: String(name).trim().slice(0, 50),
      phone: String(phone).trim().slice(0, 15),
      email: String(email).trim().slice(0, 100),
      line_id: String(line_id || '').trim().slice(0, 50),
      track: String(track).trim(),
      goal: String(goal || '').trim().slice(0, 500),
      transfer_last5: String(transfer_last5).trim(),
      transfer_date: String(transfer_date).trim().slice(0, 10),
    };

    const stmt = db.prepare(`
      INSERT INTO registrations (name, phone, email, line_id, track, goal, transfer_last5, transfer_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(clean.name, clean.phone, clean.email, clean.line_id, clean.track, clean.goal, clean.transfer_last5, clean.transfer_date);

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: '系統錯誤，請稍後再試' });
  }
});

// ── API: Get all registrations (admin only) ──
app.get('/api/registrations', adminAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM registrations ORDER BY created_at DESC').all();
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = '已確認' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN status = '待確認' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = '取消' THEN 1 ELSE 0 END) as cancelled
      FROM registrations
    `).get();

    res.json({ data: rows, stats });
  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ error: '系統錯誤' });
  }
});

// ── API: Update registration status (admin only) ──
app.patch('/api/registrations/:id', adminAuth, (req, res) => {
  try {
    const { status, note } = req.body;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });

    // Whitelist allowed statuses
    const allowedStatuses = ['待確認', '已確認', '取消'];

    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: '無效狀態' });
    }

    // Build safe update
    if (status && note !== undefined) {
      db.prepare("UPDATE registrations SET status = ?, note = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?")
        .run(status, String(note).slice(0, 200), id);
    } else if (status) {
      db.prepare("UPDATE registrations SET status = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?")
        .run(status, id);
    } else if (note !== undefined) {
      db.prepare("UPDATE registrations SET note = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?")
        .run(String(note).slice(0, 200), id);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ error: '更新失敗' });
  }
});

// ── API: Delete registration (admin only) ──
app.delete('/api/registrations/:id', adminAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: '無效 ID' });
    db.prepare('DELETE FROM registrations WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '刪除失敗' });
  }
});

// ── API: Export CSV (admin only) ──
app.get('/api/export', adminAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM registrations ORDER BY created_at DESC').all();
  const headers = ['ID', '姓名', '手機', 'Email', 'LINE_ID', '路線', '想解決的問題', '匯款末五碼', '匯款日期', '狀態', '備註', '報名時間'];

  const csv = '\uFEFF' + headers.join(',') + '\n' +
    rows.map(r =>
      [r.id, r.name, r.phone, r.email, r.line_id, r.track, r.goal, r.transfer_last5, r.transfer_date, r.status, r.note, r.created_at]
        .map(v => '"' + String(v || '').replace(/"/g, '""') + '"')
        .join(',')
    ).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=registrations_${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(csv);
});

// ── Routes ──
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
  console.log(`Admin login: ${ADMIN_USER} / ${'*'.repeat(ADMIN_PASS.length)}`);
});

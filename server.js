const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── قاعدة البيانات ──────────────────────────────────────────────────────────
const db = new Database('./sahm.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// إنشاء الجداول
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    bio TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    reputation INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    posts_count INTEGER DEFAULT 0,
    followers_count INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    image TEXT DEFAULT '',
    stock_symbols TEXT DEFAULT '',
    post_type TEXT DEFAULT 'opinion',
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0,
    comments_count INTEGER DEFAULT 0,
    target_price REAL DEFAULT 0,
    stop_loss REAL DEFAULT 0,
    direction TEXT DEFAULT '',
    timeframe TEXT DEFAULT '',
    is_verified_result INTEGER DEFAULT 0,
    result TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    upvotes INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    vote_type TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, target_id, target_type)
  );

  CREATE TABLE IF NOT EXISTS follows (
    follower_id TEXT NOT NULL,
    following_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follower_id, following_id)
  );

  CREATE TABLE IF NOT EXISTS stock_watchlist (
    user_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, symbol)
  );

  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    question TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS poll_votes (
    user_id TEXT NOT NULL,
    poll_id TEXT NOT NULL,
    choice TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, poll_id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    from_user_id TEXT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    link TEXT DEFAULT '',
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── إعداد multer للصور ───────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './public/uploads/'),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'sahm-secret-2026-very-long-key-do-not-change',
  resave: true,
  saveUninitialized: false,
  rolling: true,
  cookie: { maxAge: 90 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

// ── Helper Functions ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
  next();
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function extractSymbols(text) {
  const matches = text.match(/\$[A-Za-z0-9\u0600-\u06FF]{1,10}/g);
  return matches ? [...new Set(matches)].join(',') : '';
}

function getLevelName(level) {
  const levels = { 1: 'مبتدئ 🌱', 2: 'متداول 📊', 3: 'محلل 🔍', 4: 'محلل متميز ⭐', 5: 'خبير معتمد 👑' };
  return levels[level] || 'مبتدئ 🌱';
}

function calcLevel(reputation) {
  if (reputation >= 1000) return 4;
  if (reputation >= 200) return 3;
  if (reputation >= 50) return 2;
  return 1;
}

function formatTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return 'الآن';
  if (diff < 3600) return `منذ ${Math.floor(diff/60)} دقيقة`;
  if (diff < 86400) return `منذ ${Math.floor(diff/3600)} ساعة`;
  if (diff < 604800) return `منذ ${Math.floor(diff/86400)} يوم`;
  return date.toLocaleDateString('ar-SA');
}

// الأسهم السعودية الشائعة
const POPULAR_STOCKS = [
  { symbol: '$2222', name: 'أرامكو', sector: 'طاقة' },
  { symbol: '$1010', name: 'الرياض', sector: 'بنوك' },
  { symbol: '$1120', name: 'الراجحي', sector: 'بنوك' },
  { symbol: '$2010', name: 'سابك', sector: 'بتروكيماويات' },
  { symbol: '$7010', name: 'STC', sector: 'اتصالات' },
  { symbol: '$2380', name: 'پيتكيم', sector: 'بتروكيماويات' },
  { symbol: '$4200', name: 'أكوا باور', sector: 'طاقة' },
  { symbol: '$4280', name: 'أبشر', sector: 'تقنية' },
  { symbol: '$8010', name: 'الوطنية للتأمين', sector: 'تأمين' },
  { symbol: '$6010', name: 'سدافكو', sector: 'غذاء' },
];

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, display_name, email, password } = req.body;
  if (!username || !display_name || !email || !password)
    return res.json({ error: 'جميع الحقول مطلوبة' });
  if (password.length < 8)
    return res.json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return res.json({ error: 'اسم المستخدم أو البريد مستخدم مسبقاً' });

  const hash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  db.prepare('INSERT INTO users (id,username,display_name,email,password_hash) VALUES (?,?,?,?,?)').run(id, username, display_name, email, hash);
  req.session.userId = id;
  res.json({ success: true, redirect: '/' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
  req.session.userId = user.id;
  res.json({ success: true, redirect: '/' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = getUser(req.session.userId);
  if (!user) return res.json({ user: null });
  const { password_hash, ...safe } = user;
  res.json({ user: safe });
});

// ── Posts ────────────────────────────────────────────────────────────────────
app.post('/api/posts', requireAuth, upload.single('image'), (req, res) => {
  const { content, post_type, target_price, stop_loss, direction, timeframe } = req.body;
  if (!content || content.trim().length < 3) return res.json({ error: 'المحتوى قصير جداً' });
  if (content.length > 2000) return res.json({ error: 'المحتوى طويل جداً (الحد 2000 حرف)' });

  const id = uuidv4();
  const image = req.file ? '/uploads/' + req.file.filename : '';
  const symbols = extractSymbols(content);

  db.prepare(`INSERT INTO posts (id,user_id,content,image,stock_symbols,post_type,target_price,stop_loss,direction,timeframe)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, req.session.userId, content.trim(), image, symbols,
    post_type || 'opinion', parseFloat(target_price)||0, parseFloat(stop_loss)||0,
    direction||'', timeframe||'');

  db.prepare('UPDATE users SET posts_count = posts_count + 1 WHERE id = ?').run(req.session.userId);

  const post = db.prepare('SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?').get(id);
  res.json({ success: true, post: { ...post, time_ago: 'الآن', level_name: getLevelName(post.level) } });
});

app.get('/api/posts', (req, res) => {
  const { feed, symbol, user_id, page } = req.query;
  const limit = 20;
  const offset = (parseInt(page) || 0) * limit;
  const userId = req.session.userId;
  let posts;

  if (symbol) {
    posts = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
      FROM posts p JOIN users u ON p.user_id = u.id
      WHERE p.stock_symbols LIKE ? ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
    ).all(`%${symbol}%`, limit, offset);
  } else if (user_id) {
    posts = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
      FROM posts p JOIN users u ON p.user_id = u.id
      WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
    ).all(user_id, limit, offset);
  } else if (feed === 'following' && userId) {
    posts = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
      FROM posts p JOIN users u ON p.user_id = u.id
      WHERE p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
      ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
    ).all(userId, limit, offset);
  } else {
    posts = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
      FROM posts p JOIN users u ON p.user_id = u.id
      ORDER BY (p.upvotes * 2 - p.downvotes + p.comments_count) DESC, p.created_at DESC
      LIMIT ? OFFSET ?`
    ).all(limit, offset);
  }

  // إضافة معلومات التصويت للمستخدم الحالي
  const enriched = posts.map(p => {
    let myVote = null;
    if (userId) {
      const v = db.prepare('SELECT vote_type FROM votes WHERE user_id=? AND target_id=? AND target_type="post"').get(userId, p.id);
      myVote = v ? v.vote_type : null;
    }
    return { ...p, time_ago: formatTime(p.created_at), level_name: getLevelName(p.level), my_vote: myVote };
  });

  res.json({ posts: enriched });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.json({ error: 'المنشور غير موجود' });
  if (post.user_id !== req.session.userId) return res.json({ error: 'غير مصرح' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  db.prepare('UPDATE users SET posts_count = posts_count - 1 WHERE id = ?').run(req.session.userId);
  res.json({ success: true });
});

// ── Votes ────────────────────────────────────────────────────────────────────
app.post('/api/vote', requireAuth, (req, res) => {
  const { target_id, target_type, vote_type } = req.body;
  const userId = req.session.userId;
  const existing = db.prepare('SELECT * FROM votes WHERE user_id=? AND target_id=? AND target_type=?').get(userId, target_id, target_type);

  if (existing) {
    if (existing.vote_type === vote_type) {
      // إلغاء التصويت
      db.prepare('DELETE FROM votes WHERE user_id=? AND target_id=? AND target_type=?').run(userId, target_id, target_type);
      if (target_type === 'post') {
        const col = vote_type === 'up' ? 'upvotes' : 'downvotes';
        db.prepare(`UPDATE posts SET ${col} = ${col} - 1 WHERE id = ?`).run(target_id);
      }
      return res.json({ success: true, action: 'removed' });
    } else {
      // تغيير التصويت
      db.prepare('UPDATE votes SET vote_type=? WHERE user_id=? AND target_id=? AND target_type=?').run(vote_type, userId, target_id, target_type);
      if (target_type === 'post') {
        const add = vote_type === 'up' ? 'upvotes' : 'downvotes';
        const sub = vote_type === 'up' ? 'downvotes' : 'upvotes';
        db.prepare(`UPDATE posts SET ${add} = ${add} + 1, ${sub} = ${sub} - 1 WHERE id = ?`).run(target_id);
      }
      return res.json({ success: true, action: 'changed' });
    }
  }

  db.prepare('INSERT INTO votes (id,user_id,target_id,target_type,vote_type) VALUES (?,?,?,?,?)').run(uuidv4(), userId, target_id, target_type, vote_type);
  if (target_type === 'post') {
    const col = vote_type === 'up' ? 'upvotes' : 'downvotes';
    db.prepare(`UPDATE posts SET ${col} = ${col} + 1 WHERE id = ?`).run(target_id);
    // مكافأة السمعة للناشر
    if (vote_type === 'up') {
      const post = db.prepare('SELECT user_id FROM posts WHERE id=?').get(target_id);
      if (post && post.user_id !== userId) {
        db.prepare('UPDATE users SET reputation = reputation + 1 WHERE id = ?').run(post.user_id);
        const u = getUser(post.user_id);
        if (u) db.prepare('UPDATE users SET level = ? WHERE id = ?').run(calcLevel(u.reputation + 1), u.id);
      }
    }
  }
  const updatedPost = target_type === 'post' ? db.prepare('SELECT upvotes, downvotes FROM posts WHERE id=?').get(target_id) : null;
  res.json({ success: true, action: 'added', ...updatedPost });
});

// ── Comments ─────────────────────────────────────────────────────────────────
app.get('/api/posts/:id/comments', (req, res) => {
  const comments = db.prepare(`SELECT c.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ? ORDER BY c.upvotes DESC, c.created_at ASC`
  ).all(req.params.id);
  res.json({ comments: comments.map(c => ({ ...c, time_ago: formatTime(c.created_at), level_name: getLevelName(c.level) })) });
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length < 2) return res.json({ error: 'التعليق قصير جداً' });
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.json({ error: 'المنشور غير موجود' });

  const id = uuidv4();
  db.prepare('INSERT INTO comments (id,post_id,user_id,content) VALUES (?,?,?,?)').run(id, req.params.id, req.session.userId, content.trim());
  db.prepare('UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?').run(req.params.id);

  // إشعار صاحب المنشور
  if (post.user_id !== req.session.userId) {
    const commenter = getUser(req.session.userId);
    db.prepare('INSERT INTO notifications (id,user_id,from_user_id,type,message,link) VALUES (?,?,?,?,?,?)').run(
      uuidv4(), post.user_id, req.session.userId, 'comment',
      `${commenter.display_name} علّق على منشورك`, `/post/${req.params.id}`
    );
  }

  const comment = db.prepare(`SELECT c.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
    FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?`).get(id);
  res.json({ success: true, comment: { ...comment, time_ago: 'الآن', level_name: getLevelName(comment.level) } });
});

// ── Follow ───────────────────────────────────────────────────────────────────
app.post('/api/follow/:id', requireAuth, (req, res) => {
  const targetId = req.params.id;
  const userId = req.session.userId;
  if (targetId === userId) return res.json({ error: 'لا يمكنك متابعة نفسك' });

  const existing = db.prepare('SELECT * FROM follows WHERE follower_id=? AND following_id=?').get(userId, targetId);
  if (existing) {
    db.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').run(userId, targetId);
    db.prepare('UPDATE users SET followers_count = followers_count - 1 WHERE id = ?').run(targetId);
    db.prepare('UPDATE users SET following_count = following_count - 1 WHERE id = ?').run(userId);
    return res.json({ success: true, following: false });
  }

  db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?,?)').run(userId, targetId);
  db.prepare('UPDATE users SET followers_count = followers_count + 1 WHERE id = ?').run(targetId);
  db.prepare('UPDATE users SET following_count = following_count + 1 WHERE id = ?').run(userId);

  const follower = getUser(userId);
  db.prepare('INSERT INTO notifications (id,user_id,from_user_id,type,message,link) VALUES (?,?,?,?,?,?)').run(
    uuidv4(), targetId, userId, 'follow', `${follower.display_name} بدأ بمتابعتك`, `/profile/${follower.username}`
  );
  res.json({ success: true, following: true });
});

// ── Users ────────────────────────────────────────────────────────────────────
app.get('/api/users/:username', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const { password_hash, ...safe } = user;
  const isFollowing = req.session.userId
    ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id=? AND following_id=?').get(req.session.userId, user.id)
    : false;
  res.json({ user: { ...safe, level_name: getLevelName(safe.level) }, is_following: isFollowing });
});

app.post('/api/profile', requireAuth, upload.single('avatar'), (req, res) => {
  const { display_name, bio } = req.body;
  const updates = {};
  if (display_name) updates.display_name = display_name;
  if (bio !== undefined) updates.bio = bio;
  if (req.file) updates.avatar = '/uploads/' + req.file.filename;

  if (Object.keys(updates).length === 0) return res.json({ success: true });
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(updates), req.session.userId);
  res.json({ success: true });
});

// ── Notifications ─────────────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, (req, res) => {
  const notifs = db.prepare(`SELECT n.*, u.display_name as from_name, u.avatar as from_avatar
    FROM notifications n LEFT JOIN users u ON n.from_user_id = u.id
    WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 30`
  ).all(req.session.userId);
  res.json({ notifications: notifs.map(n => ({ ...n, time_ago: formatTime(n.created_at) })) });
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.session.userId);
  res.json({ success: true });
});

app.get('/api/notifications/count', requireAuth, (req, res) => {
  const row = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id=? AND is_read=0').get(req.session.userId);
  res.json({ count: row.count });
});

// ── Stocks ───────────────────────────────────────────────────────────────────
app.get('/api/stocks/popular', (req, res) => res.json({ stocks: POPULAR_STOCKS }));

app.get('/api/stocks/:symbol/stats', (req, res) => {
  const symbol = req.params.symbol;
  const posts = db.prepare('SELECT COUNT(*) as count FROM posts WHERE stock_symbols LIKE ?').get(`%${symbol}%`);
  const bullish = db.prepare(`SELECT COUNT(*) as count FROM posts WHERE stock_symbols LIKE ? AND direction = 'bullish'`).get(`%${symbol}%`);
  const bearish = db.prepare(`SELECT COUNT(*) as count FROM posts WHERE stock_symbols LIKE ? AND direction = 'bearish'`).get(`%${symbol}%`);
  res.json({ total_posts: posts.count, bullish: bullish.count, bearish: bearish.count });
});

// ── Search ───────────────────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ users: [], posts: [] });
  const users = db.prepare(`SELECT id, username, display_name, avatar, level, reputation, is_verified
    FROM users WHERE username LIKE ? OR display_name LIKE ? LIMIT 5`
  ).all(`%${q}%`, `%${q}%`).map(u => ({ ...u, level_name: getLevelName(u.level) }));
  const posts = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.level
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.content LIKE ? OR p.stock_symbols LIKE ? ORDER BY p.upvotes DESC LIMIT 10`
  ).all(`%${q}%`, `%${q}%`).map(p => ({ ...p, time_ago: formatTime(p.created_at), level_name: getLevelName(p.level) }));
  res.json({ users, posts });
});

// ── Leaderboard ───────────────────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const users = db.prepare(`SELECT id, username, display_name, avatar, reputation, level, posts_count, followers_count, is_verified
    FROM users ORDER BY reputation DESC LIMIT 20`
  ).all().map(u => ({ ...u, level_name: getLevelName(u.level) }));
  res.json({ users });
});


// ══════════════════════════════════════════════════════════════════════════════
// DAILY POLL — استطلاع تاسي اليومي
// ══════════════════════════════════════════════════════════════════════════════

// جدول الاستطلاعات اليومية
const db2 = db; // نفس قاعدة البيانات
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_polls (
    id TEXT PRIMARY KEY,
    date TEXT UNIQUE NOT NULL,
    question TEXT NOT NULL,
    bullish_count INTEGER DEFAULT 0,
    bearish_count INTEGER DEFAULT 0,
    neutral_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS daily_poll_votes (
    user_id TEXT NOT NULL,
    poll_id TEXT NOT NULL,
    choice TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, poll_id)
  );
`);

// الحصول على أو إنشاء استطلاع اليوم
function getTodayPoll() {
  const today = new Date().toISOString().split('T')[0];
  let poll = db.prepare('SELECT * FROM daily_polls WHERE date = ?').get(today);
  if (!poll) {
    const id = uuidv4();
    const question = 'ما توقعك لمؤشر تاسي اليوم؟';
    db.prepare('INSERT INTO daily_polls (id, date, question) VALUES (?,?,?)').run(id, today, question);
    poll = db.prepare('SELECT * FROM daily_polls WHERE id = ?').get(id);
  }
  return poll;
}

// الحصول على استطلاع اليوم
app.get('/api/poll/today', (req, res) => {
  const poll = getTodayPoll();
  const total = poll.bullish_count + poll.bearish_count + poll.neutral_count;
  let myVote = null;
  if (req.session.userId) {
    const v = db.prepare('SELECT choice FROM daily_poll_votes WHERE user_id=? AND poll_id=?').get(req.session.userId, poll.id);
    myVote = v ? v.choice : null;
  }
  const bullPct = total ? Math.round(poll.bullish_count/total*100) : 0;
  const bearPct = total ? Math.round(poll.bearish_count/total*100) : 0;
  const neutPct = total ? 100-bullPct-bearPct : 0;
  res.json({ poll: { ...poll, total, bullPct, bearPct, neutPct, myVote } });
});

// التصويت في استطلاع اليوم
app.post('/api/poll/vote', requireAuth, (req, res) => {
  const { choice } = req.body;
  if (!['bullish','bearish','neutral'].includes(choice))
    return res.json({ error: 'خيار غير صحيح' });

  const poll = getTodayPoll();
  const existing = db.prepare('SELECT * FROM daily_poll_votes WHERE user_id=? AND poll_id=?').get(req.session.userId, poll.id);

  if (existing) {
    // تغيير التصويت
    const oldCol = existing.choice + '_count';
    const newCol = choice + '_count';
    db.prepare(`UPDATE daily_polls SET ${oldCol}=${oldCol}-1, ${newCol}=${newCol}+1 WHERE id=?`).run(poll.id);
    db.prepare('UPDATE daily_poll_votes SET choice=? WHERE user_id=? AND poll_id=?').run(choice, req.session.userId, poll.id);
  } else {
    // تصويت جديد
    const col = choice + '_count';
    db.prepare(`UPDATE daily_polls SET ${col}=${col}+1 WHERE id=?`).run(poll.id);
    db.prepare('INSERT INTO daily_poll_votes (user_id,poll_id,choice) VALUES (?,?,?)').run(req.session.userId, poll.id, choice);
    // مكافأة السمعة للتصويت اليومي
    db.prepare('UPDATE users SET reputation = reputation + 1 WHERE id=?').run(req.session.userId);
  }

  const updated = db.prepare('SELECT * FROM daily_polls WHERE id=?').get(poll.id);
  const total = updated.bullish_count + updated.bearish_count + updated.neutral_count;
  const bullPct = total ? Math.round(updated.bullish_count/total*100) : 0;
  const bearPct = total ? Math.round(updated.bearish_count/total*100) : 0;
  const neutPct = total ? 100-bullPct-bearPct : 0;
  res.json({ success: true, poll: { ...updated, total, bullPct, bearPct, neutPct, myVote: choice } });
});

// تاريخ الاستطلاعات السابقة
app.get('/api/poll/history', (req, res) => {
  const polls = db.prepare('SELECT * FROM daily_polls ORDER BY date DESC LIMIT 7').all();
  res.json({ polls: polls.map(p => {
    const total = p.bullish_count + p.bearish_count + p.neutral_count;
    return { ...p, total,
      bullPct: total ? Math.round(p.bullish_count/total*100) : 0,
      bearPct: total ? Math.round(p.bearish_count/total*100) : 0,
      neutPct: total ? 100-Math.round(p.bullish_count/total*100)-Math.round(p.bearish_count/total*100) : 0
    };
  })});
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════════════════════════════════════
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sahm-admin-2026';

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'غير مصرح' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) { req.session.isAdmin = true; res.json({ success: true }); }
  else res.json({ error: 'كلمة المرور غير صحيحة' });
});
app.post('/api/admin/logout', (req, res) => { req.session.isAdmin = false; res.json({ success: true }); });
app.get('/api/admin/check', (req, res) => res.json({ isAdmin: !!req.session.isAdmin }));

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({
    totalUsers:    db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    totalPosts:    db.prepare('SELECT COUNT(*) as c FROM posts').get().c,
    totalComments: db.prepare('SELECT COUNT(*) as c FROM comments').get().c,
    totalVotes:    db.prepare('SELECT COUNT(*) as c FROM votes').get().c,
    newUsersToday: db.prepare("SELECT COUNT(*) as c FROM users WHERE DATE(created_at)=DATE('now')").get().c,
    newPostsToday: db.prepare("SELECT COUNT(*) as c FROM posts WHERE DATE(created_at)=DATE('now')").get().c,
    topStocks:     db.prepare("SELECT stock_symbols, COUNT(*) as c FROM posts WHERE stock_symbols!='' GROUP BY stock_symbols ORDER BY c DESC LIMIT 5").all(),
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const { search, page } = req.query;
  const limit = 20, offset = (parseInt(page)||0)*limit;
  const like = `%${search||''}%`;
  const users = search
    ? db.prepare('SELECT id,username,display_name,email,reputation,level,posts_count,followers_count,is_verified,created_at FROM users WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(like,like,like,limit,offset)
    : db.prepare('SELECT id,username,display_name,email,reputation,level,posts_count,followers_count,is_verified,created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit,offset);
  res.json({ users: users.map(u => ({ ...u, level_name: getLevelName(u.level), joined: formatTime(u.created_at) })) });
});

app.post('/api/admin/users/:id/verify', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT is_verified FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ error: 'غير موجود' });
  const v = user.is_verified ? 0 : 1;
  db.prepare('UPDATE users SET is_verified=? WHERE id=?').run(v, req.params.id);
  res.json({ success: true, is_verified: v });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  ['DELETE FROM comments WHERE user_id=?','DELETE FROM votes WHERE user_id=?',
   'DELETE FROM follows WHERE follower_id=? OR following_id=?','DELETE FROM posts WHERE user_id=?',
   'DELETE FROM notifications WHERE user_id=? OR from_user_id=?','DELETE FROM users WHERE id=?'
  ].forEach((q,i) => i===2||i===4 ? db.prepare(q).run(req.params.id,req.params.id) : db.prepare(q).run(req.params.id));
  res.json({ success: true });
});

app.get('/api/admin/posts', requireAdmin, (req, res) => {
  const { search, page } = req.query;
  const limit = 20, offset = (parseInt(page)||0)*limit;
  const like = `%${search||''}%`;
  const posts = search
    ? db.prepare('SELECT p.*,u.username,u.display_name FROM posts p JOIN users u ON p.user_id=u.id WHERE p.content LIKE ? OR u.username LIKE ? ORDER BY p.created_at DESC LIMIT ? OFFSET ?').all(like,like,limit,offset)
    : db.prepare('SELECT p.*,u.username,u.display_name FROM posts p JOIN users u ON p.user_id=u.id ORDER BY p.created_at DESC LIMIT ? OFFSET ?').all(limit,offset);
  res.json({ posts: posts.map(p => ({ ...p, time_ago: formatTime(p.created_at) })) });
});

app.delete('/api/admin/posts/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM comments WHERE post_id=?').run(req.params.id);
  db.prepare('DELETE FROM votes WHERE target_id=? AND target_type="post"').run(req.params.id);
  db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ── SPA Routing ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`✅ منصة سهم تعمل على المنفذ ${PORT}`));

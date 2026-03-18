const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── قاعدة البيانات ──────────────────────────────────────────────────────────
const db = new Database('./sahm.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── تثبيت صلاحيات السوبر أدمن ───────────────────────────────────────────────
const SUPER_ADMIN_USERNAME = 'Hamed';
setTimeout(() => {
  try {
    const u = db.prepare('SELECT id FROM users WHERE username=?').get(SUPER_ADMIN_USERNAME);
    if (u) db.prepare('UPDATE users SET is_admin=1,is_super_admin=1 WHERE username=?').run(SUPER_ADMIN_USERNAME);
  } catch(e) {}
}, 2000);

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
    parent_id TEXT DEFAULT NULL,
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
// إنشاء مجلد uploads إذا ما موجود
const uploadsDir = './public/uploads';
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB قبل الضغط
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|heic|heif/;
    const mimeAllowed = /image\/(jpeg|jpg|png|gif|webp|heic|heif)/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()) || mimeAllowed.test(file.mimetype));
  }
});

// ── ضغط الصور تلقائياً ───────────────────────────────────────────────────────
async function compressImage(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const tempPath = filePath + '.tmp.jpg';

    let pipeline = sharp(filePath, { failOnError: false });

    // GIF — خذ أول frame فقط
    if (ext === '.gif') pipeline = pipeline.gif({ pages: 1 });

    await pipeline
      .rotate() // تصحيح EXIF rotation تلقائياً
      .resize(1400, 1400, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } }) // PNG شفاف → أبيض
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(tempPath);

    fs.unlinkSync(filePath);
    const newPath = filePath.replace(/\.[^.]+$/, '.jpg');
    fs.renameSync(tempPath, newPath);
    return newPath;
  } catch(e) {
    console.error('compress error:', e.message);
    // لو فشل الضغط أرجع الملف الأصلي بدون ضغط
    return filePath;
  }
}

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
  if (user.is_suspended) return res.json({ error: 'تم إيقاف حسابك. تواصل مع الإدارة.' });
  req.session.userId = user.id;
  if (user.is_admin) req.session.isAdmin = true;
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

// ── بيانات الأسهم من Yahoo Finance ───────────────────────────────────────────
const https = require('https');

function fetchYahooData(symbol) {
  return new Promise((resolve, reject) => {
    // تداول السعودي يحتاج .SR في النهاية
    const yahooSymbol = symbol.match(/^\d+$/) ? `${symbol}.SR` : symbol;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=3mo`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

app.get('/api/stock-chart/:symbol', async (req, res) => {
  try {
    const data = await fetchYahooData(req.params.symbol);
    const chart = data?.chart?.result?.[0];
    if (!chart) return res.json({ error: 'السهم غير موجود' });

    const timestamps = chart.timestamp;
    const quote = chart.indicators.quote[0];
    const candles = timestamps.map((t, i) => ({
      time: t * 1000,
      open:  quote.open[i],
      high:  quote.high[i],
      low:   quote.low[i],
      close: quote.close[i],
      volume: quote.volume[i]
    })).filter(c => c.open && c.high && c.low && c.close);

    const meta = chart.meta;
    res.json({
      symbol: meta.symbol,
      currency: meta.currency,
      name: meta.longName || meta.symbol,
      candles
    });
  } catch(e) {
    res.json({ error: 'خطأ في جلب البيانات: ' + e.message });
  }
});


db.exec(`CREATE TABLE IF NOT EXISTS market_events (
  id TEXT PRIMARY KEY,
  event_date TEXT NOT NULL,
  symbol TEXT DEFAULT '',
  company_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// جلب أحداث المفكرة
app.get('/api/market-events', (req, res) => {
  const { from, to } = req.query;
  const today = new Date().toISOString().split('T')[0];
  const start = from || today;
  const end = to || new Date(Date.now() + 7*24*60*60*1000).toISOString().split('T')[0];
  const events = db.prepare('SELECT * FROM market_events WHERE event_date BETWEEN ? AND ? ORDER BY event_date ASC, company_name ASC').all(start, end);
  res.json({ events });
});

// إضافة حدث (أدمن فقط)
app.post('/api/admin/market-events', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const { event_date, symbol, company_name, event_type, details } = req.body;
  if (!event_date || !company_name || !event_type) return res.json({ error: 'التاريخ والشركة والنوع مطلوبة' });
  const id = uuidv4();
  db.prepare('INSERT INTO market_events (id,event_date,symbol,company_name,event_type,details,created_by) VALUES (?,?,?,?,?,?,?)').run(
    id, event_date, symbol||'', company_name.trim(), event_type.trim(), details||'', admin.id
  );
  logAdminAction(admin.id, admin.display_name, 'إضافة حدث مفكرة', 'event', id, company_name);
  res.json({ success: true });
});

// تعديل حدث
app.put('/api/admin/market-events/:id', requireAdmin, (req, res) => {
  const { event_date, symbol, company_name, event_type, details } = req.body;
  db.prepare('UPDATE market_events SET event_date=?,symbol=?,company_name=?,event_type=?,details=? WHERE id=?').run(
    event_date, symbol||'', company_name, event_type, details||'', req.params.id
  );
  res.json({ success: true });
});

// حذف حدث
app.delete('/api/admin/market-events/:id', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  db.prepare('DELETE FROM market_events WHERE id=?').run(req.params.id);
  logAdminAction(admin.id, admin.display_name, 'حذف حدث مفكرة', 'event', req.params.id, '');
  res.json({ success: true });
});

// ── Posts ────────────────────────────────────────────────────────────────────
app.post('/api/posts', requireAuth, upload.single('image'), async (req, res) => {
  const { content, post_type, target_price, stop_loss, direction, timeframe, chart_symbol, chart_exchange } = req.body;
  if (!content || content.trim().length < 3) return res.json({ error: 'المحتوى قصير جداً' });
  if (content.length > 2000) return res.json({ error: 'المحتوى طويل جداً (الحد 2000 حرف)' });

  // تحقق إضافي من المستخدم
  const userId = req.session.userId;
  if (!userId) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(e) {}
    return res.status(401).json({ error: 'انتهت جلستك، سجّل دخولك مجدداً' });
  }
  const userExists = db.prepare('SELECT id FROM users WHERE id=?').get(userId);
  if (!userExists) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(e) {}
    return res.status(401).json({ error: 'المستخدم غير موجود' });
  }

  const id = uuidv4();
  let image = req.file ? '/uploads/' + req.file.filename : '';

  // ضغط الصورة إذا موجودة
  if (req.file) {
    const compressed = await compressImage(req.file.path);
    image = '/uploads/' + path.basename(compressed);
  }

  const symbols = extractSymbols(content);

  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare(`INSERT INTO posts (id,user_id,content,image,stock_symbols,post_type,target_price,stop_loss,direction,timeframe,chart_symbol,chart_exchange)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, content.trim(), image, symbols,
    post_type || 'opinion', parseFloat(target_price)||0, parseFloat(stop_loss)||0,
    direction||'', timeframe||'', chart_symbol||'', chart_exchange||'TADAWUL');
  db.exec('PRAGMA foreign_keys = ON');

  db.prepare('UPDATE users SET posts_count = posts_count + 1 WHERE id = ?').run(userId);

  const post = db.prepare('SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified, u.is_analyst FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?').get(id);
  res.json({ success: true, post: { ...post, time_ago: 'الآن', level_name: getLevelName(post.level) } });
});

// الأكثر نقاشاً
app.get('/api/posts/hot', (req, res) => {
  const posts = db.prepare(`
    SELECT p.id, p.content, p.comments_count, p.upvotes, u.display_name, u.username
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.is_soft_deleted=0 OR p.is_soft_deleted IS NULL
    ORDER BY p.comments_count DESC, p.upvotes DESC
    LIMIT 5
  `).all();
  res.json({ posts });
});

app.get('/api/posts', (req, res) => {
  const { feed, symbol, user_id, page } = req.query;
  const limit = 20;
  const offset = (parseInt(page) || 0) * limit;
  const userId = req.session.userId;
  let posts;
  let pinnedPosts = [];

  // جلب المنشورات المثبتة فقط في الصفحة الأولى والفيد العام
  if (!symbol && !user_id && (!page || page === '0')) {
    pinnedPosts = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
      FROM posts p JOIN users u ON p.user_id = u.id
      WHERE p.is_pinned = 1 ORDER BY p.pinned_at DESC`).all();
  }

  if (symbol) {
    posts = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
      FROM posts p JOIN users u ON p.user_id = u.id
      WHERE (p.stock_symbols LIKE ?) AND (p.is_soft_deleted=0 OR p.is_soft_deleted IS NULL)
      ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
    ).all(`%${symbol}%`, limit, offset);
  } else if (user_id) {
    posts = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
      FROM posts p JOIN users u ON p.user_id = u.id
      WHERE p.user_id = ? AND (p.is_soft_deleted=0 OR p.is_soft_deleted IS NULL)
      ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
    ).all(user_id, limit, offset);
  } else if (feed === 'following' && userId) {
    posts = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
      FROM posts p JOIN users u ON p.user_id = u.id
      WHERE p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
      AND (p.is_soft_deleted=0 OR p.is_soft_deleted IS NULL)
      ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
    ).all(userId, limit, offset);
  } else {
    posts = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
      FROM posts p JOIN users u ON p.user_id = u.id
      WHERE (p.is_pinned = 0 OR p.is_pinned IS NULL)
      AND (p.is_soft_deleted=0 OR p.is_soft_deleted IS NULL)
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?`
    ).all(limit, offset);
  }

  const enrich = (p, pinned = false) => {
    let myVote = null;
    if (userId) {
      const v = db.prepare("SELECT vote_type FROM votes WHERE user_id=? AND target_id=? AND target_type='post'").get(userId, p.id);
      myVote = v ? v.vote_type : null;
    }
    return { ...p, time_ago: formatTime(p.created_at), level_name: getLevelName(p.level), my_vote: myVote, is_pinned: pinned || p.is_pinned };
  };

  const enrichedPinned = pinnedPosts.map(p => enrich(p, true));
  const enrichedPosts = posts.map(p => enrich(p));

  // دمج المثبتة أولاً ثم الباقي مع إزالة التكرار
  const pinnedIds = new Set(enrichedPinned.map(p => p.id));
  const filtered = enrichedPosts.filter(p => !pinnedIds.has(p.id));

  res.json({ posts: [...enrichedPinned, ...filtered] });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.json({ error: 'المنشور غير موجود' });
  const user = db.prepare('SELECT is_admin,is_super_admin FROM users WHERE id=?').get(req.session.userId);
  const isAdmin = user && (user.is_admin || user.is_super_admin);
  if (post.user_id !== req.session.userId && !isAdmin) return res.json({ error: 'غير مصرح' });
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare("DELETE FROM votes WHERE target_id IN (SELECT id FROM comments WHERE post_id=?) AND target_type='comment'").run(req.params.id);
    db.prepare('DELETE FROM comments WHERE post_id=?').run(req.params.id);
    db.prepare("DELETE FROM votes WHERE target_id=? AND target_type='post'").run(req.params.id);
    db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
    db.prepare('UPDATE users SET posts_count = MAX(0, posts_count - 1) WHERE id=?').run(post.user_id);
  } finally {
    db.pragma('foreign_keys = ON');
  }
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
        db.prepare(`UPDATE posts SET ${col} = MAX(0, ${col} - 1) WHERE id = ?`).run(target_id);
      }
      const updatedPost = target_type === 'post' ? db.prepare('SELECT upvotes, downvotes FROM posts WHERE id=?').get(target_id) : null;
      return res.json({ success: true, action: 'removed', ...updatedPost });
    } else {
      // تغيير التصويت
      db.prepare('UPDATE votes SET vote_type=? WHERE user_id=? AND target_id=? AND target_type=?').run(vote_type, userId, target_id, target_type);
      if (target_type === 'post') {
        const add = vote_type === 'up' ? 'upvotes' : 'downvotes';
        const sub = vote_type === 'up' ? 'downvotes' : 'upvotes';
        db.prepare(`UPDATE posts SET ${add} = ${add} + 1, ${sub} = MAX(0, ${sub} - 1) WHERE id = ?`).run(target_id);
      }
      const updatedPost = target_type === 'post' ? db.prepare('SELECT upvotes, downvotes FROM posts WHERE id=?').get(target_id) : null;
      return res.json({ success: true, action: 'changed', ...updatedPost });
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
// إضافة حقل is_pinned للتعليقات
try { db.exec(`ALTER TABLE comments ADD COLUMN is_pinned INTEGER DEFAULT 0`); } catch(e) {}

app.get('/api/posts/:id/comments', (req, res) => {
  // جلب التعليقات — المثبت أولاً ثم الباقي
  const comments = db.prepare(`SELECT c.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ? AND (c.parent_id IS NULL OR c.parent_id = '')
    ORDER BY c.is_pinned DESC, c.upvotes DESC, c.created_at ASC`
  ).all(req.params.id);

  const result = comments.map(c => {
    const replies = db.prepare(`SELECT c.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
      FROM comments c JOIN users u ON c.user_id = u.id
      WHERE c.parent_id = ? ORDER BY c.created_at ASC`
    ).all(c.id);
    return {
      ...c,
      time_ago: formatTime(c.created_at),
      level_name: getLevelName(c.level),
      replies: replies.map(r => ({ ...r, time_ago: formatTime(r.created_at), level_name: getLevelName(r.level) }))
    };
  });

  res.json({ comments: result });
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const { content, parent_id } = req.body;
  if (!content || content.trim().length < 2) return res.json({ error: 'التعليق قصير جداً' });
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.json({ error: 'المنشور غير موجود' });

  const id = uuidv4();
  db.prepare('INSERT INTO comments (id,post_id,user_id,parent_id,content) VALUES (?,?,?,?,?)').run(
    id, req.params.id, req.session.userId, parent_id || null, content.trim()
  );
  db.prepare('UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?').run(req.params.id);

  // إشعار صاحب المنشور أو صاحب التعليق الأصلي
  const notifyId = parent_id
    ? db.prepare('SELECT user_id FROM comments WHERE id=?').get(parent_id)?.user_id
    : post.user_id;

  if (notifyId && notifyId !== req.session.userId) {
    const commenter = getUser(req.session.userId);
    const msg = parent_id ? `${commenter.display_name} ردّ على تعليقك` : `${commenter.display_name} علّق على منشورك`;
    db.prepare('INSERT INTO notifications (id,user_id,from_user_id,type,message,link) VALUES (?,?,?,?,?,?)').run(
      uuidv4(), notifyId, req.session.userId, 'comment', msg, `/post/${req.params.id}`
    );
  }

  const comment = db.prepare(`SELECT c.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
    FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?`).get(id);
  res.json({ success: true, comment: { ...comment, time_ago: 'الآن', level_name: getLevelName(comment.level), replies: [] } });
});

// تثبيت تعليق — لصاحب المنشور فقط
app.post('/api/comments/:id/pin', requireAuth, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id=?').get(req.params.id);
  if (!comment) return res.json({ error: 'التعليق غير موجود' });
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(comment.post_id);
  if (!post) return res.json({ error: 'المنشور غير موجود' });
  if (post.user_id !== req.session.userId) return res.json({ error: 'فقط صاحب المنشور يستطيع تثبيت التعليقات' });
  // إلغاء تثبيت أي تعليق سابق في نفس المنشور
  db.prepare('UPDATE comments SET is_pinned=0 WHERE post_id=?').run(comment.post_id);
  const newVal = comment.is_pinned ? 0 : 1;
  db.prepare('UPDATE comments SET is_pinned=? WHERE id=?').run(newVal, req.params.id);
  res.json({ success: true, is_pinned: newVal });
});

// حذف تعليق — للأدمن أو صاحب التعليق
app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id=?').get(req.params.id);
  if (!comment) return res.json({ error: 'غير موجود' });
  const user = db.prepare('SELECT is_admin,is_super_admin FROM users WHERE id=?').get(req.session.userId);
  const isAdmin = user && (user.is_admin || user.is_super_admin);
  if (comment.user_id !== req.session.userId && !isAdmin) return res.json({ error: 'غير مصرح' });
  db.prepare('DELETE FROM comments WHERE id=?').run(req.params.id);
  db.prepare('UPDATE posts SET comments_count=MAX(0,comments_count-1) WHERE id=?').run(comment.post_id);
  res.json({ success: true });
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

app.post('/api/profile', requireAuth, upload.single('avatar'), async (req, res) => {
  const { display_name, bio } = req.body;
  const updates = {};
  if (display_name) updates.display_name = display_name;
  if (bio !== undefined) updates.bio = bio;
  if (req.file) {
    const compressed = await compressImage(req.file.path);
    updates.avatar = '/uploads/' + path.basename(compressed);
  }

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
// NEWS SYSTEM — نظام الأخبار المجتمعية
// ══════════════════════════════════════════════════════════════════════════════

// جدول الأخبار
db.exec(`
  CREATE TABLE IF NOT EXISTS news_posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    source TEXT NOT NULL,
    source_url TEXT DEFAULT '',
    stock_symbols TEXT DEFAULT '',
    post_id TEXT DEFAULT '',
    published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_published INTEGER DEFAULT 0
  );
`);

// إنشاء حساب الأخبار الرسمي إذا ما موجود
function ensureNewsAccount() {
  const existing = db.prepare("SELECT id FROM users WHERE username = 'jalsat_news'").get();
  if (existing) return existing.id;
  const id = uuidv4();
  const hash = '$2a$12$newsaccounthashplaceholder123456'; // placeholder
  db.prepare(`INSERT INTO users (id,username,display_name,email,password_hash,bio,is_verified,level,reputation)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, 'jalsat_news', '📰 أخبار السوق', 'news@jalsat.com',
    hash, 'الحساب الرسمي لأخبار السوق المالي السعودي — يتم النشر تلقائياً',
    1, 5, 9999
  );
  return id;
}

// أخبار تجريبية للبداية
const SAMPLE_NEWS = [
  { title: 'أرامكو تعلن نتائج الربع الأول بأرباح تفوق التوقعات', summary: 'أعلنت أرامكو السعودية عن نتائج الربع الأول من العام الحالي، وجاءت الأرباح فوق توقعات المحللين بنسبة 6%، مدفوعةً بارتفاع أسعار النفط وزيادة الطاقة الإنتاجية.', source: 'أرقام', stock_symbols: '$2222' },
  { title: 'مؤشر تاسي يرتفع 1.2% في جلسة اليوم بدعم من القطاع المالي', summary: 'أغلق مؤشر السوق المالي السعودي تاسي مرتفعاً بنسبة 1.2% عند مستوى 12,450 نقطة، مدعوماً بمكاسب قوية في أسهم القطاع المالي والبنوك.', source: 'مباشر', stock_symbols: '$1120 $1010' },
  { title: 'الراجحي المالية ترفع توصيتها على سهم STC إلى "تجميع"', summary: 'رفعت شركة الراجحي المالية توصيتها على سهم شركة الاتصالات السعودية STC من "محايد" إلى "تجميع"، مع تعديل السعر المستهدف إلى 54 ريالاً.', source: 'أرقام', stock_symbols: '$7010' },
  { title: 'هيئة السوق المالية تعتمد اكتتاباً جديداً في القطاع الصحي', summary: 'أعلنت هيئة السوق المالية عن اعتماد طرح عام أولي لشركة رائدة في القطاع الصحي، بسعر اكتتاب 28 ريالاً للسهم. تفتح نافذة الاشتراك الأسبوع القادم.', source: 'تداول', stock_symbols: '$اكتتاب' },
  { title: 'سابك تتفاوض على عقود بتروكيماويات بقيمة 3 مليار ريال', summary: 'كشفت مصادر مطلعة أن شركة سابك تجري مفاوضات متقدمة لإبرام عقود توريد بتروكيماويات مع عدة شركاء آسيويين بقيمة إجمالية تتجاوز 3 مليار ريال.', source: 'الاقتصادية', stock_symbols: '$2010' },
  { title: 'أكوا باور تفوز بعقد محطة طاقة شمسية بالمملكة بـ 1.8 مليار', summary: 'فازت شركة أكوا باور بعقد إنشاء وتشغيل محطة طاقة شمسية جديدة في المنطقة الشرقية بقيمة 1.8 مليار ريال، ضمن مستهدفات رؤية 2030 للطاقة المتجددة.', source: 'مباشر', stock_symbols: '$4200' },
];

// نشر الأخبار التجريبية عند التشغيل الأول
function publishSampleNews() {
  const count = db.prepare('SELECT COUNT(*) as c FROM news_posts').get().c;
  if (count > 0) return; // موجودة مسبقاً

  const newsUserId = ensureNewsAccount();

  SAMPLE_NEWS.forEach((news, i) => {
    const newsId = uuidv4();
    const postId = uuidv4();
    const hoursAgo = (i + 1) * 2;
    const createdAt = new Date(Date.now() - hoursAgo * 3600000).toISOString();

    // نشر كمنشور عادي
    db.prepare(`INSERT INTO posts (id,user_id,content,stock_symbols,post_type,created_at)
      VALUES (?,?,?,?,?,?)`).run(
      postId, newsUserId,
      `📰 ${news.title}

${news.summary}

📌 المصدر: ${news.source}`,
      news.stock_symbols, 'news', createdAt
    );

    // حفظ في جدول الأخبار
    db.prepare(`INSERT INTO news_posts (id,title,summary,source,stock_symbols,post_id,published_at,is_published)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      newsId, news.title, news.summary, news.source,
      news.stock_symbols, postId, createdAt, 1
    );
  });

  // تحديث عداد المنشورات
  db.prepare("UPDATE users SET posts_count = (SELECT COUNT(*) FROM posts WHERE user_id = users.id) WHERE username = 'jalsat_news'").run();
}

// تشغيل النشر عند البدء
try { publishSampleNews(); } catch(e) { console.log('News init:', e.message); }

// API: جلب آخر الأخبار للشريط الجانبي
app.get('/api/news/latest', (req, res) => {
  const limit = parseInt(req.query.limit) || 6;
  const news = db.prepare(`
    SELECT n.id, n.title, n.summary, n.source, n.source_url,
           n.stock_symbols, n.post_id, n.published_at, n.is_published,
           COALESCE(p.upvotes,0) as upvotes, COALESCE(p.comments_count,0) as comments_count
    FROM news_posts n
    LEFT JOIN posts p ON n.post_id = p.id
    WHERE n.is_published = 1
    ORDER BY n.published_at DESC
    LIMIT ?
  `).all(limit);
  res.json({ news });
});

// API: إضافة خبر يدوياً من الأدمن
app.post('/api/admin/news', requireAdmin, (req, res) => {
  const { title, summary, source, stock_symbols } = req.body;
  if (!title || !summary) return res.json({ error: 'العنوان والملخص مطلوبان' });

  const newsUserId = ensureNewsAccount();
  const newsId = uuidv4();
  const postId = uuidv4();

  db.prepare(`INSERT INTO posts (id,user_id,content,stock_symbols,post_type)
    VALUES (?,?,?,?,?)`).run(
    postId, newsUserId,
    `📰 ${title}

${summary}

📌 المصدر: ${source||'جلسة السوق'}`,
    stock_symbols||'', 'news'
  );

  db.prepare(`INSERT INTO news_posts (id,title,summary,source,stock_symbols,post_id,is_published)
    VALUES (?,?,?,?,?,?,?)`).run(newsId, title, summary, source||'جلسة السوق', stock_symbols||'', postId, 1);

  db.prepare("UPDATE users SET posts_count = posts_count + 1 WHERE username = 'jalsat_news'").run();

  res.json({ success: true, postId });
});

// ══════════════════════════════════════════════════════════════════════════════
// DAILY POLL — استطلاع تاسي اليومي
// ══════════════════════════════════════════════════════════════════════════════

// جداول الاستطلاعات
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

// جداول الاستطلاعات المخصصة
try { db.exec(`
  CREATE TABLE IF NOT EXISTS custom_polls (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ends_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS custom_poll_options (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL,
    label TEXT NOT NULL,
    emoji TEXT DEFAULT '',
    votes_count INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (poll_id) REFERENCES custom_polls(id)
  );
  CREATE TABLE IF NOT EXISTS custom_poll_votes (
    user_id TEXT NOT NULL,
    poll_id TEXT NOT NULL,
    option_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, poll_id)
  );
`); } catch(e) {}

// ── الاستطلاع اليومي ─────────────────────────────────────────────
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

app.post('/api/poll/vote', requireAuth, (req, res) => {
  const { choice } = req.body;
  if (!['bullish','bearish','neutral'].includes(choice))
    return res.json({ error: 'خيار غير صحيح' });
  const poll = getTodayPoll();
  const existing = db.prepare('SELECT * FROM daily_poll_votes WHERE user_id=? AND poll_id=?').get(req.session.userId, poll.id);
  if (existing) {
    const oldCol = existing.choice + '_count';
    const newCol = choice + '_count';
    db.prepare(`UPDATE daily_polls SET ${oldCol}=${oldCol}-1, ${newCol}=${newCol}+1 WHERE id=?`).run(poll.id);
    db.prepare('UPDATE daily_poll_votes SET choice=? WHERE user_id=? AND poll_id=?').run(choice, req.session.userId, poll.id);
  } else {
    const col = choice + '_count';
    db.prepare(`UPDATE daily_polls SET ${col}=${col}+1 WHERE id=?`).run(poll.id);
    db.prepare('INSERT INTO daily_poll_votes (user_id,poll_id,choice) VALUES (?,?,?)').run(req.session.userId, poll.id, choice);
    db.prepare('UPDATE users SET reputation = reputation + 1 WHERE id=?').run(req.session.userId);
  }
  const updated = db.prepare('SELECT * FROM daily_polls WHERE id=?').get(poll.id);
  const total = updated.bullish_count + updated.bearish_count + updated.neutral_count;
  const bullPct = total ? Math.round(updated.bullish_count/total*100) : 0;
  const bearPct = total ? Math.round(updated.bearish_count/total*100) : 0;
  const neutPct = total ? 100-bullPct-bearPct : 0;
  res.json({ success: true, poll: { ...updated, total, bullPct, bearPct, neutPct, myVote: choice } });
});

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

// ── الاستطلاعات المخصصة ──────────────────────────────────────────

// جلب الاستطلاع النشط
app.get('/api/custom-poll/active', (req, res) => {
  const poll = db.prepare('SELECT * FROM custom_polls WHERE is_active=1 ORDER BY created_at DESC LIMIT 1').get();
  if (!poll) return res.json({ poll: null });
  const options = db.prepare('SELECT * FROM custom_poll_options WHERE poll_id=? ORDER BY sort_order').all(poll.id);
  const total = options.reduce((s,o) => s+o.votes_count, 0);
  let myVote = null;
  if (req.session.userId) {
    const v = db.prepare('SELECT option_id FROM custom_poll_votes WHERE user_id=? AND poll_id=?').get(req.session.userId, poll.id);
    myVote = v ? v.option_id : null;
  }
  res.json({ poll: { ...poll, options: options.map(o => ({ ...o, pct: total ? Math.round(o.votes_count/total*100) : 0 })), total, myVote } });
});

// التصويت في استطلاع مخصص
app.post('/api/custom-poll/:id/vote', requireAuth, (req, res) => {
  const { option_id } = req.body;
  const poll = db.prepare('SELECT * FROM custom_polls WHERE id=? AND is_active=1').get(req.params.id);
  if (!poll) return res.json({ error: 'الاستطلاع غير موجود أو منتهي' });
  const option = db.prepare('SELECT * FROM custom_poll_options WHERE id=? AND poll_id=?').get(option_id, poll.id);
  if (!option) return res.json({ error: 'خيار غير صحيح' });
  const existing = db.prepare('SELECT * FROM custom_poll_votes WHERE user_id=? AND poll_id=?').get(req.session.userId, poll.id);
  if (existing) {
    if (existing.option_id === option_id) return res.json({ error: 'صوّتت مسبقاً بهذا الخيار' });
    db.prepare('UPDATE custom_poll_options SET votes_count=votes_count-1 WHERE id=?').run(existing.option_id);
    db.prepare('UPDATE custom_poll_options SET votes_count=votes_count+1 WHERE id=?').run(option_id);
    db.prepare('UPDATE custom_poll_votes SET option_id=? WHERE user_id=? AND poll_id=?').run(option_id, req.session.userId, poll.id);
  } else {
    db.prepare('UPDATE custom_poll_options SET votes_count=votes_count+1 WHERE id=?').run(option_id);
    db.prepare('INSERT INTO custom_poll_votes (user_id,poll_id,option_id) VALUES (?,?,?)').run(req.session.userId, poll.id, option_id);
    db.prepare('UPDATE users SET reputation=reputation+1 WHERE id=?').run(req.session.userId);
  }
  // إعادة جلب النتائج
  const options = db.prepare('SELECT * FROM custom_poll_options WHERE poll_id=? ORDER BY sort_order').all(poll.id);
  const total = options.reduce((s,o) => s+o.votes_count, 0);
  res.json({ success: true, poll: { ...poll, options: options.map(o => ({ ...o, pct: total ? Math.round(o.votes_count/total*100) : 0 })), total, myVote: option_id } });
});

// ── إدارة الاستطلاعات (أدمن) ────────────────────────────────────
app.get('/api/admin/polls', requireAdmin, (req, res) => {
  const polls = db.prepare('SELECT * FROM custom_polls ORDER BY created_at DESC').all();
  const result = polls.map(p => {
    const options = db.prepare('SELECT * FROM custom_poll_options WHERE poll_id=? ORDER BY sort_order').all(p.id);
    const total = options.reduce((s,o) => s+o.votes_count, 0);
    return { ...p, options, total };
  });
  res.json({ polls: result });
});

// إنشاء استطلاع جديد
app.post('/api/admin/polls', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const { question, options, ends_at } = req.body;
  if (!question || !options || options.length < 2) return res.json({ error: 'السؤال والخيارات مطلوبة (2 على الأقل)' });
  // إيقاف كل الاستطلاعات النشطة
  db.prepare('UPDATE custom_polls SET is_active=0').run();
  const pollId = uuidv4();
  db.prepare('INSERT INTO custom_polls (id,question,is_active,created_by,ends_at) VALUES (?,?,1,?,?)').run(pollId, question.trim(), admin.id, ends_at||null);
  options.forEach((opt, i) => {
    db.prepare('INSERT INTO custom_poll_options (id,poll_id,label,emoji,sort_order) VALUES (?,?,?,?,?)').run(uuidv4(), pollId, opt.label.trim(), opt.emoji||'', i);
  });
  logAdminAction(admin.id, admin.display_name, 'إنشاء استطلاع', 'poll', pollId, question);
  res.json({ success: true, poll_id: pollId });
});

// تفعيل/إيقاف استطلاع
app.post('/api/admin/polls/:id/toggle', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const poll = db.prepare('SELECT * FROM custom_polls WHERE id=?').get(req.params.id);
  if (!poll) return res.json({ error: 'غير موجود' });
  if (!poll.is_active) {
    // تفعيل — أوقف البقية أولاً
    db.prepare('UPDATE custom_polls SET is_active=0').run();
  }
  const newVal = poll.is_active ? 0 : 1;
  db.prepare('UPDATE custom_polls SET is_active=? WHERE id=?').run(newVal, req.params.id);
  logAdminAction(admin.id, admin.display_name, newVal?'تفعيل استطلاع':'إيقاف استطلاع', 'poll', poll.id, poll.question);
  res.json({ success: true, is_active: newVal });
});

// حذف استطلاع
app.delete('/api/admin/polls/:id', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const poll = db.prepare('SELECT * FROM custom_polls WHERE id=?').get(req.params.id);
  if (!poll) return res.json({ error: 'غير موجود' });
  db.prepare('DELETE FROM custom_poll_votes WHERE poll_id=?').run(req.params.id);
  db.prepare('DELETE FROM custom_poll_options WHERE poll_id=?').run(req.params.id);
  db.prepare('DELETE FROM custom_polls WHERE id=?').run(req.params.id);
  logAdminAction(admin.id, admin.display_name, 'حذف استطلاع', 'poll', poll.id, poll.question);
  res.json({ success: true });
});

// تحديث سؤال استطلاع يومي
app.post('/api/admin/poll/daily-question', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const { question } = req.body;
  if (!question) return res.json({ error: 'السؤال مطلوب' });
  const today = new Date().toISOString().split('T')[0];
  const poll = db.prepare('SELECT id FROM daily_polls WHERE date=?').get(today);
  if (poll) {
    db.prepare('UPDATE daily_polls SET question=? WHERE date=?').run(question.trim(), today);
  } else {
    db.prepare('INSERT INTO daily_polls (id,date,question) VALUES (?,?,?)').run(uuidv4(), today, question.trim());
  }
  logAdminAction(admin.id, admin.display_name, 'تعديل سؤال الاستطلاع اليومي', 'poll', today, question);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — نظام الأدمن الكامل مع تسلسل الصلاحيات
// ══════════════════════════════════════════════════════════════════════════════

// إضافة الحقول الجديدة
try { db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN is_super_admin INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN is_suspended INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE posts ADD COLUMN is_pinned INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE posts ADD COLUMN pinned_at DATETIME`); } catch(e) {}
try { db.exec(`ALTER TABLE posts ADD COLUMN is_soft_deleted INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE posts ADD COLUMN soft_deleted_at DATETIME`); } catch(e) {}
try { db.exec(`ALTER TABLE posts ADD COLUMN soft_deleted_by TEXT`); } catch(e) {}

// جدول سجل تحركات الأدمن
db.exec(`CREATE TABLE IF NOT EXISTS admin_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  admin_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  target_name TEXT,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ── Helper: تسجيل حركة الأدمن ───────────────────────────────────
function logAdminAction(adminId, adminName, action, targetType, targetId, targetName, details='') {
  db.prepare(`INSERT INTO admin_logs (id,admin_id,admin_name,action,target_type,target_id,target_name,details) VALUES (?,?,?,?,?,?,?,?)`)
    .run(uuidv4(), adminId, adminName, action, targetType||'', targetId||'', targetName||'', details);
}

// ── Helper: جلب بيانات الأدمن الحالي ───────────────────────────
function getAdminUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT id,username,display_name,is_admin,is_super_admin FROM users WHERE id=?').get(req.session.userId);
}

// ── Middleware ──────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'غير مصرح' });
  const user = db.prepare('SELECT is_admin,is_super_admin FROM users WHERE id=?').get(req.session.userId);
  if (!user || (!user.is_admin && !user.is_super_admin)) return res.status(401).json({ error: 'غير مصرح' });
  req.session.isAdmin = true;
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'غير مصرح' });
  const user = db.prepare('SELECT is_super_admin FROM users WHERE id=?').get(req.session.userId);
  if (!user || !user.is_super_admin) return res.status(403).json({ error: 'هذه الصلاحية للسوبر أدمن فقط' });
  next();
}

// ── تحقق الأدمن ─────────────────────────────────────────────────
app.get('/api/admin/check', (req, res) => {
  if (!req.session.userId) return res.json({ isAdmin: false, isSuperAdmin: false });
  const user = db.prepare('SELECT is_admin,is_super_admin FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.json({ isAdmin: false, isSuperAdmin: false });
  res.json({
    isAdmin: !!(user.is_admin || user.is_super_admin),
    isSuperAdmin: !!user.is_super_admin
  });
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sahm-admin-2026';
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) { req.session.isAdmin = true; res.json({ success: true }); }
  else res.json({ error: 'كلمة المرور غير صحيحة' });
});
app.post('/api/admin/logout', (req, res) => { req.session.isAdmin = false; res.json({ success: true }); });

// ── إحصائيات ────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json({
    totalUsers:     db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    totalPosts:     db.prepare('SELECT COUNT(*) as c FROM posts WHERE is_soft_deleted=0').get().c,
    deletedPosts:   db.prepare('SELECT COUNT(*) as c FROM posts WHERE is_soft_deleted=1').get().c,
    totalComments:  db.prepare('SELECT COUNT(*) as c FROM comments').get().c,
    totalVotes:     db.prepare('SELECT COUNT(*) as c FROM votes').get().c,
    newUsersToday:  db.prepare("SELECT COUNT(*) as c FROM users WHERE DATE(created_at)=DATE('now')").get().c,
    newPostsToday:  db.prepare("SELECT COUNT(*) as c FROM posts WHERE DATE(created_at)=DATE('now') AND is_soft_deleted=0").get().c,
    suspendedUsers: db.prepare('SELECT COUNT(*) as c FROM users WHERE is_suspended=1').get().c,
    topStocks:      db.prepare("SELECT stock_symbols, COUNT(*) as c FROM posts WHERE stock_symbols!='' AND is_soft_deleted=0 GROUP BY stock_symbols ORDER BY c DESC LIMIT 5").all(),
  });
});

// ── إدارة الأعضاء ───────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const { search, page } = req.query;
  const limit = 20, offset = (parseInt(page)||0)*limit;
  const like = `%${search||''}%`;
  const users = search
    ? db.prepare('SELECT id,username,display_name,email,reputation,level,posts_count,followers_count,is_verified,is_admin,is_super_admin,is_suspended,created_at FROM users WHERE username LIKE ? OR display_name LIKE ? OR email LIKE ? ORDER BY is_super_admin DESC, is_admin DESC, created_at DESC LIMIT ? OFFSET ?').all(like,like,like,limit,offset)
    : db.prepare('SELECT id,username,display_name,email,reputation,level,posts_count,followers_count,is_verified,is_admin,is_super_admin,is_suspended,created_at FROM users ORDER BY is_super_admin DESC, is_admin DESC, created_at DESC LIMIT ? OFFSET ?').all(limit,offset);
  res.json({ users: users.map(u => ({ ...u, level_name: getLevelName(u.level), joined: formatTime(u.created_at) })) });
});

// توثيق عضو
app.post('/api/admin/users/:id/verify', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const user = db.prepare('SELECT id,username,display_name,is_verified,is_super_admin FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ error: 'غير موجود' });
  if (user.is_super_admin) return res.json({ error: 'لا يمكن تعديل السوبر أدمن' });
  const v = user.is_verified ? 0 : 1;
  db.prepare('UPDATE users SET is_verified=? WHERE id=?').run(v, req.params.id);
  logAdminAction(admin.id, admin.display_name, v?'توثيق عضو':'إلغاء توثيق', 'user', user.id, user.display_name);
  res.json({ success: true, is_verified: v });
});

// منح/سحب شارة محلل فني (سوبر أدمن فقط)
app.post('/api/admin/users/:id/make-analyst', requireSuperAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const user = db.prepare('SELECT id,username,display_name,is_analyst,is_super_admin FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ error: 'غير موجود' });
  if (user.is_super_admin) return res.json({ error: 'لا يمكن تعديل السوبر أدمن' });
  const v = user.is_analyst ? 0 : 1;
  db.prepare('UPDATE users SET is_analyst=? WHERE id=?').run(v, req.params.id);
  logAdminAction(admin.id, admin.display_name, v?'منح شارة محلل فني':'سحب شارة محلل فني', 'user', user.id, user.display_name);
  res.json({ success: true, is_analyst: v });
});

// إيقاف/تفعيل عضو
app.post('/api/admin/users/:id/suspend', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const user = db.prepare('SELECT id,username,display_name,is_suspended,is_admin,is_super_admin FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ error: 'غير موجود' });
  if (user.is_super_admin) return res.json({ error: 'لا يمكن إيقاف السوبر أدمن' });
  if (user.is_admin && !admin.is_super_admin) return res.json({ error: 'فقط السوبر أدمن يستطيع إيقاف أدمن' });
  const v = user.is_suspended ? 0 : 1;
  db.prepare('UPDATE users SET is_suspended=? WHERE id=?').run(v, req.params.id);
  logAdminAction(admin.id, admin.display_name, v?'إيقاف عضو':'تفعيل عضو', 'user', user.id, user.display_name);
  res.json({ success: true, is_suspended: v });
});

// إعطاء/سحب صلاحية أدمن (سوبر أدمن فقط)
app.post('/api/admin/users/:id/make-admin', requireSuperAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const user = db.prepare('SELECT id,username,display_name,is_admin,is_super_admin FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ error: 'غير موجود' });
  if (user.is_super_admin) return res.json({ error: 'لا يمكن تعديل السوبر أدمن' });
  const v = user.is_admin ? 0 : 1;
  db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(v, req.params.id);
  logAdminAction(admin.id, admin.display_name, v?'إعطاء صلاحية أدمن':'سحب صلاحية أدمن', 'user', user.id, user.display_name);
  res.json({ success: true, is_admin: v });
});

// ── تغيير كلمة مرور عضو (سوبر أدمن فقط) ───────────────────────
app.post('/api/admin/users/:id/change-password', requireSuperAdmin, async (req, res) => {
  const admin = getAdminUser(req);
  const { new_password } = req.body;
  if (!new_password || new_password.length < 8) return res.json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
  const user = db.prepare('SELECT id,display_name,is_super_admin FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ error: 'المستخدم غير موجود' });
  if (user.is_super_admin && admin.id !== user.id) return res.json({ error: 'لا يمكن تغيير كلمة مرور السوبر أدمن' });
  const hash = await bcrypt.hash(new_password, 12);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, req.params.id);
  logAdminAction(admin.id, admin.display_name, 'تغيير كلمة مرور', 'user', user.id, user.display_name);
  res.json({ success: true });
});

// ── نظام نسيت كلمة المرور (جاهز للبريد — يُفعَّل عند إضافة SMTP) ──
// جدول tokens
try { db.exec(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  used INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`); } catch(e) {}

// طلب إعادة تعيين (يُرسل رابط لاحقاً عبر البريد)
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ error: 'البريد الإلكتروني مطلوب' });
  const user = db.prepare('SELECT id,display_name,email FROM users WHERE email=?').get(email.toLowerCase().trim());
  // نرجع نفس الرسالة حتى لو البريد مش موجود (أمان)
  if (!user) return res.json({ success: true, message: 'إذا كان البريد مسجلاً، ستصلك رسالة قريباً' });

  // حذف أي tokens قديمة لهذا المستخدم
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(user.id);

  const token = uuidv4().replace(/-/g,'');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // ساعة واحدة
  db.prepare('INSERT INTO password_reset_tokens (id,user_id,token,expires_at) VALUES (?,?,?,?)').run(uuidv4(), user.id, token, expiresAt);

  const resetLink = `${process.env.SITE_URL || 'https://brzan.com'}/reset-password?token=${token}`;

  // ── إرسال البريد (مُعطَّل حتى تُضاف بيانات SMTP) ──
  // لتفعيله: npm install nodemailer ثم أضف SMTP_HOST, SMTP_USER, SMTP_PASS في .env
  /*
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransporter({
    host: process.env.SMTP_HOST,
    port: 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: `"جلسة السوق" <${process.env.SMTP_USER}>`,
    to: user.email,
    subject: 'إعادة تعيين كلمة المرور — جلسة السوق',
    html: `<div dir="rtl" style="font-family:Arial;max-width:500px;margin:auto">
      <h2>مرحباً ${user.display_name}</h2>
      <p>طلبت إعادة تعيين كلمة المرور. اضغط على الرابط أدناه:</p>
      <a href="${resetLink}" style="background:#1D4ED8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin:16px 0">إعادة تعيين كلمة المرور</a>
      <p style="color:#666;font-size:13px">الرابط صالح لمدة ساعة واحدة فقط. إذا لم تطلب هذا، تجاهل الرسالة.</p>
    </div>`
  });
  */

  console.log(`[RESET PASSWORD] رابط إعادة التعيين لـ ${user.email}: ${resetLink}`);
  res.json({ success: true, message: 'إذا كان البريد مسجلاً، ستصلك رسالة قريباً',
    // مؤقتاً للتطوير — أزل هذا في الإنتاج
    _dev_link: process.env.NODE_ENV !== 'production' ? resetLink : undefined
  });
});

// التحقق من token
app.get('/api/auth/reset-password/:token', (req, res) => {
  const record = db.prepare('SELECT * FROM password_reset_tokens WHERE token=? AND used=0').get(req.params.token);
  if (!record) return res.json({ valid: false, error: 'الرابط غير صحيح أو منتهي الصلاحية' });
  if (new Date(record.expires_at) < new Date()) {
    db.prepare('DELETE FROM password_reset_tokens WHERE token=?').run(req.params.token);
    return res.json({ valid: false, error: 'انتهت صلاحية الرابط، يرجى طلب رابط جديد' });
  }
  const user = db.prepare('SELECT display_name FROM users WHERE id=?').get(record.user_id);
  res.json({ valid: true, display_name: user?.display_name });
});

// تعيين كلمة المرور الجديدة
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) return res.json({ error: 'بيانات ناقصة' });
  if (new_password.length < 8) return res.json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
  const record = db.prepare('SELECT * FROM password_reset_tokens WHERE token=? AND used=0').get(token);
  if (!record) return res.json({ error: 'الرابط غير صحيح أو منتهي الصلاحية' });
  if (new Date(record.expires_at) < new Date()) {
    db.prepare('DELETE FROM password_reset_tokens WHERE token=?').run(token);
    return res.json({ error: 'انتهت صلاحية الرابط، يرجى طلب رابط جديد' });
  }
  const hash = await bcrypt.hash(new_password, 12);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, record.user_id);
  db.prepare('UPDATE password_reset_tokens SET used=1 WHERE token=?').run(token);
  res.json({ success: true });
});

// حذف عضو (سوبر أدمن فقط)
app.delete('/api/admin/users/:id', requireSuperAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const user = db.prepare('SELECT id,display_name,is_super_admin FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ error: 'غير موجود' });
  if (user.is_super_admin) return res.json({ error: 'لا يمكن حذف السوبر أدمن' });
  ['DELETE FROM comments WHERE user_id=?','DELETE FROM votes WHERE user_id=?',
   'DELETE FROM follows WHERE follower_id=? OR following_id=?','DELETE FROM posts WHERE user_id=?',
   'DELETE FROM notifications WHERE user_id=? OR from_user_id=?','DELETE FROM users WHERE id=?'
  ].forEach((q,i) => i===2||i===4 ? db.prepare(q).run(req.params.id,req.params.id) : db.prepare(q).run(req.params.id));
  logAdminAction(admin.id, admin.display_name, 'حذف عضو نهائي', 'user', req.params.id, user.display_name);
  res.json({ success: true });
});

// ── إدارة المنشورات ─────────────────────────────────────────────
app.get('/api/admin/posts', requireAdmin, (req, res) => {
  const { search, page, deleted } = req.query;
  const limit = 20, offset = (parseInt(page)||0)*limit;
  const like = `%${search||''}%`;
  const showDeleted = deleted === '1' ? 1 : 0;
  const posts = search
    ? db.prepare('SELECT p.*,u.username,u.display_name FROM posts p JOIN users u ON p.user_id=u.id WHERE (p.content LIKE ? OR u.username LIKE ?) AND p.is_soft_deleted=? ORDER BY p.created_at DESC LIMIT ? OFFSET ?').all(like,like,showDeleted,limit,offset)
    : db.prepare('SELECT p.*,u.username,u.display_name FROM posts p JOIN users u ON p.user_id=u.id WHERE p.is_soft_deleted=? ORDER BY p.is_pinned DESC, p.created_at DESC LIMIT ? OFFSET ?').all(showDeleted,limit,offset);
  res.json({ posts: posts.map(p => ({ ...p, time_ago: formatTime(p.created_at) })) });
});

// تثبيت/إلغاء تثبيت
app.post('/api/admin/posts/:id/pin', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const post = db.prepare('SELECT id,is_pinned,content FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.json({ error: 'المنشور غير موجود' });
  const newVal = post.is_pinned ? 0 : 1;
  db.prepare('UPDATE posts SET is_pinned=?,pinned_at=? WHERE id=?').run(newVal, newVal?new Date().toISOString():null, req.params.id);
  logAdminAction(admin.id, admin.display_name, newVal?'تثبيت منشور':'إلغاء تثبيت منشور', 'post', post.id, post.content.substring(0,50));
  res.json({ success: true, is_pinned: newVal });
});

// تعديل منشور
app.put('/api/admin/posts/:id', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const { content } = req.body;
  if (!content || content.trim().length < 3) return res.json({ error: 'المحتوى قصير' });
  const post = db.prepare('SELECT id,content FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.json({ error: 'غير موجود' });
  db.prepare('UPDATE posts SET content=? WHERE id=?').run(content.trim(), req.params.id);
  logAdminAction(admin.id, admin.display_name, 'تعديل منشور', 'post', post.id, post.content.substring(0,50), `جديد: ${content.substring(0,50)}`);
  res.json({ success: true });
});

// حذف مؤقت (أدمن + سوبر أدمن)
app.post('/api/admin/posts/:id/soft-delete', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const post = db.prepare('SELECT id,content,is_soft_deleted FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.json({ error: 'غير موجود' });
  db.prepare('UPDATE posts SET is_soft_deleted=1,soft_deleted_at=?,soft_deleted_by=? WHERE id=?')
    .run(new Date().toISOString(), admin.id, req.params.id);
  logAdminAction(admin.id, admin.display_name, 'حذف مؤقت لمنشور', 'post', post.id, post.content.substring(0,50));
  res.json({ success: true });
});

// استعادة منشور محذوف مؤقتاً (سوبر أدمن فقط)
app.post('/api/admin/posts/:id/restore', requireSuperAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const post = db.prepare('SELECT id,content FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.json({ error: 'غير موجود' });
  db.prepare('UPDATE posts SET is_soft_deleted=0,soft_deleted_at=NULL,soft_deleted_by=NULL WHERE id=?').run(req.params.id);
  logAdminAction(admin.id, admin.display_name, 'استعادة منشور محذوف', 'post', post.id, post.content.substring(0,50));
  res.json({ success: true });
});

// حذف نهائي (سوبر أدمن فقط)
app.delete('/api/admin/posts/:id', requireSuperAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const post = db.prepare('SELECT id,content,user_id FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.json({ error: 'غير موجود' });
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare("DELETE FROM votes WHERE target_id IN (SELECT id FROM comments WHERE post_id=?) AND target_type='comment'").run(req.params.id);
    db.prepare('DELETE FROM comments WHERE post_id=?').run(req.params.id);
    db.prepare("DELETE FROM votes WHERE target_id=? AND target_type='post'").run(req.params.id);
    db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
    if (post.user_id) db.prepare('UPDATE users SET posts_count = MAX(0, posts_count - 1) WHERE id=?').run(post.user_id);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  logAdminAction(admin.id, admin.display_name, 'حذف نهائي لمنشور', 'post', req.params.id, post.content.substring(0,50));
  res.json({ success: true });
});

// ── إدارة التعليقات ─────────────────────────────────────────────
app.get('/api/admin/comments', requireAdmin, (req, res) => {
  const { search, page } = req.query;
  const limit = 20, offset = (parseInt(page)||0)*limit;
  const like = `%${search||''}%`;
  const comments = search
    ? db.prepare('SELECT c.*,u.username,u.display_name FROM comments c JOIN users u ON c.user_id=u.id WHERE c.content LIKE ? OR u.username LIKE ? ORDER BY c.created_at DESC LIMIT ? OFFSET ?').all(like,like,limit,offset)
    : db.prepare('SELECT c.*,u.username,u.display_name FROM comments c JOIN users u ON c.user_id=u.id ORDER BY c.created_at DESC LIMIT ? OFFSET ?').all(limit,offset);
  res.json({ comments: comments.map(c => ({ ...c, time_ago: formatTime(c.created_at) })) });
});

app.delete('/api/admin/comments/:id', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const comment = db.prepare('SELECT id,content FROM comments WHERE id=?').get(req.params.id);
  if (!comment) return res.json({ error: 'غير موجود' });
  db.prepare('DELETE FROM comments WHERE id=?').run(req.params.id);
  logAdminAction(admin.id, admin.display_name, 'حذف تعليق', 'comment', comment.id, comment.content.substring(0,50));
  res.json({ success: true });
});

// ── سجل تحركات الأدمن (سوبر أدمن فقط) ──────────────────────────
app.get('/api/admin/logs', requireSuperAdmin, (req, res) => {
  const { page } = req.query;
  const limit = 30, offset = (parseInt(page)||0)*limit;
  const logs = db.prepare('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  res.json({ logs: logs.map(l => ({ ...l, time_ago: formatTime(l.created_at) })) });
});

// ── إدارة الأخبار ───────────────────────────────────────────────
app.delete('/api/admin/news/:id', requireAdmin, (req, res) => {
  const admin = getAdminUser(req);
  const news = db.prepare('SELECT post_id FROM news_posts WHERE id = ?').get(req.params.id);
  if (news?.post_id) {
    db.prepare('DELETE FROM comments WHERE post_id = ?').run(news.post_id);
    db.prepare('DELETE FROM posts WHERE id = ?').run(news.post_id);
  }
  db.prepare('DELETE FROM news_posts WHERE id = ?').run(req.params.id);
  logAdminAction(admin.id, admin.display_name, 'حذف خبر', 'news', req.params.id, '');
  res.json({ success: true });
});

app.post('/api/admin/news', requireAdmin, async (req, res) => {
  const admin = getAdminUser(req);
  const { title, summary, source, stock_symbols } = req.body;
  if (!title) return res.json({ error: 'العنوان مطلوب' });
  let newsUser = db.prepare("SELECT id FROM users WHERE username='jalsat_news'").get();
  if (!newsUser) {
    const id = uuidv4();
    const hash = await require('bcryptjs').hash('jalsat_news_secure_2026', 10);
    db.prepare("INSERT OR IGNORE INTO users (id,username,display_name,email,password_hash,is_verified,level) VALUES (?,?,?,?,?,1,5)").run(
      id,'jalsat_news','📰 أخبار السوق','news@jalsat.com',hash
    );
    newsUser = { id };
  }
  const postId = uuidv4();
  const content = `📰 ${title}\n\n${summary||''}\n\n📌 المصدر: ${source||'جلسة السوق'}`;
  db.prepare("INSERT INTO posts (id,user_id,content,stock_symbols,post_type) VALUES (?,?,?,?,?)").run(
    postId, newsUser.id, content, stock_symbols||'', 'news'
  );
  logAdminAction(admin.id, admin.display_name, 'إضافة خبر', 'post', postId, title);
  res.json({ success: true, post_id: postId });
});

app.get('/api/posts/:id', (req, res) => {
  const post = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar, u.level, u.is_verified
    FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?`).get(req.params.id);
  if (!post) return res.status(404).json({ error: 'المنشور غير موجود' });
  let myVote = null;
  if (req.session.userId) {
    const v = db.prepare(`SELECT vote_type FROM votes WHERE user_id=? AND target_id=? AND target_type='post'`).get(req.session.userId, post.id);
    myVote = v ? v.vote_type : null;
  }
  res.json({ post: { ...post, time_ago: formatTime(post.created_at), level_name: getLevelName(post.level), my_vote: myVote } });
});

// ══════════════════════════════════════════════════════════════════════════════
// VOICE ROOMS — الرومات الصوتية (LiveKit)
// ══════════════════════════════════════════════════════════════════════════════

const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://brzan.com/livekit';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'APILP3Ch9xmbJN3';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'dfvXuYwpyLCLnG0ucawNNnSDDRdZBNQpDqszPcKgiwQ';

const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const livekitService = new RoomServiceClient('http://localhost:7880', LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// جداول الرومات
db.exec(`
  CREATE TABLE IF NOT EXISTS voice_rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    host_id TEXT NOT NULL,
    topic TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    participants_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (host_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS room_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    is_system INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES voice_rooms(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'listener',
    can_speak INTEGER DEFAULT 0,
    is_muted INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    chat_banned INTEGER DEFAULT 0,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS room_hand_requests (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, user_id)
  );
`);

// إضافة عمود is_analyst
try { db.exec(`ALTER TABLE users ADD COLUMN is_analyst INTEGER DEFAULT 0`); } catch(e) {}

// إضافة عمود chart_symbol للمنشورات
try { db.exec(`ALTER TABLE posts ADD COLUMN chart_symbol TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE posts ADD COLUMN chart_exchange TEXT DEFAULT 'TADAWUL'`); } catch(e) {}

// إضافة عمود permanently_closed إذا ما كان موجوداً (migration آمن)
try { db.exec(`ALTER TABLE voice_rooms ADD COLUMN permanently_closed INTEGER DEFAULT 0`); } catch(e) {}
// تنظيف: أي روم غير نشط موجود مسبقاً يُعتبر مغلقاً نهائياً
try { db.prepare(`UPDATE voice_rooms SET permanently_closed=1, participants_count=0 WHERE is_active=0`).run(); } catch(e) {}
// إصلاح عداد المشاركين ليطابق الواقع الفعلي
try {
  db.prepare(`UPDATE voice_rooms SET participants_count = (
    SELECT COUNT(*) FROM room_members WHERE room_id = voice_rooms.id AND is_banned = 0
  ) WHERE is_active = 1`).run();
} catch(e) {}

// helper: تحقق صلاحية المستخدم في الروم
function getRoomRole(roomId, userId, room) {
  if (room.host_id === userId) return 'owner';
  const member = db.prepare(`SELECT role FROM room_members WHERE room_id=? AND user_id=?`).get(roomId, userId);
  return member ? member.role : 'listener';
}

function canModerate(role) { return role === 'owner' || role === 'mod'; }

// توليد Token
app.post('/api/rooms/:id/token', requireAuth, async (req, res) => {
  const room = db.prepare(`SELECT * FROM voice_rooms WHERE id = ? AND is_active = 1 AND permanently_closed = 0`).get(req.params.id);
  if (!room) return res.json({ error: 'الروم غير موجود' });
  const user = getUser(req.session.userId);
  const role = getRoomRole(req.params.id, req.session.userId, room);
  const isHost = role === 'owner';
  const isMod = role === 'mod';
  const member = db.prepare(`SELECT * FROM room_members WHERE room_id=? AND user_id=?`).get(req.params.id, req.session.userId);
  const canSpeak = isHost || isMod || (member && member.can_speak);
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: user.id,
    name: user.display_name,
    ttl: '4h',
  });
  at.addGrant({
    roomJoin: true,
    room: req.params.id,
    canPublish: canSpeak,
    canSubscribe: true,
    canPublishData: true,
  });
  const token = await at.toJwt();
  res.json({ token, livekitUrl: LIVEKIT_URL, isHost, isMod, canSpeak, role });
});

// جلب معلومات الروم مع الأعضاء
app.get('/api/rooms/:id/info', requireAuth, (req, res) => {
  const room = db.prepare(`SELECT r.*, u.display_name as host_name FROM voice_rooms r JOIN users u ON r.host_id=u.id WHERE r.id=?`).get(req.params.id);
  if (!room) return res.json({ error: 'غير موجود' });
  const members = db.prepare(`SELECT rm.*, u.display_name, u.avatar FROM room_members rm JOIN users u ON rm.user_id=u.id WHERE rm.room_id=? AND rm.is_banned=0`).all(req.params.id);
  const hands = db.prepare(`SELECT rh.user_id, u.display_name FROM room_hand_requests rh JOIN users u ON rh.user_id=u.id WHERE rh.room_id=?`).all(req.params.id);
  const myRole = getRoomRole(req.params.id, req.session.userId, room);
  res.json({ room, members, hands, myRole });
});

// جلب الرومات النشطة
app.get('/api/rooms', (req, res) => {
  const rooms = db.prepare(`
    SELECT r.*, u.display_name as host_name, u.avatar as host_avatar, u.is_verified as host_verified
    FROM voice_rooms r JOIN users u ON r.host_id = u.id
    WHERE r.is_active = 1
    ORDER BY r.participants_count DESC, r.created_at DESC LIMIT 20
  `).all();
  res.json({ rooms });
});

// إنشاء روم
app.post('/api/rooms', requireAuth, (req, res) => {
  const { name, description, topic } = req.body;
  if (!name || name.trim().length < 2) return res.json({ error: 'اسم الروم مطلوب' });
  const id = uuidv4().replace(/-/g,'').slice(0,12);
  db.prepare(`INSERT INTO voice_rooms (id,name,description,host_id,topic) VALUES (?,?,?,?,?)`).run(
    id, name.trim(), description||'', req.session.userId, topic||''
  );
  const room = db.prepare(`SELECT r.*, u.display_name as host_name FROM voice_rooms r JOIN users u ON r.host_id=u.id WHERE r.id=?`).get(id);
  res.json({ success: true, room });
});

app.post('/api/rooms/:id/join', requireAuth, (req, res) => {
  const room = db.prepare(`SELECT * FROM voice_rooms WHERE id = ?`).get(req.params.id);
  // منع الانضمام للرومات المغلقة نهائياً أو غير النشطة
  if (!room) return res.json({ error: 'الروم غير موجود' });
  if (room.permanently_closed) return res.json({ error: 'هذا الروم مغلق نهائياً ولا يمكن الانضمام إليه' });
  if (!room.is_active) return res.json({ error: 'الروم غير نشط' });

  // تحقق إذا كان المستخدم موجود مسبقاً لتجنب تكرار العداد
  const existing = db.prepare(`SELECT 1 FROM room_members WHERE room_id=? AND user_id=? AND is_banned=0`).get(req.params.id, req.session.userId);
  if (!existing) {
    db.prepare(`UPDATE voice_rooms SET participants_count = participants_count + 1 WHERE id = ?`).run(req.params.id);
    db.prepare(`INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?,?)`).run(req.params.id, req.session.userId);
  }
  res.json({ success: true });
});

app.post('/api/rooms/:id/leave', requireAuth, (req, res) => {
  db.prepare(`UPDATE voice_rooms SET participants_count = MAX(0, participants_count - 1) WHERE id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM room_members WHERE room_id=? AND user_id=?`).run(req.params.id, req.session.userId);
  db.prepare(`DELETE FROM room_hand_requests WHERE room_id=? AND user_id=?`).run(req.params.id, req.session.userId);
  const room = db.prepare(`SELECT * FROM voice_rooms WHERE id = ?`).get(req.params.id);
  // أغلق الروم تلقائياً فقط إذا لم يكن مغلقاً نهائياً
  if (room && !room.permanently_closed && room.participants_count === 0) {
    db.prepare(`UPDATE voice_rooms SET is_active = 0 WHERE id = ?`).run(req.params.id);
  }
  res.json({ success: true });
});

app.delete('/api/rooms/:id', requireAuth, (req, res) => {
  const room = db.prepare(`SELECT * FROM voice_rooms WHERE id = ?`).get(req.params.id);
  if (!room) return res.json({ error: 'الروم غير موجود' });
  const user = db.prepare('SELECT is_admin,is_super_admin FROM users WHERE id=?').get(req.session.userId);
  const isAdmin = user && (user.is_admin || user.is_super_admin);
  if (room.host_id !== req.session.userId && !isAdmin) return res.json({ error: 'غير مصرح' });
  // إغلاق نهائي — يمنع إعادة التفعيل تلقائياً
  db.prepare(`UPDATE voice_rooms SET is_active=0, permanently_closed=1, participants_count=0 WHERE id=?`).run(req.params.id);
  db.prepare(`DELETE FROM room_members WHERE room_id=?`).run(req.params.id);
  db.prepare(`DELETE FROM room_hand_requests WHERE room_id=?`).run(req.params.id);
  // محاولة إغلاق الروم في LiveKit
  try { livekitService.deleteRoom(req.params.id).catch(()=>{}); } catch(e) {}
  res.json({ success: true });
});

// ── رفع/إنزال اليد ──────────────────────────────────────────────
app.post('/api/rooms/:id/hand', requireAuth, (req, res) => {
  const { raise } = req.body;
  if (raise) {
    db.prepare(`INSERT OR REPLACE INTO room_hand_requests (room_id,user_id) VALUES (?,?)`).run(req.params.id, req.session.userId);
  } else {
    db.prepare(`DELETE FROM room_hand_requests WHERE room_id=? AND user_id=?`).run(req.params.id, req.session.userId);
  }
  res.json({ success: true });
});

// ── إعطاء المايك / سحبه ─────────────────────────────────────────
app.post('/api/rooms/:id/grant-mic/:userId', requireAuth, async (req, res) => {
  const room = db.prepare(`SELECT * FROM voice_rooms WHERE id = ?`).get(req.params.id);
  if (!room) return res.json({ error: 'غير موجود' });
  const myRole = getRoomRole(req.params.id, req.session.userId, room);
  if (!canModerate(myRole)) return res.json({ error: 'غير مصرح' });

  const grant = req.body.grant !== false; // true = إعطاء, false = سحب
  db.prepare(`UPDATE room_members SET can_speak=?, is_muted=0 WHERE room_id=? AND user_id=?`).run(grant?1:0, req.params.id, req.params.userId);
  db.prepare(`DELETE FROM room_hand_requests WHERE room_id=? AND user_id=?`).run(req.params.id, req.params.userId);

  // توليد token جديد للمستخدم مع صلاحية النشر
  try {
    const targetUser = getUser(req.params.userId);
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: req.params.userId,
      name: targetUser.display_name,
      ttl: '4h',
    });
    at.addGrant({ roomJoin: true, room: req.params.id, canPublish: grant, canSubscribe: true, canPublishData: true });
    const token = await at.toJwt();
    res.json({ success: true, token, grant });
  } catch(e) {
    res.json({ success: true, grant });
  }
});

// ── كتم مستخدم ──────────────────────────────────────────────────
app.post('/api/rooms/:id/mute/:userId', requireAuth, (req, res) => {
  const room = db.prepare(`SELECT * FROM voice_rooms WHERE id = ?`).get(req.params.id);
  if (!room) return res.json({ error: 'غير موجود' });
  const myRole = getRoomRole(req.params.id, req.session.userId, room);
  if (!canModerate(myRole)) return res.json({ error: 'غير مصرح' });
  // لا يمكن كتم الأونر
  if (room.host_id === req.params.userId) return res.json({ error: 'لا يمكن كتم المضيف' });
  db.prepare(`UPDATE room_members SET is_muted=1 WHERE room_id=? AND user_id=?`).run(req.params.id, req.params.userId);
  res.json({ success: true });
});

// ── طرد مستخدم ──────────────────────────────────────────────────
app.post('/api/rooms/:id/kick/:userId', requireAuth, async (req, res) => {
  const room = db.prepare(`SELECT * FROM voice_rooms WHERE id = ?`).get(req.params.id);
  if (!room) return res.json({ error: 'غير موجود' });
  const myRole = getRoomRole(req.params.id, req.session.userId, room);
  if (!canModerate(myRole)) return res.json({ error: 'غير مصرح' });
  // المشرف لا يقدر يطرد الأونر
  if (room.host_id === req.params.userId) return res.json({ error: 'لا يمكن طرد المضيف' });
  // المشرف لا يقدر يطرد مشرف آخر إلا الأونر
  const targetRole = getRoomRole(req.params.id, req.params.userId, room);
  if (targetRole === 'mod' && myRole !== 'owner') return res.json({ error: 'المشرف لا يستطيع طرد مشرف آخر' });

  db.prepare(`UPDATE room_members SET is_banned=1 WHERE room_id=? AND user_id=?`).run(req.params.id, req.params.userId);
  db.prepare(`UPDATE voice_rooms SET participants_count = MAX(0, participants_count - 1) WHERE id=?`).run(req.params.id);

  try { await livekitService.removeParticipant(req.params.id, req.params.userId); } catch(e) {}
  res.json({ success: true });
});

// ── حظر/رفع حظر الشات ───────────────────────────────────────────
app.post('/api/rooms/:id/chat-ban/:userId', requireAuth, (req, res) => {
  const room = db.prepare(`SELECT * FROM voice_rooms WHERE id = ?`).get(req.params.id);
  if (!room) return res.json({ error: 'غير موجود' });
  const myRole = getRoomRole(req.params.id, req.session.userId, room);
  if (!canModerate(myRole)) return res.json({ error: 'غير مصرح' });
  if (room.host_id === req.params.userId) return res.json({ error: 'لا يمكن حظر المضيف' });
  const ban = req.body.ban !== false;
  db.prepare(`UPDATE room_members SET chat_banned=? WHERE room_id=? AND user_id=?`).run(ban?1:0, req.params.id, req.params.userId);
  res.json({ success: true });
});

// ── إعطاء/سحب صلاحية مشرف ──────────────────────────────────────
app.post('/api/rooms/:id/mod/:userId', requireAuth, (req, res) => {
  const room = db.prepare(`SELECT * FROM voice_rooms WHERE id = ?`).get(req.params.id);
  if (!room) return res.json({ error: 'غير موجود' });
  if (room.host_id !== req.session.userId) return res.json({ error: 'فقط المضيف يستطيع تعيين مشرفين' });
  if (room.host_id === req.params.userId) return res.json({ error: 'المضيف هو الأدمن الأعلى' });
  const makeMod = req.body.mod !== false;
  db.prepare(`INSERT OR IGNORE INTO room_members (room_id,user_id) VALUES (?,?)`).run(req.params.id, req.params.userId);
  db.prepare(`UPDATE room_members SET role=? WHERE room_id=? AND user_id=?`).run(makeMod?'mod':'listener', req.params.id, req.params.userId);
  res.json({ success: true });
});

// ── رسائل الشات ─────────────────────────────────────────────────
app.get('/api/rooms/:id/messages', requireAuth, (req, res) => {
  const msgs = db.prepare(`
    SELECT m.*, u.display_name, u.avatar, u.is_verified
    FROM room_messages m JOIN users u ON m.user_id = u.id
    WHERE m.room_id = ? ORDER BY m.created_at ASC LIMIT 100
  `).all(req.params.id);
  res.json({ messages: msgs.map(m => ({ ...m, time_ago: formatTime(m.created_at) })) });
});

app.post('/api/rooms/:id/messages', requireAuth, (req, res) => {
  const { content } = req.body;
  if (!content || content.trim().length < 1) return res.json({ error: 'الرسالة فارغة' });
  const room = db.prepare(`SELECT id FROM voice_rooms WHERE id = ? AND is_active = 1`).get(req.params.id);
  if (!room) return res.json({ error: 'الروم غير موجود' });
  // تحقق من حظر الشات
  const member = db.prepare(`SELECT chat_banned FROM room_members WHERE room_id=? AND user_id=?`).get(req.params.id, req.session.userId);
  if (member && member.chat_banned) return res.json({ error: 'أنت محظور من الكتابة في هذا الروم' });
  const id = uuidv4();
  db.prepare(`INSERT INTO room_messages (id,room_id,user_id,content) VALUES (?,?,?,?)`).run(id, req.params.id, req.session.userId, content.trim());
  const msg = db.prepare(`SELECT m.*, u.display_name, u.avatar, u.is_verified FROM room_messages m JOIN users u ON m.user_id=u.id WHERE m.id=?`).get(id);
  res.json({ success: true, message: { ...msg, time_ago: 'الآن' } });
});



app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`✅ جلسة السوق تعمل على المنفذ ${PORT}`));

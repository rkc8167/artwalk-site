const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

// Load .env file for local development
try { require('dotenv').config(); } catch (e) {}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Set it in Railway → Variables.');
  process.exit(1);
}

const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://artwalk.site',
  'https://www.artwalk.site'
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(bodyParser.json());
app.use(express.static('public'));

const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/artwalk.db`
  : './artwalk.db';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
console.log('Connected to SQLite database at', DB_PATH);

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS artworks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    sub TEXT,
    location TEXT,
    artist TEXT,
    year TEXT,
    type TEXT,
    avatarInitial TEXT,
    desc TEXT,
    visitors INTEGER DEFAULT 0,
    saved INTEGER DEFAULT 0,
    inspired TEXT DEFAULT "0%",
    tags TEXT,
    browseCategory TEXT,
    browseLocation TEXT,
    color1 TEXT,
    color2 TEXT,
    userPhoto TEXT,
    lat REAL,
    lng REAL,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS feelings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artwork_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    feeling TEXT NOT NULL,
    note TEXT,
    is_public INTEGER DEFAULT 0,
    extra_emojis TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (artwork_id) REFERENCES artworks(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS saved_artworks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    artwork_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (artwork_id) REFERENCES artworks(id),
    UNIQUE(user_id, artwork_id)
  );

  CREATE TABLE IF NOT EXISTS walks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_public INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS walk_stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walk_id INTEGER NOT NULL,
    artwork_id INTEGER NOT NULL,
    stop_order INTEGER NOT NULL,
    FOREIGN KEY (walk_id) REFERENCES walks(id),
    FOREIGN KEY (artwork_id) REFERENCES artworks(id)
  );
`);

// ── Seed ────────────────────────────────────────────────────────────────────

const artworkCount = db.prepare('SELECT COUNT(*) as count FROM artworks').get();
if (artworkCount.count === 0) {
  const insert = db.prepare(`
    INSERT INTO artworks (title, sub, location, artist, year, type, avatarInitial, desc, visitors, saved, inspired, tags, browseCategory, browseLocation, color1, color2, userPhoto, lat, lng)
    VALUES (@title, @sub, @location, @artist, @year, @type, @avatarInitial, @desc, @visitors, @saved, @inspired, @tags, @browseCategory, @browseLocation, @color1, @color2, @userPhoto, @lat, @lng)
  `);
  const seedMany = db.transaction((artworks) => {
    for (const a of artworks) insert.run(a);
  });
  seedMany([
    { title: "High Hat Man and High Hat Woman", sub: "Lynn Chadwick · Landmark Alexandra, Central", location: "Landmark Alexandra, Central", artist: "Lynn Chadwick", year: "1957", type: "Sculpture", avatarInitial: "L", desc: '"High Hat Man and High Hat Woman" are two angular bronze figures standing side by side, their attenuated bodies topped with signature wide-brimmed hats. Chadwick\'s powerful geometric abstraction captures tension and presence in public space.', visitors: 243, saved: 61, inspired: "52%", tags: "Sculpture,Figurative,Bronze", browseCategory: "Sculpture", browseLocation: "Hong Kong Space Museum", color1: "#6b6560", color2: "#3a3028", userPhoto: null, lat: 22.2815, lng: 114.1576 },
    { title: "Fragrant Harbour", sub: "Kwok Mang Ho · IFC Mall, Central", location: "IFC Mall Atrium, Central", artist: "Kwok Mang Ho", year: "2004", type: "Mural", avatarInitial: "K", desc: "A sweeping panoramic ink mural celebrating Hong Kong's layered history and vibrant street life.", visitors: 189, saved: 44, inspired: "61%", tags: "Mural,Ink,Panoramic", browseCategory: "Murals", browseLocation: "IFC Mall, Central", color1: "#8a9878", color2: "#3d5030", userPhoto: null, lat: 22.2855, lng: 114.1577 },
    { title: "Urban Weave", sub: "Antonio Mak · Pacific Place, Admiralty", location: "Pacific Place, Admiralty", artist: "Antonio Mak", year: "1997", type: "Installation", avatarInitial: "A", desc: "Interlocking steel ribbons rise from the ground in a fluid, almost organic formation.", visitors: 312, saved: 78, inspired: "68%", tags: "Installation,Steel,Abstract", browseCategory: "Sculpture", browseLocation: "Pacific Place, Admiralty", color1: "#b0a898", color2: "#706858", userPhoto: null, lat: 22.2775, lng: 114.1655 },
    { title: "Harbour Mural", sub: "Gaylord Chan · Western District", location: "Western District Promenade", artist: "Gaylord Chan", year: "2011", type: "Mural", avatarInitial: "G", desc: "A community-led mural capturing the rhythm of daily life along the western harbour.", visitors: 156, saved: 29, inspired: "44%", tags: "Mural,Acrylic,Community", browseCategory: "Murals", browseLocation: "Western District", color1: "#7888a0", color2: "#344058", userPhoto: null, lat: 22.2890, lng: 114.1390 },
    { title: "Two Lines Oblique", sub: "George Rickey · HK Park, Central", location: "Hong Kong Park, Central", artist: "George Rickey", year: "1981", type: "Sculpture", avatarInitial: "G", desc: "Two polished stainless steel blades pivot slowly in the breeze.", visitors: 198, saved: 52, inspired: "55%", tags: "Sculpture,Kinetic,Steel", browseCategory: "Sculpture", browseLocation: "Kowloon Park", color1: "#98a888", color2: "#485838", userPhoto: null, lat: 22.2782, lng: 114.1624 },
    { title: "Sculpture I – General", sub: "Eduardo Paolozzi · HK Space Museum", location: "Hong Kong Space Museum", artist: "Eduardo Paolozzi", year: "1970", type: "Sculpture", avatarInitial: "E", desc: "A monumental bronze figure of fragmented mechanical and organic forms.", visitors: 421, saved: 93, inspired: "71%", tags: "Sculpture,Bronze,Figurative", browseCategory: "Sculpture", browseLocation: "Hong Kong Space Museum", color1: "#787068", color2: "#383028", userPhoto: null, lat: 22.2951, lng: 114.1718 },
    { title: "Universal Union", sub: "Ju Ming · HK Space Museum", location: "Hong Kong Space Museum", artist: "Ju Ming", year: "1992", type: "Sculpture", avatarInitial: "J", desc: "Part of Ju Ming's celebrated Taichi Series, capturing two figures in fluid martial movement.", visitors: 387, saved: 85, inspired: "66%", tags: "Sculpture,Marble,Taichi", browseCategory: "Sculpture", browseLocation: "Hong Kong Space Museum", color1: "#c8c4bc", color2: "#808078", userPhoto: null, lat: 22.2958, lng: 114.1726 },
    { title: "Clip", sub: "Henry Moore · HK Space Museum", location: "Hong Kong Space Museum", artist: "Henry Moore", year: "1965", type: "Sculpture", avatarInitial: "H", desc: "A sinuous bronze form exploring the tension between positive and negative space.", visitors: 356, saved: 79, inspired: "62%", tags: "Sculpture,Bronze,Abstract", browseCategory: "Sculpture", browseLocation: "Hong Kong Space Museum", color1: "#707070", color2: "#303030", userPhoto: null, lat: 22.2962, lng: 114.1730 },
    { title: "Dragon Gate", sub: "Cheung Yee · HK Cultural Centre", location: "Hong Kong Cultural Centre, Tsim Sha Tsui", artist: "Cheung Yee", year: "1988", type: "Sculpture", avatarInitial: "C", desc: "A monumental bronze gate form evoking ancient Chinese ceremonial architecture and maritime power.", visitors: 421, saved: 97, inspired: "74%", tags: "Sculpture,Bronze,Cultural", browseCategory: "Sculpture", browseLocation: "Hong Kong Cultural Centre", color1: "#c09050", color2: "#804010", userPhoto: null, lat: 22.2938, lng: 114.1720 },
    { title: "Neon Bloom", sub: "Sarah Leung · PMQ, Central", location: "PMQ, Central", artist: "Sarah Leung", year: "2020", type: "Installation", avatarInitial: "S", desc: "Hundreds of illuminated acrylic petals suspended from the ceiling pulse in shifting colour cycles.", visitors: 267, saved: 83, inspired: "79%", tags: "Installation,Light,Neon", browseCategory: "Installation", browseLocation: "PMQ, Central", color1: "#c860a0", color2: "#882070", userPhoto: null, lat: 22.2835, lng: 114.1520 },
    { title: "Kowloon Mosaic", sub: "Lui Shou-Kwan · Wong Tai Sin", location: "Wong Tai Sin Temple", artist: "Lui Shou-Kwan", year: "1975", type: "Mosaic", avatarInitial: "L", desc: "A vast ceramic mosaic panorama blending traditional Chinese motifs with the chaotic energy of urban Kowloon.", visitors: 378, saved: 89, inspired: "66%", tags: "Mosaic,Ceramic,Traditional", browseCategory: "Mosaic", browseLocation: "Wong Tai Sin", color1: "#c87030", color2: "#782808", userPhoto: null, lat: 22.3412, lng: 114.1950 }
  ]);
  console.log('Database seeded with initial artworks');
}

// ── Auth middleware ──────────────────────────────────────────────────────────

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch (e) {}
  }
  next();
};

// ── Artworks ────────────────────────────────────────────────────────────────

app.get('/api/artworks', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*, u.name as added_by_user_name
      FROM artworks a LEFT JOIN users u ON a.created_by = u.id
    `).all();
    res.json(rows.map(row => ({
      ...row,
      tags: row.tags ? row.tags.split(',') : [],
      feelings: [],
      dist: '0.5 km away',
      userAdded: !!row.created_by
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/artworks/:id', optionalAuth, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT a.*, u.name as added_by_user_name
      FROM artworks a LEFT JOIN users u ON a.created_by = u.id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Artwork not found' });

    const currentUserId = req.user?.id;
    let feelings;
    if (currentUserId) {
      feelings = db.prepare(`
        SELECT f.*, u.name as user_name FROM feelings f
        LEFT JOIN users u ON f.user_id = u.id
        WHERE f.artwork_id = ? AND (f.is_public = 1 OR f.user_id = ?)
      `).all(req.params.id, currentUserId);
    } else {
      feelings = db.prepare(`
        SELECT f.*, u.name as user_name FROM feelings f
        LEFT JOIN users u ON f.user_id = u.id
        WHERE f.artwork_id = ? AND f.is_public = 1
      `).all(req.params.id);
    }
    res.json({ ...row, tags: row.tags ? row.tags.split(',') : [], feelings, dist: '0.5 km away', userAdded: !!row.created_by });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/artworks', authenticateToken, (req, res) => {
  try {
    const { title, sub, location, artist, year, type, avatarInitial, desc, tags, browseCategory, browseLocation, color1, color2, lat, lng } = req.body;
    const result = db.prepare(`
      INSERT INTO artworks (title, sub, location, artist, year, type, avatarInitial, desc, tags, browseCategory, browseLocation, color1, color2, lat, lng, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, sub, location, artist, year, type, avatarInitial, desc, tags ? tags.join(',') : '', browseCategory, browseLocation, color1, color2, lat, lng, req.user.id);
    res.json({ id: result.lastInsertRowid, ...req.body });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/artworks/:id', authenticateToken, (req, res) => {
  try {
    const row = db.prepare('SELECT created_by FROM artworks WHERE id = ?').get(req.params.id);
    if (!row) return res.sendStatus(404);
    if (row.created_by !== req.user.id) return res.sendStatus(403);
    db.prepare('DELETE FROM artworks WHERE id = ?').run(req.params.id);
    res.json({ message: 'Artwork deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').run(name, email, hashedPassword);
    const token = jwt.sign({ id: result.lastInsertRowid, name, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: result.lastInsertRowid, name, email } });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/me', authenticateToken, (req, res) => {
  res.json(req.user);
});

// ── Saved artworks ───────────────────────────────────────────────────────────

app.get('/api/user/saved', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.* FROM artworks a
      INNER JOIN saved_artworks s ON a.id = s.artwork_id
      WHERE s.user_id = ?
    `).all(req.user.id);
    res.json(rows.map(row => ({ ...row, tags: row.tags ? row.tags.split(',') : [] })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/saved/:id', authenticateToken, (req, res) => {
  try {
    db.prepare('INSERT OR IGNORE INTO saved_artworks (user_id, artwork_id) VALUES (?, ?)').run(req.user.id, req.params.id);
    db.prepare('UPDATE artworks SET saved = saved + 1 WHERE id = ?').run(req.params.id);
    res.json({ message: 'Saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/user/saved/:id', authenticateToken, (req, res) => {
  try {
    db.prepare('DELETE FROM saved_artworks WHERE user_id = ? AND artwork_id = ?').run(req.user.id, req.params.id);
    db.prepare('UPDATE artworks SET saved = MAX(0, saved - 1) WHERE id = ?').run(req.params.id);
    res.json({ message: 'Removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Feelings ─────────────────────────────────────────────────────────────────

app.get('/api/artworks/:id/feelings', optionalAuth, (req, res) => {
  try {
    const currentUserId = req.user?.id;
    let feelings;
    if (currentUserId) {
      feelings = db.prepare(`
        SELECT f.*, u.name as user_name FROM feelings f
        LEFT JOIN users u ON f.user_id = u.id
        WHERE f.artwork_id = ? AND (f.is_public = 1 OR f.user_id = ?)
      `).all(req.params.id, currentUserId);
    } else {
      feelings = db.prepare(`
        SELECT f.*, u.name as user_name FROM feelings f
        LEFT JOIN users u ON f.user_id = u.id
        WHERE f.artwork_id = ? AND f.is_public = 1
      `).all(req.params.id);
    }
    res.json(feelings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/artworks/:id/feelings', authenticateToken, (req, res) => {
  try {
    const { feeling, note, is_public, extra_emojis } = req.body;
    const result = db.prepare(`
      INSERT INTO feelings (artwork_id, user_id, feeling, note, is_public, extra_emojis)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.params.id, req.user.id, feeling, note, is_public ? 1 : 0, extra_emojis ? extra_emojis.join(',') : '');
    db.prepare('UPDATE artworks SET visitors = visitors + 1 WHERE id = ?').run(req.params.id);
    res.json({ id: result.lastInsertRowid, ...req.body });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/feelings/:id', authenticateToken, (req, res) => {
  try {
    const row = db.prepare('SELECT user_id FROM feelings WHERE id = ?').get(req.params.id);
    if (!row) return res.sendStatus(404);
    if (row.user_id !== req.user.id) return res.sendStatus(403);
    db.prepare('DELETE FROM feelings WHERE id = ?').run(req.params.id);
    res.json({ message: 'Feeling deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/feelings', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT f.*, a.title as artwork_title, a.artist as artwork_artist
      FROM feelings f INNER JOIN artworks a ON f.artwork_id = a.id
      WHERE f.user_id = ? ORDER BY f.created_at DESC
    `).all(req.user.id);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Walks ────────────────────────────────────────────────────────────────────

app.get('/api/walks', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT w.*, u.name as user_name, COUNT(ws.id) as stop_count
      FROM walks w INNER JOIN users u ON w.user_id = u.id
      LEFT JOIN walk_stops ws ON w.id = ws.walk_id
      WHERE w.is_public = 1 GROUP BY w.id
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/walks', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT w.*, COUNT(ws.id) as stop_count
      FROM walks w LEFT JOIN walk_stops ws ON w.id = ws.walk_id
      WHERE w.user_id = ? GROUP BY w.id
    `).all(req.user.id);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/walks', authenticateToken, (req, res) => {
  try {
    const { name, description, is_public, stops } = req.body;
    const result = db.prepare('INSERT INTO walks (user_id, name, description, is_public) VALUES (?, ?, ?, ?)').run(req.user.id, name, description, is_public ? 1 : 0);
    const walkId = result.lastInsertRowid;
    if (stops && stops.length > 0) {
      const insertStop = db.prepare('INSERT INTO walk_stops (walk_id, artwork_id, stop_order) VALUES (?, ?, ?)');
      const insertAll = db.transaction((stops) => {
        stops.forEach((artworkId, index) => insertStop.run(walkId, artworkId, index));
      });
      insertAll(stops);
    }
    res.json({ id: walkId, ...req.body });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/walks/:id', (req, res) => {
  try {
    const walk = db.prepare('SELECT * FROM walks WHERE id = ?').get(req.params.id);
    if (!walk) return res.status(404).json({ error: 'Walk not found' });
    const stops = db.prepare(`
      SELECT a.*, ws.stop_order FROM walk_stops ws
      INNER JOIN artworks a ON ws.artwork_id = a.id
      WHERE ws.walk_id = ? ORDER BY ws.stop_order
    `).all(req.params.id);
    res.json({ ...walk, stops: stops.map(s => ({ ...s, tags: s.tags ? s.tags.split(',') : [] })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

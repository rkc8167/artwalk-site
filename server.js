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

// Matches origins like http://192.168.1.42:3000, http://10.0.0.5:3000, or
// http://172.16-31.x.x:3000 — i.e. any device on the same private LAN
// hitting this server by IP instead of localhost, which is the normal way
// to test on a phone/another computer during development.
const LAN_ORIGIN_PATTERN = /^http:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}):\d+$/;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || LAN_ORIGIN_PATTERN.test(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(bodyParser.json({ limit: '10mb' }));
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

  CREATE TABLE IF NOT EXISTS location_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_term TEXT NOT NULL,
    display_name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    note TEXT,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
`);

// ── Seed ────────────────────────────────────────────────────────────────────
// SEED_VERSION bumps whenever the artwork dataset changes. When the stored
// version doesn't match, we replace only the original seeded artworks
// (created_by IS NULL) — user-added artworks, accounts, saves and feelings
// logged against still-existing artwork ids are left untouched.
const SEED_VERSION = 2;

db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
const seedMeta = db.prepare('SELECT value FROM meta WHERE key = ?').get('seed_version');
const currentSeedVersion = seedMeta ? parseInt(seedMeta.value, 10) : 0;

if (currentSeedVersion < SEED_VERSION) {
  // Delete rows that reference the old seeded artworks first (foreign key
  // safety), then the artworks themselves. User-added artworks
  // (created_by NOT NULL) and everything tied to them are left untouched.
  const oldSeededIds = db.prepare('SELECT id FROM artworks WHERE created_by IS NULL').all().map(r => r.id);
  if (oldSeededIds.length > 0) {
    const placeholders = oldSeededIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM saved_artworks WHERE artwork_id IN (${placeholders})`).run(...oldSeededIds);
    db.prepare(`DELETE FROM feelings WHERE artwork_id IN (${placeholders})`).run(...oldSeededIds);
    db.prepare(`DELETE FROM walk_stops WHERE artwork_id IN (${placeholders})`).run(...oldSeededIds);
  }
  db.prepare('DELETE FROM artworks WHERE created_by IS NULL').run();

  const insert = db.prepare(`
    INSERT INTO artworks (title, sub, location, artist, year, type, avatarInitial, desc, visitors, saved, inspired, tags, browseCategory, browseLocation, color1, color2, userPhoto, lat, lng)
    VALUES (@title, @sub, @location, @artist, @year, @type, @avatarInitial, @desc, @visitors, @saved, @inspired, @tags, @browseCategory, @browseLocation, @color1, @color2, @userPhoto, @lat, @lng)
  `);
  const seedMany = db.transaction((artworks) => {
    for (const a of artworks) insert.run(a);
  });
  seedMany([
    { title: "Sculpture 1 - General", sub: "Cheung Yee · Hong Kong Cultural Centre Piazza", location: "Hong Kong Cultural Centre Piazza", artist: "Cheung Yee", year: "1984", type: "Sculpture", avatarInitial: "C", desc: "Also known as Crab General No. 1, this bronze sculpture is part of Cheung Yee\'s celebrated crab series, the breakthrough body of work that defined his mature style. Cheung, a founding member of the avant-garde Circle Art Group and a pioneer of modern Hong Kong sculpture, spent five years experimenting before completing this piece, fusing the geometric abstraction of Western modernism with motifs drawn from oracle bone carvings and ancient Chinese totemic art. The strutting, long-limbed bronze form has been compared to both Louise Bourgeois\'s spider sculptures and the mechanical creatures of Japanese animation, and is held in the permanent collection of the Hong Kong Museum of Art.\n\nHong Kong Museum of Art Collection", visitors: 100, saved: 20, inspired: "45%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Hong Kong Cultural Centre Piazza", color1: "#6b6560", color2: "#3a3028", userPhoto: "artwalk_assets/Sculpture_1_General.jpg", lat: 22.2935, lng: 114.1716 },
    { title: "Universal Union", sub: "Leung Kui-ting · Hong Kong Cultural Centre Piazza", location: "Hong Kong Cultural Centre Piazza", artist: "Leung Kui-ting", year: "1991", type: "Sculpture", avatarInitial: "L", desc: "Leung Kui-ting, one of Hong Kong\'s most significant postwar artists and a student of ink painting master Lui Shou-kwan, created this sculpture during a prolific period of formal experimentation that bridged Chinese ink traditions with Western geometric design. Trained in both painting and graphic design, Leung brought a designer\'s eye for clean structural form to his sculptural work, translating the same interest in rocks, voids and balanced composition found in his celebrated ink landscapes into three-dimensional public art. The piece sits within the cultural heart of Tsim Sha Tsui, in dialogue with the harbour views and the architecture of the Cultural Centre itself.\n\nHong Kong Museum of Art Collection", visitors: 123, saved: 27, inspired: "48%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Hong Kong Cultural Centre Piazza", color1: "#8a9878", color2: "#3d5030", userPhoto: "artwalk_assets/Universal_Union.jpg", lat: 22.2933, lng: 114.1714 },
    { title: "Clip", sub: "Lai Yat-fong · Hong Kong Cultural Centre Piazza", location: "Hong Kong Cultural Centre Piazza", artist: "Lai Yat-fong", year: "1991", type: "Sculpture", avatarInitial: "L", desc: "Installed in 1991 alongside other major public commissions at the Hong Kong Cultural Centre Piazza, this sculpture by Lai Yat-fong forms part of a cluster of works that established the Piazza as one of Hong Kong\'s earliest and most enduring open-air sculpture gardens. The piece\'s title suggests a study in tension and connection, themes common in Hong Kong sculpture of this era as artists explored abstraction following the territory\'s growing engagement with international modernist movements.", visitors: 146, saved: 34, inspired: "51%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Hong Kong Cultural Centre Piazza", color1: "#b0a898", color2: "#706858", userPhoto: "artwalk_assets/Clip.jpg", lat: 22.2937, lng: 114.1718 },
    { title: "The Flying Frenchman", sub: "César Baldaccini · Tsim Sha Tsui Promenade", location: "Tsim Sha Tsui Promenade", artist: "César Baldaccini", year: "1991", type: "Sculpture", avatarInitial: "C", desc: "Created by the renowned French sculptor César Baldaccini and donated to Hong Kong by the Cartier Foundation in 1992, this monumental bronze sculpture was originally titled The Freedom Fighter. Standing nearly five metres tall and stretching seven metres long, the piece depicts a winged, gun-wielding figure cast in César\'s signature compressed, fragmented bronze style. Its original title was changed under government pressure at the time, as the work was widely interpreted as a response to the 1989 Tiananmen Square protests; César, reportedly offended by the renaming, refused to attend the unveiling. It remains one of the most striking and talked-about pieces of public art on the Tsim Sha Tsui waterfront, and was the artist\'s final public commission before his death in 1998.\n\nDonated by the Cartier Foundation", visitors: 169, saved: 41, inspired: "54%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Tsim Sha Tsui Promenade", color1: "#7888a0", color2: "#344058", userPhoto: "artwalk_assets/The_Flying_Frenchman.jpg", lat: 22.2931, lng: 114.171 },
    { title: "Statue of McDull", sub: "Alice Mak, Brian Tse · Victoria Dockside", location: "Victoria Dockside", artist: "Alice Mak, Brian Tse", year: "2011", type: "Sculpture", avatarInitial: "A", desc: "McDull, the beloved pink piglet created by Alice Mak and Brian Tse, has been one of Hong Kong\'s most enduring cultural icons since his debut in the late 1990s, starring in animated films and a long-running comic strip that affectionately captures the optimism and resilience of everyday Hong Kong life. This sculpture brings the character into three-dimensional public space at Victoria Dockside, letting visitors interact directly with a figure who has come to symbolize a distinctly local blend of humour, nostalgia and heart.", visitors: 192, saved: 48, inspired: "57%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Victoria Dockside", color1: "#98a888", color2: "#485838", userPhoto: "artwalk_assets/Statue_of_McDull.jpg", lat: 22.2945, lng: 114.1749 },
    { title: "Daughter of Hong Kong - Anita Mui", sub: "Professor Cao Chong-En · Victoria Dockside", location: "Victoria Dockside", artist: "Professor Cao Chong-En", year: "2014", type: "Sculpture", avatarInitial: "P", desc: "This bronze statue honours Anita Mui, the iconic Cantopop singer and actress often called the \'Madonna of Asia,\' whose powerful voice and trailblazing stage presence defined an era of Hong Kong entertainment before her death in 2003. Created by Professor Cao Chong-En and funded through public donation by fans and admirers, the statue captures Mui mid-performance, commemorating her enduring legacy as a cultural icon whose influence on Cantopop and Hong Kong cinema remains deeply felt.\n\nDonated by Friends of Anita Mui, Anita Mui True Heart Charity Foundation, Mui Nation Committee and members", visitors: 215, saved: 55, inspired: "60%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Victoria Dockside", color1: "#787068", color2: "#383028", userPhoto: "artwalk_assets/Daughter_of_Hong_Kong_Anita_Mui.jpg", lat: 22.2943, lng: 114.1751 },
    { title: "Hong Kong Film Awards Star of the Century - Bruce Lee", sub: "Professor Cao Chong-En · Victoria Dockside", location: "Victoria Dockside", artist: "Professor Cao Chong-En", year: "2005", type: "Sculpture", avatarInitial: "P", desc: "This bronze statue immortalizes Bruce Lee, the martial artist and actor who brought Hong Kong action cinema to a global audience and remains one of the city\'s most recognized cultural exports. Sculpted by Professor Cao Chong-En and funded by the Bruce Lee Club, the statue captures Lee in a dynamic fighting stance, embodying the discipline, speed and philosophy that defined both his on-screen legend and his real-life approach to martial arts. It stands as a tribute to Lee\'s role in shaping how the world sees Hong Kong cinema.\n\nDonated by Bruce Lee Club", visitors: 238, saved: 62, inspired: "63%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Victoria Dockside", color1: "#c8c4bc", color2: "#808078", userPhoto: "artwalk_assets/Hong_Kong_Film_Awards_Star_of_the_Century_Bruce_Lee.jpg", lat: 22.2941, lng: 114.1753 },
    { title: "The Gates of Youth", sub: "Aries Lee · Kowloon Park", location: "Kowloon Park", artist: "Aries Lee", year: "", type: "Sculpture", avatarInitial: "A", desc: "Set within the green expanse of Kowloon Park, this sculpture by Aries Lee forms part of the park\'s outdoor sculpture walk, a collection of contemporary Hong Kong public art installed amid the park\'s gardens, aviary and historic colonial-era architecture. The work\'s title evokes themes of passage and transition, fitting for a park that has long served as a gathering and crossing point for generations of Hong Kong residents in the heart of Tsim Sha Tsui.", visitors: 261, saved: 69, inspired: "66%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Kowloon Park", color1: "#707070", color2: "#303030", userPhoto: "artwalk_assets/The_Gates_of_Youth.jpg", lat: 22.3018, lng: 114.1697 },
    { title: "Shoots", sub: "Tong King-Sum · Kowloon Park", location: "Kowloon Park", artist: "Tong King-Sum", year: "", type: "Sculpture", avatarInitial: "T", desc: "Tong King-Sum is a respected Hong Kong sculptor known for his work in wood carving, and a mentor to a generation of local artists working in contemporary sculpture. This piece, sited within Kowloon Park\'s outdoor sculpture collection, takes its title and form from the imagery of new growth, organic shapes that echo plant shoots breaking through soil, set against the surrounding tropical landscaping of the park.", visitors: 284, saved: 76, inspired: "69%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Kowloon Park", color1: "#c09050", color2: "#804010", userPhoto: "artwalk_assets/Shoots.jpg", lat: 22.301, lng: 114.1701 },
    { title: "Ultimate Union", sub: "Leung Kui-ting · Kowloon Park", location: "Kowloon Park", artist: "Leung Kui-ting", year: "", type: "Sculpture", avatarInitial: "L", desc: "A second major public work by Leung Kui-ting featured in this collection, Ultimate Union continues the artist\'s exploration of geometric form and balance that runs through both his ink paintings and sculptural practice. Installed within Kowloon Park, the piece reflects Leung\'s broader artistic project: bridging classical Chinese aesthetic philosophy with the abstraction and structural clarity of Western modern art, themes that earned him recognition as one of Hong Kong\'s Ten Outstanding Young Persons and a recipient of the Urban Council Sculpture Design Award.", visitors: 307, saved: 83, inspired: "72%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Kowloon Park", color1: "#c860a0", color2: "#882070", userPhoto: "artwalk_assets/Ultimate_Union.jpg", lat: 22.3016, lng: 114.1703 },
    { title: "Figure", sub: "To Shui-Ming · Kowloon Park", location: "Kowloon Park", artist: "To Shui-Ming", year: "", type: "Sculpture", avatarInitial: "T", desc: "Held in the permanent collection of the Hong Kong Museum of Art and donated by New World Development Company, this figurative sculpture by To Shui-Ming explores the human form through abstraction, a recurring theme in Hong Kong sculpture of the late twentieth century as local artists sought new ways to depict the body outside of strictly representational traditions. Sited among the trees and walkways of Kowloon Park, the work invites quiet, close viewing away from the bustle of the surrounding city.\n\nHong Kong Museum of Art Collection; Donated by New World Development Company Ltd.", visitors: 330, saved: 90, inspired: "75%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Kowloon Park", color1: "#c87030", color2: "#782808", userPhoto: "artwalk_assets/Figure.jpg", lat: 22.3012, lng: 114.1695 },
    { title: "九龍之子 (Son of Kowloon)", sub: "POLO · Elements, West Kowloon", location: "Elements, West Kowloon", artist: "POLO", year: "2007", type: "Sculpture", avatarInitial: "P", desc: "Commissioned as part of the MTR Corporation\'s development of Elements mall above Kowloon Station, this sculpture by the artist known as POLO takes its name, Son of Kowloon, from the area\'s Chinese name, which translates to \'Nine Dragons.\' The piece reflects the cultural identity of West Kowloon as a rapidly modernizing district built atop reclaimed land, blending contemporary sculptural form with a sense of place rooted in the area\'s mythological namesake.\n\nMTR Corporation Development", visitors: 353, saved: 97, inspired: "78%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Elements, West Kowloon", color1: "#8896a8", color2: "#3c4858", userPhoto: "artwalk_assets/Son_of_Kowloon.jpg", lat: 22.3045, lng: 114.1614 },
    { title: "Balloon Swan", sub: "Jeff Koons · The Henderson", location: "The Henderson", artist: "Jeff Koons", year: "", type: "Sculpture", avatarInitial: "J", desc: "Jeff Koons is among the most recognized and commercially significant contemporary artists working today, celebrated for his Balloon series of mirror-polished stainless steel sculptures that mimic the appearance of inflated party balloons twisted into animal shapes. Balloon Swan, in Koons\'s signature high-chromatic palette, brings his exploration of kitsch, nostalgia and consumer culture into the lobby of The Henderson, the Zaha Hadid-designed skyscraper in Central that has assembled a notable collection of contemporary art and sculpture throughout its public spaces.\n\nHenderson Land Collection", visitors: 376, saved: 104, inspired: "81%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "The Henderson", color1: "#a89878", color2: "#584830", userPhoto: "artwalk_assets/Balloon_Swan.jpg", lat: 22.2793, lng: 114.1601 },
    { title: "Oval with Points", sub: "Henry Moore · One and Two Exchange Square", location: "One and Two Exchange Square", artist: "Henry Moore", year: "1968", type: "Sculpture", avatarInitial: "H", desc: "Henry Moore, one of the twentieth century\'s most influential sculptors, was renowned for his abstracted, biomorphic bronze forms that explore mass, void and the human figure in dialogue with landscape. Oval with Points, cast in 1968, is one of several Moore bronzes held in Hong Kong\'s corporate art collections, its smooth, pierced oval form characteristic of Moore\'s lifelong fascination with negative space, the idea that the hole through a sculpture can be as expressive as the solid form around it. The piece sits at Exchange Square, part of the Hongkong Land Collection\'s long-running commitment to placing significant international sculpture within the city\'s financial district.\n\nHong Kong Land Collection", visitors: 399, saved: 111, inspired: "84%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "One and Two Exchange Square", color1: "#90a0b0", color2: "#384858", userPhoto: "artwalk_assets/Oval_with_Points.jpg", lat: 22.2826, lng: 114.1582 },
    { title: "High Hat Man and High Hat Woman", sub: "Lynn Chadwick · Landmark Alexandra", location: "Landmark Alexandra", artist: "Lynn Chadwick", year: "1968", type: "Sculpture", avatarInitial: "L", desc: "Lynn Chadwick was a leading figure of postwar British sculpture, known for his angular, faceted bronze figures that married Cubist-influenced geometry with a haunting, totemic presence. High Hat Man and High Hat Woman depicts two elongated figures, their wide-brimmed hats a recurring motif in Chadwick\'s work from this period, rendered in his signature welded and faceted bronze technique. The pairing creates a striking sense of dialogue and tension within the formal courtyard setting of Landmark Alexandra in Central.\n\nHong Kong Land Collection", visitors: 422, saved: 118, inspired: "87%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Landmark Alexandra", color1: "#b89878", color2: "#684830", userPhoto: "artwalk_assets/High_Hat_Man_and_High_Hat_Woman.jpg", lat: 22.2815, lng: 114.1576 },
    { title: "Double Oval", sub: "Henry Moore · Jardine House", location: "Jardine House", artist: "Henry Moore", year: "1968", type: "Sculpture", avatarInitial: "H", desc: "A companion piece in spirit to Moore\'s Oval with Points elsewhere in Hong Kong Land\'s collection, Double Oval continues the artist\'s investigation of paired, interlocking abstract forms. Two smooth bronze ovals, pierced and balanced against one another, sit at the base of Jardine House, one of Hong Kong\'s most recognizable office towers, instantly identifiable by its round porthole windows. The sculpture\'s quiet, organic curves offer a deliberate visual counterpoint to the building\'s geometric, repetitive facade.\n\nHong Kong Land Collection", visitors: 445, saved: 125, inspired: "90%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Jardine House", color1: "#9098a0", color2: "#404850", userPhoto: "artwalk_assets/Double_Oval.jpg", lat: 22.2862, lng: 114.1583 },
    { title: "Tai Chi", sub: "Ju Ming · Bank of China", location: "Bank of China", artist: "Ju Ming", year: "", type: "Sculpture", avatarInitial: "J", desc: "Ju Ming is one of Taiwan\'s most celebrated sculptors, internationally known for his Taichi Series, a body of work begun in the 1980s that distills the slow, balanced movements of taichi practice into bold, simplified bronze forms. Rejecting fine surface detail in favour of broad planes and powerful silhouettes, Ju\'s figures capture the meditative discipline of the martial art while engaging directly with the monumental scale of the architecture around them. This piece sits appropriately at the foot of the Bank of China Tower, one of Hong Kong\'s most dramatic pieces of modern architecture, designed by I. M. Pei.\n\nBank of China Collection", visitors: 468, saved: 132, inspired: "93%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Bank of China", color1: "#c0a060", color2: "#785818", userPhoto: "artwalk_assets/Tai_Chi.jpg", lat: 22.2796, lng: 114.1614 },
    { title: "Parade", sub: "Julian Opie · Pacific Place", location: "Pacific Place", artist: "Julian Opie", year: "2020", type: "Mural", avatarInitial: "J", desc: "Julian Opie is a British contemporary artist celebrated for his distinctive style of radical simplification, reducing the human figure to bold outlines, flat colour and minimal detail, a visual language popularized internationally through his album cover artwork for Blur. Parade, installed at Pacific Place in 2020, brings Opie\'s signature walking figures to life as a continuous animated or sequential mural, capturing the constant motion and rhythm of pedestrian life in one of Hong Kong\'s busiest shopping and business districts.\n\nSwire Properties Collection", visitors: 491, saved: 139, inspired: "46%", tags: "Mural,Public Art,Hong Kong", browseCategory: "Mural", browseLocation: "Pacific Place", color1: "#a07890", color2: "#582848", userPhoto: "artwalk_assets/Parade.jpg", lat: 22.2775, lng: 114.1655 },
    { title: "Kissing Bench", sub: "Alison Crowther · Pacific Place", location: "Pacific Place", artist: "Alison Crowther", year: "2006", type: "Sculpture", avatarInitial: "A", desc: "British sculptor Alison Crowther is known for carving large-scale, tactile works directly into stone and wood, often centred on the human body and themes of intimacy, rest and connection. Kissing Bench, installed at Pacific Place in 2006, combines functional public seating with figurative sculpture, an inviting, interactive piece that softens the corporate scale of its surroundings and gives passersby a literal place to pause within the development.\n\nSwire Properties Collection", visitors: 514, saved: 146, inspired: "49%", tags: "Sculpture,Public Art,Hong Kong", browseCategory: "Sculpture", browseLocation: "Pacific Place", color1: "#80a090", color2: "#385840", userPhoto: "artwalk_assets/Kissing_Bench.jpg", lat: 22.2778, lng: 114.1658 }
  ]);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('seed_version', String(SEED_VERSION));
  console.log(`Database (re)seeded with artwork dataset v${SEED_VERSION}`);
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

// ── Geocoding proxy ──────────────────────────────────────────────────────────
// Proxies search requests to OpenStreetMap's Nominatim service. Nominatim's
// usage policy requires a descriptive User-Agent identifying the calling
// application, which browsers don't allow JS to set — so this runs
// server-side instead, where we control the header properly.
app.get('/api/reverse-geocode', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Missing lat/lng' });
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lng}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ArtWalk-HK/1.0 (artwalk.site; contact via app)',
        'Accept-Language': 'en'
      }
    });
    if (!response.ok) return res.status(502).json({ error: 'Nominatim error' });
    const data = await response.json();
    const addr = data.address || {};
    const country = (addr.country_code || '').toLowerCase();

    // For countries where the well-known city IS the state/province
    // (Chinese direct-controlled municipalities: Shanghai, Beijing, Tianjin, Chongqing;
    //  Japanese metropolis: Tokyo, Osaka-fu, Kyoto-fu — addr.state holds the common name)
    // we prefer addr.state over addr.city, which Nominatim fills with a district.
    const stateLevelCityCountries = ['cn', 'jp', 'sg', 'hk', 'mo'];
    let city = '';
    if (stateLevelCityCountries.includes(country)) {
      // Use state (e.g. "Shanghai", "Tokyo") — strip trailing suffixes like " Municipality"
      const raw = addr.state || addr.city || addr.town || addr.municipality || '';
      city = raw.replace(/\s*(Municipality|Metropolis|Prefecture|Special Administrative Region|SAR)$/i, '').trim();
    } else {
      // For most countries addr.city is the right level
      city = addr.city || addr.town || addr.village || addr.municipality || addr.state_district || addr.state || '';
      // New York City → New York
      city = city.replace(/\s*City$/i, '').trim();
    }
    res.json({ city, address: addr });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/geocode', async (req, res) => {
  const query = (req.query.q || '').toString().trim();
  if (!query) return res.status(400).json({ error: 'Missing query parameter q' });
  try {
    // Check our own corrections first — these cover places where OpenStreetMap's
    // data is stale or missing (e.g. a building that has since moved or been
    // renamed). Matching is a simple case-insensitive substring check in
    // either direction so "NYU Shanghai" matches a correction saved under
    // "nyu shanghai" or "shanghai nyu", etc.
    const corrections = db.prepare('SELECT * FROM location_corrections').all();
    const qLower = query.toLowerCase();
    const matchedCorrections = corrections.filter(c => {
      const termLower = c.search_term.toLowerCase();
      return qLower.includes(termLower) || termLower.includes(qLower);
    });

    const correctionResults = matchedCorrections.map(c => ({
      display_name: c.display_name,
      lat: String(c.lat),
      lon: String(c.lng),
      is_correction: true
    }));

    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&q=${encodeURIComponent(query)}&viewbox=113.8,22.55,114.45,22.15&bounded=0`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ArtWalk-HK/1.0 (artwalk.site; contact via app)' }
    });
    let osmResults = [];
    if (response.ok) {
      osmResults = await response.json();
    }

    // Corrections appear first so they take priority over potentially stale OSM data
    res.json([...correctionResults, ...osmResults]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Location corrections ─────────────────────────────────────────────────────
// Lets a user save a known-good address/coordinate pair under a search term,
// so future searches for that term offer the corrected location even when
// OpenStreetMap's indexed data is outdated or missing it entirely.
app.post('/api/location-corrections', authenticateToken, (req, res) => {
  try {
    const { search_term, display_name, lat, lng, note } = req.body;
    if (!search_term || !display_name || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'search_term, display_name, lat and lng are required' });
    }
    const result = db.prepare(`
      INSERT INTO location_corrections (search_term, display_name, lat, lng, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(search_term, display_name, lat, lng, note || null, req.user.id);
    res.json({ id: result.lastInsertRowid, search_term, display_name, lat, lng, note });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/location-corrections', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM location_corrections ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/location-corrections/:id', authenticateToken, (req, res) => {
  try {
    const row = db.prepare('SELECT created_by FROM location_corrections WHERE id = ?').get(req.params.id);
    if (!row) return res.sendStatus(404);
    if (Number(row.created_by) !== Number(req.user.id)) return res.sendStatus(403);
    db.prepare('DELETE FROM location_corrections WHERE id = ?').run(req.params.id);
    res.json({ message: 'Correction removed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/artworks', optionalAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.*, u.name as added_by_user_name
      FROM artworks a LEFT JOIN users u ON a.created_by = u.id
    `).all();

    const currentUserId = req.user?.id;
    const allFeelings = currentUserId
      ? db.prepare(`
          SELECT f.*, u.name as user_name FROM feelings f
          LEFT JOIN users u ON f.user_id = u.id
          WHERE f.is_public = 1 OR f.user_id = ?
          ORDER BY f.created_at ASC
        `).all(currentUserId)
      : db.prepare(`
          SELECT f.*, u.name as user_name FROM feelings f
          LEFT JOIN users u ON f.user_id = u.id
          WHERE f.is_public = 1
          ORDER BY f.created_at ASC
        `).all();

    const feelingsByArtwork = {};
    for (const f of allFeelings) {
      (feelingsByArtwork[f.artwork_id] = feelingsByArtwork[f.artwork_id] || []).push(f);
    }

    res.json(rows.map(row => ({
      ...row,
      tags: row.tags ? row.tags.split(',') : [],
      feelings: feelingsByArtwork[row.id] || [],
      dist: '0.5 km away',
      created_by: row.created_by != null ? Number(row.created_by) : null,
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
    const { title, sub, location, artist, year, type, avatarInitial, desc, tags, browseCategory, browseLocation, color1, color2, userPhoto, lat, lng } = req.body;
    if (!title || !location || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'title, location, lat and lng are required' });
    }
    const result = db.prepare(`
      INSERT INTO artworks (title, sub, location, artist, year, type, avatarInitial, desc, tags, browseCategory, browseLocation, color1, color2, userPhoto, lat, lng, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, sub, location, artist, year, type, avatarInitial, desc, tags ? tags.join(',') : '', browseCategory, browseLocation, color1, color2, userPhoto || null, lat, lng, req.user.id);
    res.json({ id: Number(result.lastInsertRowid), ...req.body, userAdded: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/artworks/:id', authenticateToken, (req, res) => {
  try {
    const row = db.prepare('SELECT created_by FROM artworks WHERE id = ?').get(req.params.id);
    if (!row) return res.sendStatus(404);
    if (Number(row.created_by) !== Number(req.user.id)) return res.sendStatus(403);
    
    // Delete dependent rows first to prevent foreign key constraint failures
    db.prepare('DELETE FROM saved_artworks WHERE artwork_id = ?').run(req.params.id);
    db.prepare('DELETE FROM feelings WHERE artwork_id = ?').run(req.params.id);
    db.prepare('DELETE FROM walk_stops WHERE artwork_id = ?').run(req.params.id);
    
    db.prepare('DELETE FROM artworks WHERE id = ?').run(req.params.id);
    res.json({ message: 'Artwork deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin ─────────────────────────────────────────────────────────────────────
// Protected by JWT_SECRET used as a bearer token — only accessible to someone
// with server config access. Used for data repair and cleanup operations.
const adminAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token || token !== JWT_SECRET) return res.sendStatus(403);
  next();
};

// DELETE all user-added artworks (created_by IS NOT NULL)
app.delete('/api/admin/user-artworks', adminAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, title FROM artworks WHERE created_by IS NOT NULL').all();
    if (rows.length === 0) return res.json({ deleted: 0, artworks: [] });
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM saved_artworks WHERE artwork_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM feelings WHERE artwork_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM artworks WHERE id IN (${placeholders})`).run(...ids);
    res.json({ deleted: ids.length, artworks: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET list of all users and their artworks (for inspection)
app.get('/api/admin/users', adminAuth, (req, res) => {
  try {
    const users = db.prepare('SELECT id, name, email FROM users ORDER BY id').all();
    const artworks = db.prepare('SELECT id, title, created_by FROM artworks WHERE created_by IS NOT NULL ORDER BY id').all();
    res.json({ users, artworks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH fix created_by for a specific artwork by email
app.patch('/api/admin/fix-artwork-owner', adminAuth, (req, res) => {
  try {
    const { artwork_id, email } = req.body;
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare('UPDATE artworks SET created_by = ? WHERE id = ?').run(user.id, artwork_id);
    res.json({ updated: true, artwork_id, user_id: user.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/artworks/:id', authenticateToken, (req, res) => {
  try {
    const row = db.prepare('SELECT created_by FROM artworks WHERE id = ?').get(req.params.id);
    if (!row) return res.sendStatus(404);
    if (Number(row.created_by) !== Number(req.user.id)) return res.sendStatus(403);

    const editable = ['title', 'artist', 'desc', 'type', 'browseCategory', 'location', 'browseLocation', 'lat', 'lng', 'year'];
    const updates = [];
    const values = [];
    for (const field of editable) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No editable fields provided' });

    // keep sub/tags in sync if the fields they're derived from changed
    if (req.body.artist !== undefined || req.body.location !== undefined) {
      const current = db.prepare('SELECT artist, location FROM artworks WHERE id = ?').get(req.params.id);
      const newArtist = req.body.artist !== undefined ? req.body.artist : current.artist;
      const newLocation = req.body.location !== undefined ? req.body.location : current.location;
      updates.push('sub = ?');
      values.push(`${newArtist} · ${newLocation}`);
    }

    values.push(req.params.id);
    db.prepare(`UPDATE artworks SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM artworks WHERE id = ?').get(req.params.id);
    res.json({ ...updated, tags: updated.tags ? updated.tags.split(',') : [], userAdded: !!updated.created_by });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').run(name, email, hashedPassword);
    const newUserId = Number(result.lastInsertRowid);
    const token = jwt.sign({ id: newUserId, name, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: newUserId, name, email } });
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

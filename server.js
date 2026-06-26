try { process.loadEnvFile(); } catch {} // load .env for local dev; Railway sets vars directly

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const path       = require('path');
const fs         = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');

const app    = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.use(express.json());

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────
const JWT_SECRET     = process.env.JWT_SECRET     || 'imposter-dev-secret-change-in-prod';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'imposter-admin';
const DB_DIR         = process.env.DB_DIR || __dirname;
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (DB_DIR === __dirname && process.env.RAILWAY_ENVIRONMENT) {
  console.warn('[WARN] DB_DIR is not set — database lives in the app directory, which is ephemeral on Railway. Add a volume and set the DB_DIR environment variable to its mount path.');
}

const db = new DatabaseSync(path.join(DB_DIR, 'imposter.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE COLLATE NOCASE,
    email         TEXT    UNIQUE COLLATE NOCASE,
    display_name  TEXT    NOT NULL COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    imposter_wins INTEGER NOT NULL DEFAULT 0,
    games_played  INTEGER NOT NULL DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS game_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    category        TEXT    NOT NULL,
    word            TEXT    NOT NULL,
    imposter_name   TEXT    NOT NULL,
    imposter_caught INTEGER NOT NULL,
    players_json    TEXT    NOT NULL,
    played_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migrate existing users table if it lacks the email / display_name columns
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('email')) {
    db.exec("CREATE TABLE users_new (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL COLLATE NOCASE, password_hash TEXT NOT NULL, imposter_wins INTEGER NOT NULL DEFAULT 0, games_played INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.exec("INSERT INTO users_new (id, username, display_name, password_hash, imposter_wins, games_played, created_at) SELECT id, username, username, password_hash, imposter_wins, games_played, created_at FROM users");
    db.exec("DROP TABLE users");
    db.exec("ALTER TABLE users_new RENAME TO users");
    console.log('[migration] users table upgraded: added email + display_name columns');
  }
}

const stmts = {
  registerUser:    db.prepare('INSERT INTO users (username, email, display_name, password_hash) VALUES (?, ?, ?, ?)'),
  findByIdentifier:db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)'),
  leaderboard:    db.prepare('SELECT display_name AS username, imposter_wins, games_played FROM users WHERE games_played > 0 ORDER BY imposter_wins DESC, CAST(imposter_wins AS REAL)/games_played DESC LIMIT 10'),
  addGame:        db.prepare('UPDATE users SET games_played = games_played + 1 WHERE id = ?'),
  addWin:         db.prepare('UPDATE users SET imposter_wins = imposter_wins + 1, games_played = games_played + 1 WHERE id = ?'),
  insertHistory:  db.prepare('INSERT INTO game_history (category, word, imposter_name, imposter_caught, players_json) VALUES (?, ?, ?, ?, ?)'),
  totalGames:     db.prepare('SELECT COUNT(*) as count FROM game_history'),
  todayGames:     db.prepare("SELECT COUNT(*) as count FROM game_history WHERE DATE(played_at) = DATE('now')"),
  recentGames:    db.prepare('SELECT id, category, word, imposter_name, imposter_caught, players_json, played_at FROM game_history ORDER BY id DESC LIMIT 8'),
  totalPlayers:   db.prepare('SELECT COUNT(*) as count FROM users'),
  categoryStats:  db.prepare('SELECT category, COUNT(*) as games FROM game_history GROUP BY category ORDER BY games DESC'),
  allLeaderboard: db.prepare('SELECT display_name AS username, imposter_wins, games_played, created_at FROM users ORDER BY imposter_wins DESC, CASE WHEN games_played > 0 THEN CAST(imposter_wins AS REAL)/games_played ELSE 0 END DESC'),
  recentHistory:  db.prepare('SELECT * FROM game_history ORDER BY played_at DESC LIMIT 100'),
  dailySignups:   db.prepare("SELECT DATE(created_at) as day, COUNT(*) as count FROM users WHERE created_at >= DATE('now', '-29 days') GROUP BY day ORDER BY day"),
  dailyGames:     db.prepare("SELECT DATE(played_at) as day, COUNT(*) as count FROM game_history WHERE played_at >= DATE('now', '-29 days') GROUP BY day ORDER BY day"),
  profileUser:    db.prepare('SELECT display_name AS username, imposter_wins, games_played FROM users WHERE LOWER(display_name) = LOWER(?)'),
  profileImpGames:db.prepare('SELECT COUNT(*) as count FROM game_history WHERE LOWER(imposter_name) = LOWER(?)'),
  profileImpWins: db.prepare('SELECT COUNT(*) as count FROM game_history WHERE LOWER(imposter_name) = LOWER(?) AND imposter_caught = 0'),
  profileBestSport:db.prepare('SELECT category, COUNT(*) as c FROM game_history WHERE players_json LIKE ? GROUP BY category ORDER BY c DESC LIMIT 1'),
  profileRecent:  db.prepare('SELECT id, category, word, imposter_name, imposter_caught, played_at FROM game_history WHERE players_json LIKE ? ORDER BY id DESC LIMIT 10'),
  findById:       db.prepare('SELECT * FROM users WHERE id = ?'),
};

function getLeaderboard() { return stmts.leaderboard.all(); }
function broadcastLeaderboard() { io.emit('leaderboardUpdate', getLeaderboard()); }

function getStats() {
  const topRow = stmts.categoryStats.get();
  return {
    totalPlayers: stmts.totalPlayers.get().count,
    gamesToday:   stmts.todayGames.get().count,
    topSport:     topRow ? topRow.category : null,
  };
}
function broadcastStats() { io.emit('statsUpdate', getStats()); }
function broadcastRecentGames() { io.emit('recentGames', stmts.recentGames.all()); }

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { identifier, password } = req.body || {};
  const id = String(identifier || '').trim();
  if (!id) return res.json({ error: 'Enter a username or email' });
  if (!password || password.length < 4) return res.json({ error: 'Password must be at least 4 characters' });

  const isEmail = id.includes('@');
  let username = null, email = null, displayName;

  if (isEmail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) return res.json({ error: 'Invalid email address' });
    email       = id.toLowerCase();
    displayName = id.split('@')[0].slice(0, 20);
    if (displayName.length < 2) return res.json({ error: 'Email prefix must be at least 2 characters' });
  } else {
    if (id.length < 2 || id.length > 20) return res.json({ error: 'Username must be 2–20 characters' });
    username    = id;
    displayName = id;
  }

  const hash = bcrypt.hashSync(password, 10);
  try {
    const { lastInsertRowid } = stmts.registerUser.run(username, email, displayName, hash);
    const token = jwt.sign({ userId: lastInsertRowid, username: displayName }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: displayName });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      if (e.message.includes('email'))        return res.json({ error: 'Email already registered' });
      if (e.message.includes('display_name')) return res.json({ error: `Name "${displayName}" is taken. Try adding numbers.` });
      return res.json({ error: 'Username already taken' });
    }
    res.json({ error: 'Server error' });
  }
});

app.post('/api/login', (req, res) => {
  const { identifier, password } = req.body || {};
  const id = String(identifier || '').trim();
  if (!id || !password) return res.json({ error: 'Fill in all fields' });
  const user = stmts.findByIdentifier.get(id, id);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.json({ error: 'Invalid username, email, or password' });
  const token = jwt.sign({ userId: user.id, username: user.display_name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.display_name });
});

app.get('/api/leaderboard',    (_req, res) => res.json(getLeaderboard()));
app.get('/api/stats',         (_req, res) => res.json(getStats()));
app.get('/api/recent-games',  (_req, res) => res.json(stmts.recentGames.all()));

app.get('/api/profile/:username', (req, res) => {
  const { username } = req.params;
  if (!username || username.length > 30) return res.status(400).json({ error: 'Invalid' });
  const user = stmts.profileUser.get(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const like          = `%"${user.username}"%`;
  const timesImposter = stmts.profileImpGames.get(username).count;
  const imposterWins  = stmts.profileImpWins.get(username).count;
  const timesKnower   = user.games_played - timesImposter;
  const knowerWins    = user.imposter_wins - imposterWins;
  const bestRow       = stmts.profileBestSport.get(like);
  const recentGames   = stmts.profileRecent.all(like);
  res.json({
    username:       user.username,
    games_played:   user.games_played,
    wins:           user.imposter_wins,
    losses:         user.games_played - user.imposter_wins,
    times_imposter: timesImposter,
    times_knower:   timesKnower,
    imposter_wins:  imposterWins,
    knower_wins:    knowerWins,
    best_sport:     bestRow ? bestRow.category : null,
    recent_games:   recentGames,
  });
});

app.get('/profile', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/login',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.get('/api/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user    = stmts.findById.get(decoded.userId);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    res.json({ username: user.display_name, games_played: user.games_played, imposter_wins: user.imposter_wins });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ── Admin routes ──────────────────────────────────────────────────────────────
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (!pw || pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/admin/data', requireAdmin, (_req, res) => {
  const activeGames = Object.entries(rooms).map(([roomId, room]) => ({
    roomId,
    category:       room.category,
    word:           room.word,
    players:        room.players.map(p => p.name),
    imposterIndex:  room.imposterIndex,
    startedAt:      room.startedAt,
    readyCount:     room.readyCount,
    votesIn:        Object.keys(room.votes).length,
  }));

  res.json({
    totalGames:    stmts.totalGames.get().count,
    totalPlayers:  stmts.totalPlayers.get().count,
    activeGames,
    categoryStats: stmts.categoryStats.all(),
    leaderboard:   stmts.allLeaderboard.all(),
    recentHistory: stmts.recentHistory.all(),
    dailySignups:  stmts.dailySignups.all(),
    dailyGames:    stmts.dailyGames.all(),
  });
});

// ── Game data ─────────────────────────────────────────────────────────────────
const CATEGORIES = {
  'NBA Players': [
    { name: 'LeBron James',             hint: 'Versatile'    },
    { name: 'Stephen Curry',            hint: 'Range'        },
    { name: 'Kevin Durant',             hint: 'Scorer'       },
    { name: 'Giannis Antetokounmpo',    hint: 'Greek'        },
    { name: 'Nikola Jokic',             hint: 'Cerebral'     },
    { name: 'Luka Doncic',              hint: 'Slovenian'    },
    { name: 'Joel Embiid',              hint: 'Physical'     },
    { name: 'Jayson Tatum',             hint: 'Forward'      },
    { name: 'Devin Booker',             hint: 'Shooter'      },
    { name: 'Anthony Edwards',          hint: 'Athletic'     },
    { name: 'Damian Lillard',           hint: 'Buzzer'       },
    { name: 'Kawhi Leonard',            hint: 'Silent'       },
    { name: 'Jimmy Butler',             hint: 'Grinder'      },
    { name: 'Bam Adebayo',              hint: 'Anchor'       },
    { name: 'Donovan Mitchell',         hint: 'Explosive'    },
    { name: 'Tyrese Haliburton',        hint: 'Playmaker'    },
    { name: 'Kyrie Irving',             hint: 'Handle'       },
    { name: 'James Harden',             hint: 'Beard'        },
    { name: 'Russell Westbrook',        hint: 'Triple'       },
    { name: 'Chris Paul',               hint: 'Point'        },
    { name: 'Anthony Davis',            hint: 'Unicorn'      },
    { name: 'Paul George',              hint: 'Wing'         },
    { name: 'Zion Williamson',          hint: 'Force'        },
    { name: 'Trae Young',               hint: 'Vision'       },
    { name: 'Ja Morant',                hint: 'Acrobatic'    },
    { name: 'Victor Wembanyama',        hint: 'Alien'        },
    { name: 'Shai Gilgeous-Alexander',  hint: 'Silky'        },
    { name: 'LaMelo Ball',              hint: 'Flashy'       },
    { name: "De'Aaron Fox",             hint: 'Speed'        },
    { name: 'Tyrese Maxey',             hint: 'Rising'       },
    { name: 'Karl-Anthony Towns',       hint: 'Center'       },
    { name: 'Zach LaVine',              hint: 'Leaper'       },
    { name: 'Draymond Green',           hint: 'IQ'           },
    { name: 'Klay Thompson',            hint: 'Splash'       },
    { name: 'Domantas Sabonis',         hint: 'Boards'       },
    { name: 'Khris Middleton',          hint: 'Clutch'       },
    { name: 'Jrue Holiday',             hint: 'Stopper'      },
    { name: 'Pascal Siakam',            hint: 'Rangy'        },
    { name: 'DeMar DeRozan',            hint: 'Midrange'     },
    { name: 'Bradley Beal',             hint: 'Scorer'       },
    { name: 'Vince Carter',             hint: 'Dunk'         },
    { name: 'Tracy McGrady',            hint: 'Peak'         },
    { name: 'Carmelo Anthony',          hint: 'Bucket'       },
    { name: 'Blake Griffin',            hint: 'Power'        },
    { name: 'Chris Bosh',               hint: 'Mobile'       },
    { name: 'Dwyane Wade',              hint: 'Flash'        },
    { name: 'Ray Allen',                hint: 'Sharp'        },
    { name: 'Paul Pierce',              hint: 'Truth'        },
    { name: 'Kevin Garnett',            hint: 'Intense'      },
    { name: 'Derrick Rose',             hint: 'Youngest'     },
    { name: 'Dwight Howard',            hint: 'Superman'     },
    { name: 'Reggie Miller',            hint: 'Sniper'       },
    { name: 'Shawn Kemp',               hint: 'Dunker'       },
    { name: 'Gary Payton',              hint: 'Glove'        },
    { name: 'Jason Kidd',               hint: 'Maestro'      },
    { name: 'Steve Nash',               hint: 'Passing'      },
    { name: 'Michael Jordan',           hint: 'Dynasty'      },
    { name: 'Kobe Bryant',              hint: 'Relentless'   },
    { name: "Shaquille O'Neal",         hint: 'Dominant'     },
    { name: 'Magic Johnson',            hint: 'Showtime'     },
    { name: 'Larry Bird',               hint: 'Clutch'       },
    { name: 'Scottie Pippen',           hint: 'Sidekick'     },
    { name: 'Dennis Rodman',            hint: 'Rebounds'     },
    { name: 'Isiah Thomas',             hint: 'Pistons'      },
    { name: 'Charles Barkley',          hint: 'Outspoken'    },
    { name: 'John Stockton',            hint: 'Assists'      },
    { name: 'Kareem Abdul-Jabbar',      hint: 'Skyhook'      },
    { name: 'Wilt Chamberlain',         hint: 'Records'      },
    { name: 'Bill Russell',             hint: 'Rings'        },
    { name: 'Oscar Robertson',          hint: 'Triple'       },
    { name: 'Julius Erving',            hint: 'Doctor'       },
    { name: 'Tim Duncan',               hint: 'Steady'       },
    { name: 'Dirk Nowitzki',            hint: 'German'       },
    { name: 'Allen Iverson',            hint: 'Fearless'     },
    { name: 'Hakeem Olajuwon',          hint: 'Dream'        },
    { name: 'Patrick Ewing',            hint: 'Knick'        },
    { name: 'Karl Malone',              hint: 'Mailman'      },
    { name: 'David Robinson',           hint: 'Admiral'      },
    { name: 'Clyde Drexler',            hint: 'Glide'        },
    { name: 'John Havlicek',            hint: 'Hustler'      },
    { name: 'Moses Malone',             hint: 'Physical'     },
    { name: 'Elgin Baylor',             hint: 'Pioneer'      },
    { name: 'Jerry West',               hint: 'Logo'         },
    { name: 'Pete Maravich',            hint: 'Pistol'       },
    { name: 'Darius Garland',           hint: 'Crafty'       },
    { name: 'Jalen Brunson',            hint: 'Tough'        },
    { name: 'Paolo Banchero',           hint: 'Polished'     },
    { name: 'Evan Mobley',              hint: 'Defender'     },
    { name: 'Brandon Ingram',           hint: 'Slender'      },
    { name: 'Chet Holmgren',            hint: 'Wispy'        },
    { name: 'Nikola Vucevic',           hint: 'European'     },
    { name: 'Dejounte Murray',          hint: 'Stopper'      },
    { name: 'Jaren Jackson Jr.',        hint: 'Blocks'       },
    { name: 'Kristaps Porzingis',       hint: 'Latvian'      },
    { name: 'Fred VanVleet',            hint: 'Undersized'   },
    { name: 'CJ McCollum',              hint: 'Precise'      },
    { name: 'Josh Giddey',              hint: 'Aussie'       },
    { name: 'Scoot Henderson',          hint: 'Shifty'       },
    { name: 'Franz Wagner',             hint: 'Smooth'       },
    { name: 'Scottie Barnes',           hint: 'Prospect'     },
  ],
  'NFL Players': [
    { name: 'Patrick Mahomes',          hint: 'Wizard'       },
    { name: 'Josh Allen',               hint: 'Cannon'       },
    { name: 'Lamar Jackson',            hint: 'Electric'     },
    { name: 'Joe Burrow',               hint: 'Cool'         },
    { name: 'Jalen Hurts',              hint: 'Scrambler'    },
    { name: 'Justin Herbert',           hint: 'Arm'          },
    { name: 'Dak Prescott',             hint: 'Franchise'    },
    { name: 'Tua Tagovailoa',           hint: 'Accurate'     },
    { name: 'Travis Kelce',             hint: 'Legendary'    },
    { name: 'Tyreek Hill',              hint: 'Blazing'      },
    { name: 'Justin Jefferson',         hint: 'Routes'       },
    { name: 'Davante Adams',            hint: 'Precision'    },
    { name: 'CeeDee Lamb',              hint: 'Reliable'     },
    { name: "Ja'Marr Chase",            hint: 'Yards'        },
    { name: 'Cooper Kupp',              hint: 'Possession'   },
    { name: 'Stefon Diggs',             hint: 'Miracle'      },
    { name: 'Aaron Rodgers',            hint: 'Gunslinger'   },
    { name: 'Russell Wilson',           hint: 'Clutch'       },
    { name: 'Cam Newton',               hint: 'Superman'     },
    { name: 'Kyler Murray',             hint: 'Dynamic'      },
    { name: 'CJ Stroud',                hint: 'Rising'       },
    { name: 'Christian McCaffrey',      hint: 'Complete'     },
    { name: 'Derrick Henry',            hint: 'Powerful'     },
    { name: 'Saquon Barkley',           hint: 'Evasive'      },
    { name: 'Ezekiel Elliott',          hint: 'Cowboy'       },
    { name: 'Alvin Kamara',             hint: 'Versatile'    },
    { name: 'Jonathan Taylor',          hint: 'Speed'        },
    { name: 'Nick Chubb',               hint: 'Bruiser'      },
    { name: 'Marshawn Lynch',           hint: 'Beastmode'    },
    { name: 'Frank Gore',               hint: 'Durable'      },
    { name: 'Aaron Donald',             hint: 'Unstoppable'  },
    { name: 'Myles Garrett',            hint: 'Dominant'     },
    { name: 'Nick Bosa',                hint: 'Rusher'       },
    { name: 'J.J. Watt',                hint: 'Relentless'   },
    { name: 'Micah Parsons',            hint: 'Motor'        },
    { name: 'Von Miller',               hint: 'Sack'         },
    { name: 'Khalil Mack',              hint: 'Disruption'   },
    { name: 'Bobby Wagner',             hint: 'Anchor'       },
    { name: 'Deion Sanders',            hint: 'Primetime'    },
    { name: 'Patrick Peterson',         hint: 'Lockdown'     },
    { name: 'Jalen Ramsey',             hint: 'Shutdown'     },
    { name: 'Ed Reed',                  hint: 'Hawk'         },
    { name: 'Troy Polamalu',            hint: 'Wild'         },
    { name: 'Odell Beckham Jr.',        hint: 'Catch'        },
    { name: 'Antonio Brown',            hint: 'Route'        },
    { name: 'DeAndre Hopkins',          hint: 'Hands'        },
    { name: 'George Kittle',            hint: 'Energetic'    },
    { name: 'Tom Brady',                hint: 'Rings'        },
    { name: 'Peyton Manning',           hint: 'Cerebral'     },
    { name: 'Jerry Rice',               hint: 'Greatest'     },
    { name: 'Lawrence Taylor',          hint: 'Predator'     },
    { name: 'Barry Sanders',            hint: 'Elusive'      },
    { name: 'Randy Moss',               hint: 'Vertical'     },
    { name: 'Emmitt Smith',             hint: 'Rusher'       },
    { name: 'Brett Favre',              hint: 'Gunslinger'   },
    { name: 'Joe Montana',              hint: 'Calm'         },
    { name: 'Dan Marino',               hint: 'Launcher'     },
    { name: 'John Elway',               hint: 'Drive'        },
    { name: 'Steve Young',              hint: 'Mobile'       },
    { name: 'Troy Aikman',              hint: 'Steady'       },
    { name: 'Jim Kelly',                hint: 'Determination'},
    { name: 'Warren Moon',              hint: 'Pioneer'      },
    { name: 'Drew Brees',               hint: 'Accurate'     },
    { name: 'Ben Roethlisberger',       hint: 'Big'          },
    { name: 'Eli Manning',              hint: 'Giant'        },
    { name: 'Philip Rivers',            hint: 'Talkative'    },
    { name: 'Donovan McNabb',           hint: 'Eagle'        },
    { name: 'Michael Vick',             hint: 'Electrifying' },
    { name: 'Walter Payton',            hint: 'Sweetness'    },
    { name: 'Jim Brown',                hint: 'Power'        },
    { name: 'LaDainian Tomlinson',      hint: 'Record'       },
    { name: 'Adrian Peterson',          hint: 'Purple'       },
    { name: 'Eric Dickerson',           hint: 'Smooth'       },
    { name: 'Tony Dorsett',             hint: 'Quick'        },
    { name: 'Marcus Allen',             hint: 'Runner'       },
    { name: 'Earl Campbell',            hint: 'Freight'      },
    { name: 'Reggie White',             hint: 'Minister'     },
    { name: 'Bruce Smith',              hint: 'Buffalo'      },
    { name: 'Dick Butkus',              hint: 'Menacing'     },
    { name: 'Ray Lewis',                hint: 'Warrior'      },
    { name: 'Junior Seau',              hint: 'Fierce'       },
    { name: 'Mike Singletary',          hint: 'Intense'      },
    { name: 'Brian Urlacher',           hint: 'Chicago'      },
    { name: 'Derrick Brooks',           hint: 'Tampa'        },
    { name: 'Rod Woodson',              hint: 'Cornerback'   },
    { name: 'Ronnie Lott',              hint: 'Hitter'       },
    { name: 'Calvin Johnson',           hint: 'Megatron'     },
    { name: 'Terrell Owens',            hint: 'Showboat'     },
    { name: 'Michael Irvin',            hint: 'Playmaker'    },
    { name: 'Larry Fitzgerald',         hint: 'Cardinal'     },
    { name: 'Marvin Harrison',          hint: 'Colts'        },
    { name: 'Andre Johnson',            hint: 'Houston'      },
    { name: 'Steve Smith Sr.',          hint: 'Tenacious'    },
    { name: 'Julio Jones',              hint: 'Smooth'       },
    { name: 'Rob Gronkowski',           hint: 'Gronk'        },
    { name: 'Tony Gonzalez',            hint: 'Premier'      },
    { name: 'Jason Witten',             hint: 'Longevity'    },
    { name: 'Hines Ward',               hint: 'Gritty'       },
    { name: 'Torry Holt',               hint: 'Ram'          },
    { name: 'Andre Reed',               hint: 'Bills'        },
  ],
  'MLB Players': [
    { name: 'Shohei Ohtani',            hint: 'Unique'       },
    { name: 'Mike Trout',               hint: 'Underrated'   },
    { name: 'Aaron Judge',              hint: 'Towering'     },
    { name: 'Mookie Betts',             hint: 'Versatile'    },
    { name: 'Freddie Freeman',          hint: 'Clutch'       },
    { name: 'Ronald Acuna Jr.',         hint: 'Venezuelan'   },
    { name: 'Juan Soto',                hint: 'Patient'      },
    { name: 'Fernando Tatis Jr.',       hint: 'Flair'        },
    { name: 'Julio Rodriguez',          hint: 'Energetic'    },
    { name: 'Yordan Alvarez',           hint: 'Power'        },
    { name: 'Corey Seager',             hint: 'Consistent'   },
    { name: 'Trea Turner',              hint: 'Speed'        },
    { name: 'Nolan Arenado',            hint: 'Vacuum'       },
    { name: 'Paul Goldschmidt',         hint: 'Steady'       },
    { name: 'Jose Altuve',              hint: 'Short'        },
    { name: 'Vladimir Guerrero Jr.',    hint: 'Powerful'     },
    { name: 'Pete Alonso',              hint: 'Polar Bear'   },
    { name: 'Bryce Harper',             hint: 'Passionate'   },
    { name: 'Francisco Lindor',         hint: 'Smile'        },
    { name: 'Bobby Witt Jr.',           hint: 'Athletic'     },
    { name: 'Gunnar Henderson',         hint: 'Rookie'       },
    { name: 'Corbin Carroll',           hint: 'Speed'        },
    { name: 'Adley Rutschman',          hint: 'Catcher'      },
    { name: 'Bo Bichette',              hint: 'Blue Jay'     },
    { name: 'Gerrit Cole',              hint: 'Ace'          },
    { name: 'Spencer Strider',          hint: 'Strikeout'    },
    { name: 'Jacob deGrom',             hint: 'Dominant'     },
    { name: 'Max Scherzer',             hint: 'Intense'      },
    { name: 'Justin Verlander',         hint: 'Longevity'    },
    { name: 'Clayton Kershaw',          hint: 'Southpaw'     },
    { name: 'Derek Jeter',              hint: 'Captain'      },
    { name: 'Ken Griffey Jr.',          hint: 'Graceful'     },
    { name: 'Barry Bonds',              hint: 'Controversial'},
    { name: 'Alex Rodriguez',           hint: 'Complicated'  },
    { name: 'Albert Pujols',            hint: 'Machine'      },
    { name: 'Chipper Jones',            hint: 'Loyal'        },
    { name: 'Randy Johnson',            hint: 'Intimidating' },
    { name: 'David Ortiz',              hint: 'Big Papi'     },
    { name: 'Ichiro Suzuki',            hint: 'Japanese'     },
    { name: 'Manny Ramirez',            hint: 'Slugger'      },
    { name: 'Carlos Beltran',           hint: 'Switch'       },
    { name: 'Chase Utley',              hint: 'Gritty'       },
    { name: 'Ryan Howard',              hint: 'Towering'     },
    { name: 'Jim Thome',                hint: 'Power'        },
    { name: 'Todd Helton',              hint: 'Rockies'      },
    { name: 'Roy Halladay',             hint: 'Workhorse'    },
    { name: 'CC Sabathia',              hint: 'Workhorse'    },
    { name: 'Zack Greinke',             hint: 'Quirky'       },
    { name: 'Felix Hernandez',          hint: 'King'         },
    { name: 'Tim Lincecum',             hint: 'Freak'        },
    { name: 'Babe Ruth',                hint: 'Sultan'       },
    { name: 'Lou Gehrig',               hint: 'Iron'         },
    { name: 'Willie Mays',              hint: 'Say Hey'      },
    { name: 'Hank Aaron',               hint: 'Hammer'       },
    { name: 'Mickey Mantle',            hint: 'Commerce'     },
    { name: 'Ted Williams',             hint: 'Splendid'     },
    { name: 'Joe DiMaggio',             hint: 'Streak'       },
    { name: 'Honus Wagner',             hint: 'Flying'       },
    { name: 'Ty Cobb',                  hint: 'Fierce'       },
    { name: 'Stan Musial',              hint: 'Cardinal'     },
    { name: 'Sandy Koufax',             hint: 'Southpaw'     },
    { name: 'Bob Gibson',               hint: 'Intimidating' },
    { name: 'Tom Seaver',               hint: 'Franchise'    },
    { name: 'Reggie Jackson',           hint: 'October'      },
    { name: 'Mike Schmidt',             hint: 'Philly'       },
    { name: 'George Brett',             hint: 'Pine Tar'     },
    { name: 'Robin Yount',              hint: 'Milwaukee'    },
    { name: 'Cal Ripken Jr.',           hint: 'Iron'         },
    { name: 'Tony Gwynn',               hint: 'Batting'      },
    { name: 'Wade Boggs',               hint: 'Chicken'      },
    { name: 'Rickey Henderson',         hint: 'Stolen'       },
    { name: 'Ozzie Smith',              hint: 'Wizard'       },
    { name: 'Kirby Puckett',            hint: 'Joyful'       },
    { name: 'Dave Winfield',            hint: 'Athletic'     },
    { name: 'Paul Molitor',             hint: 'Impactor'     },
    { name: 'Gary Carter',              hint: 'Kid'          },
    { name: 'Johnny Bench',             hint: 'Greatest'     },
    { name: 'Carlton Fisk',             hint: 'Wave'         },
    { name: 'Yogi Berra',               hint: 'Quotable'     },
    { name: 'Mike Piazza',              hint: 'Slugger'      },
    { name: 'Nolan Ryan',               hint: 'Express'      },
    { name: 'Roger Clemens',            hint: 'Rocket'       },
    { name: 'Pedro Martinez',           hint: 'Dominant'     },
    { name: 'Greg Maddux',              hint: 'Cerebral'     },
    { name: 'Mariano Rivera',           hint: 'Cutter'       },
    { name: 'Trevor Hoffman',           hint: 'Closer'       },
    { name: 'Dennis Eckersley',         hint: 'Sidearm'      },
    { name: 'Frank Thomas',             hint: 'Big Hurt'     },
    { name: 'Jeff Bagwell',             hint: 'Stance'       },
    { name: 'Edgar Martinez',           hint: 'Seattle'      },
    { name: 'Larry Walker',             hint: 'Canadian'     },
    { name: 'Curt Schilling',           hint: 'Bloody'       },
    { name: 'Sammy Sosa',               hint: 'Salute'       },
    { name: 'Mark McGwire',             hint: 'Record'       },
    { name: 'Mike Mussina',             hint: 'Moose'        },
    { name: 'Roy Oswalt',               hint: 'Crafty'       },
    { name: 'Cole Hamels',              hint: 'Southpaw'     },
    { name: 'Johan Santana',            hint: 'Changeup'     },
    { name: 'Andy Pettitte',            hint: 'Yankee'       },
    { name: 'Kyle Schwarber',           hint: 'Slugger'      },
  ],
  'Soccer Players': [
    { name: 'Lionel Messi',             hint: 'Magician'     },
    { name: 'Cristiano Ronaldo',        hint: 'Dedication'   },
    { name: 'Kylian Mbappe',            hint: 'Lightning'    },
    { name: 'Erling Haaland',           hint: 'Machine'      },
    { name: 'Vinicius Jr.',             hint: 'Dancer'       },
    { name: 'Neymar',                   hint: 'Flashy'       },
    { name: 'Kevin De Bruyne',          hint: 'Vision'       },
    { name: 'Mohamed Salah',            hint: 'Egyptian'     },
    { name: 'Harry Kane',               hint: 'Clinical'     },
    { name: 'Pedri',                    hint: 'Composed'     },
    { name: 'Bukayo Saka',              hint: 'Academy'      },
    { name: 'Jude Bellingham',          hint: 'Prodigy'      },
    { name: 'Ronaldinho',               hint: 'Joyful'       },
    { name: 'Zinedine Zidane',          hint: 'Elegant'      },
    { name: 'Thierry Henry',            hint: 'Pace'         },
    { name: 'David Beckham',            hint: 'Celebrity'    },
    { name: 'Ronaldo Nazario',          hint: 'Phenomenon'   },
    { name: 'Pele',                     hint: 'Legend'       },
    { name: 'Diego Maradona',           hint: 'Controversial'},
    { name: 'Xavi',                     hint: 'Precision'    },
    { name: 'Andres Iniesta',           hint: 'Graceful'     },
    { name: 'Gareth Bale',              hint: 'Welsh'        },
    { name: 'Wayne Rooney',             hint: 'English'      },
    { name: 'Frank Lampard',            hint: 'Goals'        },
    { name: 'Steven Gerrard',           hint: 'Liverpool'    },
    { name: 'Didier Drogba',            hint: 'Physical'     },
    { name: 'Zlatan Ibrahimovic',       hint: 'Kung-Fu'      },
    { name: 'Robert Lewandowski',       hint: 'Prolific'     },
    { name: 'Karim Benzema',            hint: 'Complete'     },
    { name: 'Luka Modric',              hint: 'Elegant'      },
    { name: 'Sergio Ramos',             hint: 'Leader'       },
    { name: 'Virgil van Dijk',          hint: 'Commanding'   },
    { name: 'Paolo Maldini',            hint: 'Legendary'    },
    { name: 'Franz Beckenbauer',        hint: 'Kaiser'       },
    { name: 'Johan Cruyff',             hint: 'Turn'         },
    { name: 'Marco van Basten',         hint: 'Overhead'     },
    { name: 'Ruud Gullit',              hint: 'Dreadlocks'   },
    { name: 'Dennis Bergkamp',          hint: 'Silky'        },
    { name: 'Patrick Vieira',           hint: 'Imposing'     },
    { name: 'Gerd Muller',              hint: 'Bomber'       },
    { name: 'Michael Ballack',          hint: 'Midfield'     },
    { name: 'Oliver Kahn',              hint: 'Titan'        },
    { name: 'Gianluigi Buffon',         hint: 'Wall'         },
    { name: 'Iker Casillas',            hint: 'Saint'        },
    { name: 'Peter Schmeichel',         hint: 'Danish'       },
    { name: 'Roberto Carlos',           hint: 'Rocket'       },
    { name: 'Cafu',                     hint: 'Overlap'      },
    { name: 'Phil Foden',               hint: 'Stockport'    },
    { name: 'Rodri',                    hint: 'Anchor'       },
    { name: 'Bernardo Silva',           hint: 'Portuguese'   },
    { name: 'Marcus Rashford',          hint: 'Manchester'   },
    { name: 'Declan Rice',              hint: 'Engine'       },
    { name: 'Florian Wirtz',            hint: 'German'       },
    { name: 'Jamal Musiala',            hint: 'Fluid'        },
    { name: 'Gavi',                     hint: 'Youthful'     },
    { name: 'Ousmane Dembele',          hint: 'Explosive'    },
    { name: 'Antoine Griezmann',        hint: 'French'       },
    { name: 'Raphael Varane',           hint: 'Composed'     },
    { name: "N'Golo Kante",             hint: 'Engine'       },
    { name: 'Paul Pogba',               hint: 'Showboat'     },
    { name: 'Sadio Mane',               hint: 'Senegalese'   },
    { name: 'Riyad Mahrez',             hint: 'Algerian'     },
    { name: 'Heung-min Son',            hint: 'Korean'       },
    { name: 'Roberto Baggio',           hint: 'Ponytail'     },
    { name: 'Alessandro Del Piero',     hint: 'Juventus'     },
    { name: 'Francesco Totti',          hint: 'Roman'        },
    { name: 'Filippo Inzaghi',          hint: 'Offside'      },
    { name: 'Luis Figo',                hint: 'Portuguese'   },
    { name: 'Fernando Torres',          hint: 'El Nino'      },
    { name: 'David Villa',              hint: 'Guaje'        },
    { name: 'Xabi Alonso',              hint: 'Passing'      },
    { name: 'Carles Puyol',             hint: 'Captain'      },
    { name: 'Gerard Pique',             hint: 'Retired'      },
    { name: 'Sergio Busquets',          hint: 'Invisible'    },
    { name: 'Cesc Fabregas',            hint: 'Artisan'      },
    { name: 'David Silva',              hint: 'Magician'     },
    { name: 'Arjen Robben',             hint: 'Diagonal'     },
    { name: 'Wesley Sneijder',          hint: 'Midfield'     },
    { name: 'Fabio Cannavaro',          hint: 'Captain'      },
    { name: 'Dani Alves',               hint: 'Fullback'     },
    { name: 'Marcelo',                  hint: 'Attacking'    },
    { name: 'Federico Chiesa',          hint: 'Italian'      },
    { name: 'Victor Osimhen',           hint: 'Nigerian'     },
    { name: 'Achraf Hakimi',            hint: 'Moroccan'     },
    { name: 'Alan Shearer',             hint: 'Newcastle'    },
    { name: 'Ryan Giggs',               hint: 'Welsh'        },
    { name: 'Roy Keane',                hint: 'Captain'      },
    { name: 'Eric Cantona',             hint: 'King'         },
    { name: 'Michael Owen',             hint: 'Pace'         },
    { name: 'Toni Kroos',               hint: 'Passing'      },
    { name: 'Philipp Lahm',             hint: 'Leader'       },
    { name: 'Kaka',                     hint: 'Brazilian'    },
    { name: 'Raul',                     hint: 'Madrid'       },
    { name: 'Romelu Lukaku',            hint: 'Belgian'      },
    { name: 'Lautaro Martinez',         hint: 'Argentine'    },
    { name: 'Raheem Sterling',          hint: 'Pacey'        },
    { name: 'Jadon Sancho',             hint: 'Dortmund'     },
    { name: 'Alessandro Nesta',         hint: 'Elegant'      },
    { name: 'Oliver Giroud',            hint: 'Acrobatic'    },
    { name: 'Bruno Fernandes',          hint: 'Portuguese'   },
  ],
  'NHL Players': [
    { name: 'Connor McDavid',           hint: 'Electric'     },
    { name: 'Nathan MacKinnon',         hint: 'Complete'     },
    { name: 'Leon Draisaitl',           hint: 'German'       },
    { name: 'Auston Matthews',          hint: 'Sniper'       },
    { name: 'David Pastrnak',           hint: 'Czech'        },
    { name: 'Cale Makar',               hint: 'Offensive'    },
    { name: 'Mikko Rantanen',           hint: 'Finnish'      },
    { name: 'Sidney Crosby',            hint: 'Leader'       },
    { name: 'Alexander Ovechkin',       hint: 'Russian'      },
    { name: 'Nikita Kucherov',          hint: 'Dominant'     },
    { name: 'Artemi Panarin',           hint: 'Creative'     },
    { name: 'Igor Shesterkin',          hint: 'Acrobatic'    },
    { name: 'Mitch Marner',             hint: 'Crafty'       },
    { name: 'William Nylander',         hint: 'Swedish'      },
    { name: 'John Tavares',             hint: 'Captain'      },
    { name: 'Victor Hedman',            hint: 'Swedish'      },
    { name: 'Erik Karlsson',            hint: 'Swedish'      },
    { name: 'Drew Doughty',             hint: 'King'         },
    { name: 'Shea Weber',               hint: 'Slapshot'     },
    { name: 'Roman Josi',               hint: 'Swiss'        },
    { name: 'Aleksander Barkov',        hint: 'Finnish'      },
    { name: 'Jonathan Huberdeau',       hint: 'Playmaker'    },
    { name: 'Mark Scheifele',           hint: 'Winnipeg'     },
    { name: 'Kyle Connor',              hint: 'Scorer'       },
    { name: 'Brayden Point',            hint: 'Compact'      },
    { name: 'Elias Pettersson',         hint: 'Swedish'      },
    { name: 'Filip Forsberg',           hint: 'Swedish'      },
    { name: 'Anze Kopitar',             hint: 'Slovenian'    },
    { name: 'Jonathan Toews',           hint: 'Leader'       },
    { name: 'Patrick Kane',             hint: 'Handle'       },
    { name: 'Evgeni Malkin',            hint: 'Russian'      },
    { name: 'Kris Letang',              hint: 'Offensive'    },
    { name: 'Marc-Andre Fleury',        hint: 'Acrobatic'    },
    { name: 'Carey Price',              hint: 'Unflappable'  },
    { name: 'Andrei Vasilevskiy',       hint: 'Russian'      },
    { name: 'Tuukka Rask',              hint: 'Finnish'      },
    { name: 'Henrik Lundqvist',         hint: 'King'         },
    { name: 'Roberto Luongo',           hint: 'Italian'      },
    { name: 'Ryan Nugent-Hopkins',      hint: 'Nuge'         },
    { name: 'Evander Kane',             hint: 'Winger'       },
    { name: 'Wayne Gretzky',            hint: 'Records'      },
    { name: 'Mario Lemieux',            hint: 'Heroic'       },
    { name: 'Mark Messier',             hint: 'Warrior'      },
    { name: 'Jaromir Jagr',             hint: 'Longevity'    },
    { name: 'Patrick Roy',              hint: 'Theatrical'   },
    { name: 'Martin Brodeur',           hint: 'Steady'       },
    { name: 'Steve Yzerman',            hint: 'Captain'      },
    { name: 'Eric Lindros',             hint: 'Physical'     },
    { name: 'Bobby Orr',                hint: 'Offensive'    },
    { name: 'Gordie Howe',              hint: 'Mr. Hockey'   },
    { name: 'Phil Esposito',            hint: 'Boston'       },
    { name: 'Bobby Hull',               hint: 'Golden Jet'   },
    { name: 'Guy Lafleur',              hint: 'Flower'       },
    { name: 'Jean Beliveau',            hint: 'Elegant'      },
    { name: 'Maurice Richard',          hint: 'Rocket'       },
    { name: 'Ken Dryden',               hint: 'Scholar'      },
    { name: 'Mike Bossy',               hint: 'Sniper'       },
    { name: 'Bryan Trottier',           hint: 'Islander'     },
    { name: 'Denis Potvin',             hint: 'Captain'      },
    { name: 'Denis Savard',             hint: 'Flashy'       },
    { name: 'Al MacInnis',              hint: 'Slapshot'     },
    { name: 'Ray Bourque',              hint: 'Boston'       },
    { name: 'Paul Coffey',              hint: 'Speed'        },
    { name: 'Nicklas Lidstrom',         hint: 'Perfect'      },
    { name: 'Scott Stevens',            hint: 'Hitter'       },
    { name: 'Brian Leetch',             hint: 'Ranger'       },
    { name: 'Chris Chelios',            hint: 'Durable'      },
    { name: 'Brett Hull',               hint: 'Golden Brett' },
    { name: 'Luc Robitaille',           hint: 'Lucky'        },
    { name: 'Mats Sundin',              hint: 'Swedish'      },
    { name: 'Peter Forsberg',           hint: 'Complete'     },
    { name: 'Dominik Hasek',            hint: 'Dominator'    },
    { name: 'Curtis Joseph',            hint: 'CuJo'         },
    { name: 'Ed Belfour',               hint: 'Eagle'        },
    { name: 'Grant Fuhr',               hint: 'Oiler'        },
    { name: 'Adam Fox',                 hint: 'Offensive'    },
    { name: 'Quinn Hughes',             hint: 'Offensive'    },
    { name: 'Rasmus Dahlin',            hint: 'Swedish'      },
    { name: 'Noah Dobson',              hint: 'Islander'     },
    { name: 'Nazem Kadri',              hint: 'Lebanese'     },
    { name: 'Morgan Rielly',            hint: 'Toronto'      },
    { name: 'Aaron Ekblad',             hint: 'Florida'      },
    { name: 'Gabriel Landeskog',        hint: 'Swedish'      },
    { name: 'Mikael Granlund',          hint: 'Finnish'      },
    { name: 'Patrik Laine',             hint: 'Finnish'      },
    { name: 'Bo Horvat',                hint: 'Captain'      },
    { name: 'Jake Guentzel',            hint: 'Sniper'       },
    { name: 'Ryan Getzlaf',             hint: 'Duck'         },
    { name: 'Corey Perry',              hint: 'Agitator'     },
    { name: 'Darnell Nurse',            hint: 'Edmonton'     },
    { name: 'Alex Pietrangelo',         hint: 'Captain'      },
    { name: 'Seth Jones',               hint: 'Blueline'     },
    { name: 'Juuse Saros',              hint: 'Finnish'      },
    { name: 'Tristan Jarry',            hint: 'Pittsburgh'   },
    { name: 'Jake Markstrom',           hint: 'Swedish'      },
    { name: 'Thatcher Demko',           hint: 'Athletic'     },
    { name: 'Jordan Binnington',        hint: 'Blues'        },
    { name: 'Philipp Grubauer',         hint: 'German'       },
    { name: 'Tomas Hertl',             hint: 'Czech'        },
    { name: "Ryan O'Reilly",            hint: 'Gritty'       },
  ],
  'MMA Fighters': [
    { name: 'Conor McGregor',           hint: 'Notorious'    },
    { name: 'Jon Jones',                hint: 'Dominant'     },
    { name: 'Khabib Nurmagomedov',      hint: 'Eagle'        },
    { name: 'Israel Adesanya',          hint: 'Stylebender'  },
    { name: 'Francis Ngannou',          hint: 'Predator'     },
    { name: 'Amanda Nunes',             hint: 'Lioness'      },
    { name: 'Stipe Miocic',             hint: 'Firefighter'  },
    { name: 'Max Holloway',             hint: 'Blessed'      },
    { name: 'Daniel Cormier',           hint: 'Champion'     },
    { name: 'Georges St-Pierre',        hint: 'Legacy'       },
    { name: 'Anderson Silva',           hint: 'Spider'       },
    { name: 'Dustin Poirier',           hint: 'Diamond'      },
    { name: 'Charles Oliveira',         hint: 'Finish'       },
    { name: 'Alexander Volkanovski',    hint: 'Calculated'   },
    { name: 'Islam Makhachev',          hint: 'Technical'    },
    { name: 'Leon Edwards',             hint: 'Rocky'        },
    { name: 'Kamaru Usman',             hint: 'Nigerian'     },
    { name: "Sean O'Malley",            hint: 'Suga'         },
    { name: 'Valentina Shevchenko',     hint: 'Bullet'       },
    { name: 'Rose Namajunas',           hint: 'Thug'         },
    { name: 'Chuck Liddell',            hint: 'Iceman'       },
    { name: 'Tito Ortiz',               hint: 'Huntington'   },
    { name: 'Randy Couture',            hint: 'Natural'      },
    { name: 'BJ Penn',                  hint: 'Prodigy'      },
    { name: 'Nate Diaz',                hint: 'Stockton'     },
    { name: 'Nick Diaz',                hint: 'Stockton'     },
    { name: 'Robbie Lawler',            hint: 'Ruthless'     },
    { name: 'Donald Cerrone',           hint: 'Cowboy'       },
    { name: 'Tony Ferguson',            hint: 'Unorthodox'   },
    { name: 'Frankie Edgar',            hint: 'Underdog'     },
    { name: 'Urijah Faber',             hint: 'California'   },
    { name: 'Jose Aldo',                hint: 'Brazilian'    },
    { name: 'Lyoto Machida',            hint: 'Karate'       },
    { name: 'Forrest Griffin',          hint: 'Warrior'      },
    { name: 'Quinton Jackson',          hint: 'Rampage'      },
    { name: 'Wanderlei Silva',          hint: 'Axe'          },
    { name: 'Mirko Cro Cop',            hint: 'Lethal'       },
    { name: 'Fedor Emelianenko',        hint: 'Emperor'      },
    { name: 'Antonio Rodrigo Nogueira', hint: 'Big Nog'      },
    { name: 'Fabricio Werdum',          hint: 'Technical'    },
    { name: 'Alistair Overeem',         hint: 'Reem'         },
    { name: 'Junior dos Santos',        hint: 'Cigano'       },
    { name: 'Cain Velasquez',           hint: 'Cardio'       },
    { name: 'Demetrious Johnson',       hint: 'Mighty'       },
    { name: 'Henry Cejudo',             hint: 'Olympic'      },
    { name: 'TJ Dillashaw',             hint: 'Technical'    },
    { name: 'Dominick Cruz',            hint: 'Footwork'     },
    { name: 'Cody Garbrandt',           hint: 'Speed'        },
    { name: 'Joanna Jedrzejczyk',       hint: 'Striking'     },
    { name: 'Weili Zhang',              hint: 'Chinese'      },
    { name: 'Julianna Pena',            hint: 'Venezuelan'   },
    { name: 'Holly Holm',               hint: 'Kickboxer'    },
    { name: 'Ronda Rousey',             hint: 'Pioneer'      },
    { name: 'Miesha Tate',              hint: 'Cupcake'      },
    { name: 'Robert Whittaker',         hint: 'Relentless'   },
    { name: 'Yoel Romero',              hint: 'Athletic'     },
    { name: 'Paulo Costa',              hint: 'Borrachinha'  },
    { name: 'Sean Strickland',          hint: 'Outspoken'    },
    { name: 'Justin Gaethje',           hint: 'Highlight'    },
    { name: 'Michael Chandler',         hint: 'Explosive'    },
    { name: 'Paddy Pimblett',           hint: 'Scouse'       },
    { name: 'Brock Lesnar',             hint: 'Dominant'     },
    { name: 'Dan Henderson',            hint: 'Power'        },
    { name: 'Rich Franklin',            hint: 'Ace'          },
    { name: 'Michael Bisping',          hint: 'Count'        },
    { name: 'Chris Weidman',            hint: 'Undefeated'   },
    { name: 'Luke Rockhold',            hint: 'Model'        },
    { name: 'Gegard Mousasi',           hint: 'Tactical'     },
    { name: 'Jorge Masvidal',           hint: 'Gamebred'     },
    { name: 'Colby Covington',          hint: 'Chaos'        },
    { name: 'Stephen Thompson',         hint: 'Wonderboy'    },
    { name: 'Gilbert Burns',            hint: 'Durinho'      },
    { name: 'Tyron Woodley',            hint: 'Explosive'    },
    { name: 'Matt Hughes',              hint: 'Champion'     },
    { name: 'Bas Rutten',               hint: 'Versatile'    },
    { name: 'Vitor Belfort',            hint: 'Phenom'       },
    { name: 'Brian Ortega',             hint: 'Finish'       },
    { name: 'Aljamain Sterling',        hint: 'Funk'         },
    { name: 'Petr Yan',                 hint: 'Russian'      },
    { name: 'Cory Sandhagen',           hint: 'Sandman'      },
    { name: 'Merab Dvalishvili',        hint: 'Machine'      },
    { name: 'Beneil Dariush',           hint: 'Grappler'     },
    { name: 'Alex Pereira',             hint: 'Poatan'       },
    { name: 'Jamahal Hill',             hint: 'Sweet'        },
    { name: 'Jiri Prochazka',           hint: 'Wild'         },
    { name: 'Jan Blachowicz',           hint: 'Polish'       },
    { name: 'Glover Teixeira',          hint: 'Veteran'      },
    { name: 'Shogun Rua',               hint: 'Brazilian'    },
    { name: 'Anthony Smith',            hint: 'Lionheart'    },
    { name: 'Alexander Gustafsson',     hint: 'Mauler'       },
    { name: 'Rafael dos Anjos',         hint: 'Brazilian'    },
    { name: 'Edson Barboza',            hint: 'Kickboxer'    },
    { name: 'Rashad Evans',             hint: 'Suga'         },
    { name: 'Anthony Pettis',           hint: 'Showtime'     },
    { name: 'Ryan Bader',               hint: 'Darth'        },
    { name: 'Demian Maia',              hint: 'Grappler'     },
    { name: 'Volkan Oezdemir',          hint: 'Turkish'      },
    { name: 'Angela Hill',              hint: 'Overkill'     },
    { name: 'Tatiana Suarez',           hint: 'Grappler'     },
    { name: 'Mackenzie Dern',           hint: 'Grappler'     },
  ],
};


// ── Matchmaking ───────────────────────────────────────────────────────────────
// Per-category queues: { 'NBA Players': [...], ... }
const queues = {};
Object.keys(CATEGORIES).forEach(cat => { queues[cat] = []; });

const rooms = {};

function broadcastQueueCount() {
  const counts = {};
  Object.keys(CATEGORIES).forEach(cat => { counts[cat] = queues[cat].length; });
  io.emit('queueUpdate', { counts });
}

io.on('connection', (socket) => {
  socket.emit('statsUpdate', getStats());
  socket.emit('recentGames', stmts.recentGames.all());
  broadcastStats();

  socket.on('joinQueue', ({ name, peerId, token, category }) => {
    const validCat = CATEGORIES[category] ? category : null;
    if (!validCat) return;

    let userId = null;
    let displayName = String(name || '').trim().slice(0, 20) || 'Player';

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId      = decoded.userId;
        displayName = decoded.username;
      } catch { /* invalid token — play as guest */ }
    }

    Object.values(queues).forEach(q => {
      const i = q.findIndex(p => p.socketId === socket.id);
      if (i !== -1) q.splice(i, 1);
    });
    queues[validCat].push({ socketId: socket.id, name: displayName, peerId, userId });
    broadcastQueueCount();

    if (queues[validCat].length >= 3) {
      const players = queues[validCat].splice(0, 3);
      broadcastQueueCount();

      const roomId        = randomUUID();
      const wordList      = CATEGORIES[validCat];
      const picked        = wordList[Math.floor(Math.random() * wordList.length)];
      const imposterIndex = Math.floor(Math.random() * 3);

      const speakingOrder = [0, 1, 2];
      for (let i = 2; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [speakingOrder[i], speakingOrder[j]] = [speakingOrder[j], speakingOrder[i]];
      }

      rooms[roomId] = { players, readyCount: 0, imposterIndex, word: picked.name, category: validCat, startedAt: Date.now(), votes: {} };

      const playerSummary = players.map((p) => ({ name: p.name, peerId: p.peerId }));

      players.forEach((player, index) => {
        const isImposter = index === imposterIndex;
        io.to(player.socketId).emit('gameStart', {
          roomId,
          role:         isImposter ? 'imposter' : 'knower',
          category:     validCat,
          word:         isImposter ? null        : picked.name,
          hint:         isImposter ? picked.hint : null,
          playerIndex:  index,
          players:      playerSummary,
          speakingOrder,
        });
      });
    }
  });

  socket.on('leaveQueue', () => {
    Object.values(queues).forEach(q => {
      const i = q.findIndex(p => p.socketId === socket.id);
      if (i !== -1) q.splice(i, 1);
    });
    broadcastQueueCount();
  });

  socket.on('peerReady', ({ roomId, playerIndex }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Player navigated to game.html — their socket ID changed. Update it so
    // allPeersReady / voteProgress / gameResult reach the right connection.
    if (typeof playerIndex === 'number' && room.players[playerIndex]) {
      room.players[playerIndex].socketId = socket.id;
    }

    room.readyCount++;
    // Ack back to this socket so the debug overlay can show progress
    socket.emit('peerReadyAck', { count: room.readyCount });

    if (room.readyCount >= 3) {
      const voteOpenAt = Date.now() + 60000;
      room.players.forEach((p) => io.to(p.socketId).emit('allPeersReady', { voteOpenAt }));
    }
  });

  socket.on('submitVote', ({ roomId, votedForIndex }) => {
    const room = rooms[roomId];
    if (!room) return;

    const voterIndex = room.players.findIndex((p) => p.socketId === socket.id);
    if (voterIndex === -1 || voterIndex in room.votes) return; // not in room or already voted
    if (typeof votedForIndex !== 'number' || votedForIndex < 0 || votedForIndex > 2) return;

    room.votes[voterIndex] = votedForIndex;
    const votesIn = Object.keys(room.votes).length;

    room.players.forEach((p) => io.to(p.socketId).emit('voteProgress', { votesIn }));

    if (votesIn === 3) {
      // Validate all votes reference real player indices
      const validIndices = new Set([0, 1, 2]);
      const allValid = Object.values(room.votes).every(v => validIndices.has(v));
      if (!allValid) { console.error('[error] invalid votedForIndex in room', roomId); return; }

      // Tally votes
      const tally = {};
      Object.values(room.votes).forEach((v) => { tally[v] = (tally[v] || 0) + 1; });
      const topVote        = parseInt(Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0]);
      const imposterCaught = topVote === room.imposterIndex;

      const result = {
        imposterCaught,
        imposterIndex: room.imposterIndex,
        imposterName:  room.players[room.imposterIndex].name,
        word:          room.word,
        topVote,
        votes:         room.votes,
      };

      // Emit result to players FIRST so they always see the outcome
      room.players.forEach((p) => io.to(p.socketId).emit('gameResult', result));

      // Save game history
      try {
        stmts.insertHistory.run(
          room.category,
          room.word,
          room.players[room.imposterIndex].name,
          imposterCaught ? 1 : 0,
          JSON.stringify(room.players.map(p => p.name))
        );
      } catch (e) { console.error('[error] insertHistory failed:', e.message); }

      // Update stats for logged-in players
      room.players.forEach((player, index) => {
        if (!player.userId) return;
        const isImposter = index === room.imposterIndex;
        const playerWon  = (isImposter && !imposterCaught) || (!isImposter && imposterCaught);
        try {
          const stmt    = playerWon ? stmts.addWin : stmts.addGame;
          const changes = stmt.run(player.userId).changes;
          console.log(`[stats] userId=${player.userId} name=${player.name} won=${playerWon} rows=${changes}`);
          if (changes === 0) console.warn(`[warn] stat update matched 0 rows for userId=${player.userId}`);
        } catch (e) {
          console.error(`[error] stat update failed for userId=${player.userId}:`, e.message);
        }
      });

      broadcastLeaderboard();
      broadcastRecentGames();
      broadcastStats();
      delete rooms[roomId];
    }
  });

  socket.on('rtc-signal', ({ roomId, targetIndex, signal }) => {
    const room = rooms[roomId];
    if (!room) return;
    const senderIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (senderIdx === -1) return;
    const target = room.players[targetIndex];
    if (!target) return;
    io.to(target.socketId).emit('rtc-signal', { fromIndex: senderIdx, signal });
  });

  socket.on('disconnect', () => {
    Object.values(queues).forEach(q => {
      const i = q.findIndex(p => p.socketId === socket.id);
      if (i !== -1) q.splice(i, 1);
    });
    broadcastQueueCount();
    broadcastStats();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Imposport running → http://localhost:${PORT}`));

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
const JWT_SECRET = process.env.JWT_SECRET || 'imposter-dev-secret-change-in-prod';
const DB_DIR     = process.env.DB_DIR || __dirname;
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DB_DIR, 'imposter.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    imposter_wins INTEGER DEFAULT 0,
    games_played  INTEGER DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const stmts = {
  register:      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),
  findByName:    db.prepare('SELECT * FROM users WHERE username = ?'),
  leaderboard:   db.prepare('SELECT username, imposter_wins, games_played FROM users ORDER BY imposter_wins DESC, games_played ASC LIMIT 10'),
  addGame:       db.prepare('UPDATE users SET games_played = games_played + 1 WHERE id = ?'),
  addWin:        db.prepare('UPDATE users SET imposter_wins = imposter_wins + 1, games_played = games_played + 1 WHERE id = ?'),
};

function getLeaderboard() { return stmts.leaderboard.all(); }
function broadcastLeaderboard() { io.emit('leaderboardUpdate', getLeaderboard()); }

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '').trim();
  if (name.length < 2 || name.length > 20) return res.json({ error: 'Username must be 2–20 characters' });
  if (!password || password.length < 4)    return res.json({ error: 'Password must be at least 4 characters' });

  const hash = bcrypt.hashSync(password, 10);
  try {
    const { lastInsertRowid } = stmts.register.run(name, hash);
    const token = jwt.sign({ userId: lastInsertRowid, username: name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: name });
  } catch (e) {
    res.json({ error: e.message.includes('UNIQUE') ? 'Username already taken' : 'Server error' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = stmts.findByName.get(String(username || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash))
    return res.json({ error: 'Wrong username or password' });
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username });
});

app.get('/api/leaderboard', (_req, res) => res.json(getLeaderboard()));

// ── Game data ─────────────────────────────────────────────────────────────────
const CATEGORIES = {
  'NBA Players': [
    { name: 'LeBron James',            hint: 'Versatile'    },
    { name: 'Stephen Curry',           hint: 'Range'        },
    { name: 'Kevin Durant',            hint: 'Scorer'       },
    { name: 'Giannis Antetokounmpo',   hint: 'Greek'        },
    { name: 'Nikola Jokic',            hint: 'Cerebral'     },
    { name: 'Luka Doncic',             hint: 'European'     },
    { name: 'Joel Embiid',             hint: 'Physical'     },
    { name: 'Jayson Tatum',            hint: 'Forward'      },
    { name: 'Devin Booker',            hint: 'Shooter'      },
    { name: 'Anthony Edwards',         hint: 'Athletic'     },
    { name: 'Damian Lillard',          hint: 'Clutch'       },
    { name: 'Kawhi Leonard',           hint: 'Silent'       },
    { name: 'Jimmy Butler',            hint: 'Grinder'      },
    { name: 'Bam Adebayo',             hint: 'Anchor'       },
    { name: 'Donovan Mitchell',        hint: 'Explosive'    },
    { name: 'Tyrese Haliburton',       hint: 'Playmaker'    },
    { name: 'Michael Jordan',          hint: 'Dynasty'      },
    { name: 'Kobe Bryant',             hint: 'Relentless'   },
    { name: "Shaquille O'Neal",        hint: 'Dominant'     },
    { name: 'Magic Johnson',           hint: 'Showtime'     },
    { name: 'Larry Bird',              hint: 'Shooter'      },
    { name: 'Tim Duncan',              hint: 'Steady'       },
    { name: 'Dirk Nowitzki',           hint: 'German'       },
    { name: 'Allen Iverson',           hint: 'Fearless'     },
  ],
  'NFL Players': [
    { name: 'Patrick Mahomes',         hint: 'Wizard'       },
    { name: 'Josh Allen',              hint: 'Cannon'       },
    { name: 'Lamar Jackson',           hint: 'Speed'        },
    { name: 'Joe Burrow',              hint: 'Cool'         },
    { name: 'Jalen Hurts',             hint: 'Scrambler'    },
    { name: 'Justin Herbert',          hint: 'Arm'          },
    { name: 'Dak Prescott',            hint: 'Franchise'    },
    { name: 'Tua Tagovailoa',          hint: 'Accuracy'     },
    { name: 'Travis Kelce',            hint: 'Legendary'    },
    { name: 'Tyreek Hill',             hint: 'Blazing'      },
    { name: 'Justin Jefferson',        hint: 'Routes'       },
    { name: 'Davante Adams',           hint: 'Precision'    },
    { name: 'CeeDee Lamb',             hint: 'Reliable'     },
    { name: "Ja'Marr Chase",           hint: 'Electric'     },
    { name: 'Cooper Kupp',             hint: 'Possession'   },
    { name: 'Stefon Diggs',            hint: 'Miracle'      },
    { name: 'Tom Brady',               hint: 'Rings'        },
    { name: 'Peyton Manning',          hint: 'Cerebral'     },
    { name: 'Jerry Rice',              hint: 'Routes'       },
    { name: 'Lawrence Taylor',         hint: 'Disruptive'   },
    { name: 'Barry Sanders',           hint: 'Elusive'      },
    { name: 'Randy Moss',              hint: 'Vertical'     },
    { name: 'Emmitt Smith',            hint: 'Rusher'       },
    { name: 'Brett Favre',             hint: 'Gunslinger'   },
  ],
  'MLB Players': [
    { name: 'Shohei Ohtani',           hint: 'Unique'       },
    { name: 'Mike Trout',              hint: 'Underrated'   },
    { name: 'Aaron Judge',             hint: 'Towering'     },
    { name: 'Mookie Betts',            hint: 'Versatile'    },
    { name: 'Freddie Freeman',         hint: 'Clutch'       },
    { name: 'Ronald Acuna Jr.',        hint: 'Venezuelan'   },
    { name: 'Juan Soto',               hint: 'Patient'      },
    { name: 'Fernando Tatis Jr.',      hint: 'Flair'        },
    { name: 'Julio Rodriguez',         hint: 'Energetic'    },
    { name: 'Yordan Alvarez',          hint: 'Power'        },
    { name: 'Corey Seager',            hint: 'Consistent'   },
    { name: 'Trea Turner',             hint: 'Speed'        },
    { name: 'Derek Jeter',             hint: 'Captain'      },
    { name: 'Ken Griffey Jr.',         hint: 'Graceful'     },
    { name: 'Barry Bonds',             hint: 'Controversial'},
    { name: 'Alex Rodriguez',          hint: 'Complicated'  },
    { name: 'Albert Pujols',           hint: 'Machine'      },
    { name: 'Chipper Jones',           hint: 'Loyal'        },
    { name: 'Randy Johnson',           hint: 'Intimidating' },
    { name: 'Clayton Kershaw',         hint: 'Southpaw'     },
  ],
  'Soccer Players': [
    { name: 'Lionel Messi',            hint: 'Magician'     },
    { name: 'Cristiano Ronaldo',       hint: 'Dedication'   },
    { name: 'Kylian Mbappe',           hint: 'Lightning'    },
    { name: 'Erling Haaland',          hint: 'Machine'      },
    { name: 'Vinicius Jr.',            hint: 'Dancer'       },
    { name: 'Neymar',                  hint: 'Flashy'       },
    { name: 'Kevin De Bruyne',         hint: 'Vision'       },
    { name: 'Mohamed Salah',           hint: 'Egyptian'     },
    { name: 'Harry Kane',              hint: 'Clinical'     },
    { name: 'Pedri',                   hint: 'Composed'     },
    { name: 'Bukayo Saka',             hint: 'Academy'      },
    { name: 'Jude Bellingham',         hint: 'Prodigy'      },
    { name: 'Ronaldinho',              hint: 'Joyful'       },
    { name: 'Zinedine Zidane',         hint: 'Elegant'      },
    { name: 'Thierry Henry',           hint: 'Pace'         },
    { name: 'David Beckham',           hint: 'Celebrity'    },
    { name: 'Ronaldo Nazario',         hint: 'Phenomenon'   },
    { name: 'Pele',                    hint: 'Legend'       },
    { name: 'Diego Maradona',          hint: 'Controversial'},
    { name: 'Xavi',                    hint: 'Precision'    },
  ],
  'NHL Players': [
    { name: 'Connor McDavid',          hint: 'Electric'     },
    { name: 'Nathan MacKinnon',        hint: 'Complete'     },
    { name: 'Leon Draisaitl',          hint: 'German'       },
    { name: 'Auston Matthews',         hint: 'Sniper'       },
    { name: 'David Pastrnak',          hint: 'Czech'        },
    { name: 'Cale Makar',              hint: 'Offensive'    },
    { name: 'Mikko Rantanen',          hint: 'Finnish'      },
    { name: 'Sidney Crosby',           hint: 'Leader'       },
    { name: 'Alexander Ovechkin',      hint: 'Russian'      },
    { name: 'Nikita Kucherov',         hint: 'Dominant'     },
    { name: 'Artemi Panarin',          hint: 'Creative'     },
    { name: 'Igor Shesterkin',         hint: 'Acrobatic'    },
    { name: 'Wayne Gretzky',           hint: 'Records'      },
    { name: 'Mario Lemieux',           hint: 'Heroic'       },
    { name: 'Mark Messier',            hint: 'Warrior'      },
    { name: 'Jaromir Jagr',            hint: 'Longevity'    },
    { name: 'Patrick Roy',             hint: 'Theatrical'   },
    { name: 'Martin Brodeur',          hint: 'Steady'       },
    { name: 'Steve Yzerman',           hint: 'Captain'      },
    { name: 'Eric Lindros',            hint: 'Physical'     },
  ],
  'MMA Fighters': [
    { name: 'Conor McGregor',          hint: 'Notorious'    },
    { name: 'Jon Jones',               hint: 'Dominant'     },
    { name: 'Khabib Nurmagomedov',     hint: 'Eagle'        },
    { name: 'Israel Adesanya',         hint: 'Stylebender'  },
    { name: 'Francis Ngannou',         hint: 'Predator'     },
    { name: 'Amanda Nunes',            hint: 'Lioness'      },
    { name: 'Stipe Miocic',            hint: 'Firefighter'  },
    { name: 'Max Holloway',            hint: 'Blessed'      },
    { name: 'Daniel Cormier',          hint: 'Champion'     },
    { name: 'Georges St-Pierre',       hint: 'Legacy'       },
    { name: 'Anderson Silva',          hint: 'Spider'       },
    { name: 'Dustin Poirier',          hint: 'Diamond'      },
    { name: 'Charles Oliveira',        hint: 'Finish'       },
    { name: 'Alexander Volkanovski',   hint: 'Calculated'   },
    { name: 'Islam Makhachev',         hint: 'Technical'    },
    { name: 'Leon Edwards',            hint: 'Rocky'        },
    { name: 'Kamaru Usman',            hint: 'Nigerian'     },
    { name: 'Sean O\'Malley',          hint: 'Suga'         },
    { name: 'Valentina Shevchenko',    hint: 'Bullet'       },
    { name: 'Rose Namajunas',          hint: 'Thug'         },
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

      rooms[roomId] = { players, readyCount: 0, imposterIndex, word: picked.name, votes: {} };

      // Jitsi room name derived from the game's UUID — unguessable, no API call needed
      const jitsiRoom     = roomId.replace(/-/g, '');
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
          jitsiRoom,
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

  socket.on('peerReady', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.readyCount++;
    if (room.readyCount >= 3)
      room.players.forEach((p) => io.to(p.socketId).emit('allPeersReady'));
  });

  socket.on('submitVote', ({ roomId, votedForIndex }) => {
    const room = rooms[roomId];
    if (!room) return;

    const voterIndex = room.players.findIndex((p) => p.socketId === socket.id);
    if (voterIndex === -1 || voterIndex in room.votes) return; // not in room or already voted

    room.votes[voterIndex] = votedForIndex;
    const votesIn = Object.keys(room.votes).length;

    room.players.forEach((p) => io.to(p.socketId).emit('voteProgress', { votesIn }));

    if (votesIn === 3) {
      // Tally votes
      const tally = {};
      Object.values(room.votes).forEach((v) => { tally[v] = (tally[v] || 0) + 1; });
      const topVote      = parseInt(Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0]);
      const imposterCaught = topVote === room.imposterIndex;

      // Update stats for any logged-in players
      room.players.forEach((player, index) => {
        if (!player.userId) return;
        if (index === room.imposterIndex && !imposterCaught) {
          stmts.addWin.run(player.userId);   // imposter escaped — counts as win + game
        } else {
          stmts.addGame.run(player.userId);  // everyone else just gets games_played++
        }
      });

      const result = {
        imposterCaught,
        imposterIndex: room.imposterIndex,
        imposterName:  room.players[room.imposterIndex].name,
        word:          room.word,
        topVote,
        votes:         room.votes,
      };

      room.players.forEach((p) => io.to(p.socketId).emit('gameResult', result));
      broadcastLeaderboard();
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
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Imposter running → http://localhost:${PORT}`));

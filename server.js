const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const { randomUUID } = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Trust Railway's reverse proxy so Socket.io sees the correct protocol/IP
app.set('trust proxy', 1);

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

const peerServer = ExpressPeerServer(server, {
  debug: false,
  proxied: true,  // honour X-Forwarded-* headers from Railway
});
app.use('/peerjs', peerServer);
app.use(express.static(path.join(__dirname, 'public')));

// Each entry: { name, hint }
// hint is a single vague word shown only to the imposter
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
};

// queue: [{socketId, name, peerId}]
let queue = [];

// rooms: { roomId -> { players, readyCount } }
const rooms = {};

function broadcastQueueCount() {
  io.emit('queueUpdate', { count: queue.length });
}

io.on('connection', (socket) => {
  socket.on('joinQueue', ({ name, peerId }) => {
    // Prevent duplicate entries for the same socket
    queue = queue.filter((p) => p.socketId !== socket.id);
    queue.push({ socketId: socket.id, name: String(name).slice(0, 20), peerId });
    broadcastQueueCount();

    if (queue.length >= 3) {
      const players = queue.splice(0, 3);
      broadcastQueueCount();

      const roomId = randomUUID();

      const categoryNames = Object.keys(CATEGORIES);
      const category  = categoryNames[Math.floor(Math.random() * categoryNames.length)];
      const wordList  = CATEGORIES[category];
      const picked    = wordList[Math.floor(Math.random() * wordList.length)];
      const imposterIndex = Math.floor(Math.random() * 3);

      rooms[roomId] = { players, readyCount: 0 };

      const playerSummary = players.map((p) => ({ name: p.name, peerId: p.peerId }));

      players.forEach((player, index) => {
        const isImposter = index === imposterIndex;
        io.to(player.socketId).emit('gameStart', {
          roomId,
          role:     isImposter ? 'imposter' : 'knower',
          category,                             // everyone sees the category
          word:     isImposter ? null : picked.name,  // knowers see the name
          hint:     isImposter ? picked.hint : null,  // imposter gets a vague hint
          playerIndex: index,
          players:  playerSummary,
        });
      });
    }
  });

  socket.on('leaveQueue', () => {
    queue = queue.filter((p) => p.socketId !== socket.id);
    broadcastQueueCount();
  });

  // Fired by each client once their PeerJS peer is open and ready to receive calls
  socket.on('peerReady', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    room.readyCount++;
    if (room.readyCount >= 3) {
      room.players.forEach((p) => {
        io.to(p.socketId).emit('allPeersReady');
      });
    }
  });

  socket.on('disconnect', () => {
    queue = queue.filter((p) => p.socketId !== socket.id);
    broadcastQueueCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Imposter running → http://localhost:${PORT}`);
});

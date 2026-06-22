# Imposport

A real-time multiplayer social deduction game built around sports. Two players know a secret sports player; one is the **imposter** who doesn't. Everyone talks over video and tries to figure out who doesn't know the word.

## How to play

1. Three players each open the app and type their name.
2. Pick a sport category to join the queue. The game starts automatically when all three have joined.
3. Two players see the secret player's name. One player is told they are the **imposter** (no name given, only a hint).
4. All three players connect in a live video call.
5. Discuss naturally — ask questions about the player without saying their name outright — then vote for who the imposter is!

---

## Running locally

### Prerequisites

- Node.js 22.9 or later (uses built-in `node:sqlite`)
- npm

### Install dependencies

```bash
cd imposter
npm install
```

### Start the server

```bash
npm start
```

Open **http://localhost:3000** in three separate browser tabs (or on three devices on the same network).

### Development mode (auto-reload on file changes)

```bash
npm run dev
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `JWT_SECRET` | *(dev fallback)* | Secret for signing auth tokens — **set in production** |
| `ADMIN_PASSWORD` | `imposport-admin` | Password for the `/admin` dashboard |
| `DB_DIR` | project root | Directory where `imposter.db` is stored |

---

## Multi-device play

To play across different devices or networks, expose the local server with a tunnelling tool:

```bash
# using ngrok (install from https://ngrok.com)
ngrok http 3000
```

Share the HTTPS ngrok URL with the other players. HTTPS is required for camera/mic access on non-localhost origins.

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Real-time (matchmaking / game state) | Socket.io |
| Voice & video | Native WebRTC (`RTCPeerConnection`) |
| Database | SQLite via `node:sqlite` (Node 22.9+) |
| Frontend | Plain HTML / CSS / JS |

## Notes

- Camera and microphone access is requested when entering the game room. You can still play without them (the video tiles will show your initials instead).
- Each browser tab must be a separate player — opening two tabs as the same player will cause the queue logic to deduplicate the entry.
- The admin dashboard is at `/admin` — protect it with the `ADMIN_PASSWORD` environment variable.

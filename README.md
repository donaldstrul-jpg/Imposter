# Imposter

A real-time multiplayer social deduction game. Two players know a secret word; one is the **Imposter** who doesn't. Everyone talks over video and tries to figure out who doesn't know the word.

## How to play

1. Three players each open the app and type their name.
2. Each clicks **Join Queue**. The game starts automatically when all three have joined.
3. Two players see the secret word. One player is told they are the **Imposter** (no word given).
4. All three players are connected in a live video call.
5. Discuss naturally — ask questions about the word without saying it outright — then decide who the imposter is!

---

## Running locally

### Prerequisites

- Node.js 18 or later
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
| Voice & video | WebRTC via PeerJS (self-hosted signalling server) |
| Frontend | Plain HTML / CSS / JS |

## Notes

- Camera and microphone access is requested when entering the game room. You can still play without them (the video tiles will show your initials instead).
- Each browser tab must be a separate player — opening two tabs as the same player will cause the queue logic to deduplicate the entry.

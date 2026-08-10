# MMOProject

This is a fantasy game you play in your web browser. You explore a map, fight monsters, collect stuff, grow plants, and chat with other players — all at the same time as your friends, because everyone connects to the same server.

## How to run it

**Download this folder, then double-click `start.bat`.** It installs anything missing the first time, starts the server, and opens the game in your browser automatically. A second window titled "MMOProject Server" opens alongside it — leave it open while you play, close it to stop the game. You'll need [Node.js](https://nodejs.org/) installed first (version 18 or newer).

**Prefer the manual/command-line route instead?**

```bash
git clone https://github.com/Xeowyn/MMOProject.git
cd MMOProject
npm install
npm start
```

Open **http://localhost:3000** in your browser, type in a username, and start playing. (Want the server to restart itself every time you save a code change? Use `npm run dev` instead of `npm start`.)

## What you can do in the game

- Walk around a big map and discover new places
- Fight monsters in turn-based battles
- Buy and sell things at the shop, craft items, and grow crops in a garden
- Talk to NPCs (computer-controlled characters) and do quests for them
- Make an account with a username and password so your progress is saved
- Play on a phone, tablet, or computer — the screen adjusts to fit

## What it's built with

- **Backend (the server):** Node.js, Express, and a library called `ws` for real-time chat and updates
- **Save file:** Everything is saved in one plain file (`data/db.json`) — no fancy database needed
- **Frontend (what you see in the browser):** Plain JavaScript and an HTML5 Canvas (the drawing area), no extra tools required to build it

## How the project is organized

- `server/server.js` — the Express app and WebSocket server. Handles every request the browser sends (`/api/...`) and keeps everyone's live game state in sync.
- `server/store.js` — all the game data (items, monsters, NPCs, quests, recipes, and so on) plus the code that reads and writes player saves.
- `public/` — everything the browser loads: `index.html`, `game.js`, `style.css`.
- `data/db.json` — the save file. Everyone playing on the same server shares this one file — there's no separate database, your computer *is* the server.
- `tools/start-playtest.bat` — a Windows shortcut that starts the server and opens a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) so other people can connect over the internet without any port forwarding setup.

## Security basics

- Passwords need at least 4 characters, and there's no password-reset flow (you'd make a new character instead).
- The server limits how many requests one person can send too fast, and checks a secret token on every action so nobody can pretend to be another player.

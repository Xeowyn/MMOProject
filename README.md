# MMOProject

This is a fantasy game you play in your web browser. You walk around a huge world map, fight monsters in turn-based dungeon battles, collect stuff, grow plants, and chat with other players — all at the same time as your friends, because everyone connects to the same server.

## How to run it

**Click the green "Code" button above → Download ZIP.** Extract it, double-click `MMOProject.exe`, and the game opens in your browser automatically. No install, no command line. A console window opens alongside it — that's the server; close it to stop the game.

**Prefer to run it from the source instead?**

1. Install [Node.js](https://nodejs.org/) (version 18 or newer)
2. Extract the same downloaded folder and double-click `start.bat` — it installs anything missing, starts the server, and opens the game in your browser

**Prefer the manual/command-line route?**

```bash
git clone https://github.com/Xeowyn/MMOProject.git
cd MMOProject
npm install
npm start
```

Open **http://localhost:3002** in your browser, make an account, and start playing. (Want the server to restart itself every time you save a code change? Use `npm run dev` instead of `npm start`.)

## What you can do in the game

- Walk around a vast grid-based world, tile by tile, uncovering the map as you go — already-explored ground is always free to revisit, only new ground costs a supply
- Fight monsters in classic-Roguelike dungeon battles: walk into an enemy to attack it, use potions as your turn, get stronger loot the farther you roam from the starting area
- Buy and sell things at the shop, craft items, and grow crops in a garden
- Talk to NPCs (computer-controlled characters) and do quests for them
- Make an account with a username and password so your progress is saved
- Play on a phone, tablet, or computer — the screen adjusts to fit

## What it's built with

- **Backend (the server):** Node.js, Express, and a library called `ws` for real-time chat and updates
- **Save file:** Everything is saved in one plain file (`data/db.json`) — no fancy database needed
- **Frontend (what you see in the browser):** Plain JavaScript and HTML, no extra tools required to build it

## How the project is organized

- `server/server.js` — the Express app and WebSocket server. Handles every request the browser sends (`/api/...`) and keeps everyone's live game state in sync.
- `server/store.js` — all the game data (items, monsters, NPCs, quests, recipes, the world map, and so on) plus the code that reads and writes player saves.
- `public/` — everything the browser loads: `index.html`, `game.js`, `style.css`.
- `data/db.json` — the save file. Everyone playing on the same server shares this one file — there's no separate database, your computer *is* the server.
- `tools/start-playtest.bat` — a Windows shortcut that starts the server and opens a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) so other people can connect over the internet without any port forwarding setup.
- `MMOProject.exe` — the prebuilt standalone game. `npm run build-exe` rebuilds it from the current code.
- `test/` — the automated test suite (`npm test`).

## Security basics

- Passwords need at least 4 characters, and there's no password-reset flow (you'd make a new character instead).
- The server limits how many requests one person can send too fast, and checks a secret token on every action so nobody can pretend to be another player.

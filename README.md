# MMOProject

A fantasy idler-MMO prototype — browser-based, multiplayer, built from scratch with a Node/Express/WebSocket backend and a vanilla JS/Canvas frontend.

## Features

- Overworld map exploration (click-to-travel, drag-to-pan, pinch-to-zoom on mobile)
- Turn-based combat against enemies
- Shop, crafting, and gardening systems
- NPCs with dialogue trees and quests
- Persistent character saves (username/password login)
- Fully responsive — playable on desktop and mobile

## Tech stack

- **Backend:** Node.js, Express, `ws` (WebSockets)
- **Storage:** Flat JSON file (`data/db.json`) — no external database required
- **Frontend:** Vanilla JavaScript + HTML5 Canvas, no build step

## Getting started

### Requirements
- [Node.js](https://nodejs.org/) (v18+ recommended)

### Install

```bash
git clone https://github.com/Xeowyn/MMOProject.git
cd MMOProject
npm install
```

### Run

```bash
npm start
```

The server starts on **http://localhost:3000** by default (override with the `PORT` environment variable). Open that URL in a browser, pick a username, and play.

For auto-restart on file changes during development:

```bash
npm run dev
```

## How it works

- `server/server.js` — Express app + WebSocket server, exposes REST endpoints under `/api` and handles real-time game state
- `server/store.js` — game data (items, enemies, NPCs, quests, recipes, etc.) and the JSON-backed data store
- `public/` — the client: `index.html`, `game.js`, `style.css`
- `data/db.json` — the save file; everyone who connects to a given server instance shares this same save file (by design — there's no per-user database, your machine *is* the server)
- `tools/start-playtest.bat` — Windows helper script that starts the server and opens a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) so friends can connect over the internet without port forwarding

## Notes for testers

- New characters set a password (min 4 characters) on creation; this prevents someone else from logging in as your character.
- There's no password recovery — if you forget it, create a new character.
- The server includes basic per-IP rate limiting and a login/action token system.

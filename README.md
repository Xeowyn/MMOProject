# MMOProject

This is a fantasy game you play in your web browser. You explore a map, fight monsters, collect stuff, grow plants, and chat with other players — all at the same time as your friends, because everyone connects to the same server.

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

## How to run it yourself

### What you need first
- [Node.js](https://nodejs.org/) installed on your computer (version 18 or newer)

### Set it up

```bash
git clone https://github.com/Xeowyn/MMOProject.git
cd MMOProject
npm install
```

### Start the game

```bash
npm start
```

The server starts at **http://localhost:3000**. Open that address in your browser, type in a username, and start playing. (You can change the port with the `PORT` environment variable if you need to.)

If you're changing the code and want the server to restart itself every time you save a file, use this instead:

```bash
npm run dev
```

## How the project is organized

- `server/server.js` — the Express app and WebSocket server. Handles every request the browser sends (`/api/...`) and keeps everyone's live game state in sync.
- `server/store.js` — all the game data (items, monsters, NPCs, quests, recipes, and so on) plus the code that reads and writes player saves.
- `public/` — everything the browser loads: `index.html`, `game.js`, `style.css`.
- `data/db.json` — the save file. Everyone playing on the same server shares this one file — there's no separate database, your computer *is* the server.
- `tools/start-playtest.bat` — a Windows shortcut that starts the server and opens a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) so friends elsewhere can connect over the internet without you setting up port forwarding.

## Notes if you're testing this with friends

- When you make a new character, you pick a password (at least 4 characters). That stops someone else from logging in as you.
- There's no way to reset a forgotten password — you'd have to make a new character.
- The server has basic protections built in: it limits how many requests one person can send too fast, and it checks a secret token on every action so nobody can pretend to be another player.

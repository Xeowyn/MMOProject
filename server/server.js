const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const store = require('./store');

const PORT = 3002; // permanent port for this app — LAN players and start-playtest.bat both rely on this staying fixed; kept off 3000/3001 to avoid colliding with other local projects

// Same reasoning as store.js's BASE_DIR: a packaged .exe needs to find
// public/ next to itself on disk, not inside its own read-only snapshot.
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

// Safety net: Express already turns a crash inside a route into a normal
// error response, but a crash outside a request (like in a setTimeout) would
// normally kill the whole server for every player. Log it instead and keep
// running.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] recovered, server stays up:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection] recovered, server stays up:', err);
});

const app = express();
app.use(express.json());
// Log every request so we can tell "it never arrived" apart from "it
// arrived and something went wrong silently."
app.use((req, res, next) => {
  console.log(`[http] ${req.method} ${req.originalUrl} from ${req.headers['cf-connecting-ip'] || req.ip}`);
  next();
});
// Tell browsers never to cache the client files — this game is still being
// worked on, and a cached old game.js would quietly bring back bugs we
// already fixed.
app.use(
  express.static(path.join(BASE_DIR, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

// Coarse per-IP rate limit — insurance against a runaway client loop or
// someone hammering the API once the link is shared over the open internet,
// not fine-grained throttling. Generous on purpose: an auto-walk across the
// overworld fires one /api/world/move per tile every ~150ms (worst case a
// few requests/second); combat has no polling at all (one request per
// chosen move/item, result included in the response), so this only ever
// trips on something clearly abnormal.
// cf-connecting-ip is what Cloudflare Tunnel forwards as the real client IP
// (req.ip would otherwise be the tunnel's local loopback for every request).
const RATE_LIMIT_WINDOW_MS = 10000;
const RATE_LIMIT_MAX = 300;
const rateLimitBuckets = new Map(); // ip -> {count, windowStart}
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [ip, bucket] of rateLimitBuckets.entries()) {
    if (bucket.windowStart < cutoff) rateLimitBuckets.delete(ip);
  }
}, 60000).unref();

app.use('/api', (req, res, next) => {
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const now = Date.now();
  let bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    rateLimitBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  next();
});

// Any request that names a playerId must also send the matching
// X-Player-Token header. Without this, anyone could grab another player's id
// (it's visible in the websocket presence list) and act as them. Requests
// with no playerId (like login) skip this check — there's nothing to verify
// yet. Old accounts made before this existed have no token and stay open.
app.use('/api', (req, res, next) => {
  const playerId = (req.body && req.body.playerId) || req.query.playerId;
  if (!playerId) return next();
  const player = store.getPlayer(playerId);
  if (!player) return next(); // let the route's own not_found handling fire
  if (!store.verifyToken(player, req.headers['x-player-token'])) {
    return res.status(401).json({ error: 'invalid_token' });
  }
  next();
});

app.get('/api/locations', (req, res) => {
  res.json(
    store.LOCATIONS.map((l) => ({
      id: l.id,
      name: l.name,
      x: l.gx,
      y: l.gy,
      tier: l.tier,
      skill: l.skill || null,
      // combat is now just "does a fight happen here" — the actual roster
      // is rolled from the location's tier (see /api/world-tiers), not a
      // fixed per-location list, so the true enemy pool isn't in this array.
      combat: !!l.combat,
      tavern: l.tavern || false,
      // loot is granted automatically the moment a location is discovered
      // (see discoverLocation() in store.js) — not a hidden roll, so it's
      // safe to expose here for the discovery popup to show what was found.
      loot: l.loot ? { item: l.loot.item, itemName: store.ITEMS[l.loot.item].name, amount: l.loot.amount } : null,
    }))
  );
});

// Tier -> enemy pool only (dungeon-size/wall-chance/bonus-loot ranges stay
// server-only) — drives the Combat tab's idle "who can I fight here" list
// and lets the client show the right enemy icons for a given location's tier.
app.get('/api/world-tiers', (req, res) => {
  const trimmed = {};
  for (const [tier, cfg] of Object.entries(store.WORLD_TIERS)) trimmed[tier] = { enemies: cfg.enemies };
  res.json(trimmed);
});

app.get('/api/enemies', (req, res) => res.json(store.ENEMIES));
app.get('/api/plants', (req, res) => res.json(store.PLANTS));
app.get('/api/shop', (req, res) =>
  res.json({ items: store.SHOP_ITEMS, locationRevealPrice: store.LOCATION_REVEAL_PRICE })
);
app.get('/api/items', (req, res) => res.json(store.ITEMS));
app.get('/api/recipes', (req, res) => res.json(store.RECIPES));
app.get('/api/animal-species', (req, res) => res.json(store.ANIMAL_SPECIES));
app.get('/api/buildings', (req, res) => res.json(store.BUILDINGS));
app.get('/api/npcs', (req, res) => res.json(Object.values(store.NPCS)));
app.get('/api/dialogue-trees', (req, res) => res.json(store.DIALOGUE_TREES));
app.get('/api/quests', (req, res) => res.json(store.QUESTS));
app.get('/api/perks', (req, res) => res.json(store.PERKS));
app.get('/api/trait-config', (req, res) =>
  res.json({ keys: store.TRAIT_KEYS, base: store.TRAIT_BASE, min: store.TRAIT_MIN, max: store.TRAIT_MAX, extraPoints: store.TRAIT_EXTRA_POINTS })
);

// Logging in is two steps: an unknown username comes back as
// { existing: false, username } so the client can show the character
// creation screen, then calls /api/create-character next.
app.post('/api/login', (req, res) => {
  const result = store.login(req.body.username, req.body.password);
  if (!result) return res.status(400).json({ error: 'invalid_username' });
  if (result.error === 'wrong_password') return res.status(401).json({ error: 'wrong_password' });
  if (!result.existing) return res.json({ existing: false, username: result.username });
  res.json({ existing: true, player: store.publicPlayer(result.player), token: result.token });
});

app.post('/api/create-character', (req, res) => {
  const result = store.createCharacter(req.body.username, req.body.traits, req.body.password);
  if (result.error) return res.status(400).json(result);
  res.json({ existing: true, player: result.player, token: result.token });
});

app.get('/api/me', (req, res) => {
  const player = store.getPlayer(req.query.playerId);
  if (!player) return res.status(404).json({ error: 'not_found' });
  res.json(store.publicPlayer(player));
});

// Static grid dimensions the client needs to render the overworld viewport
// and know how "very very large" the world actually is — fetched once at
// startup, same idea as /api/trait-config.
app.get('/api/world-info', (req, res) => {
  res.json({ width: store.WORLD_WIDTH, height: store.WORLD_HEIGHT });
});

// One tile, one supply, every time — see moveOnWorldGrid() in store.js.
// currentLocation can change as a side effect of a move (walking onto or
// off of a named tile), so this re-broadcasts presence exactly like the old
// /api/travel did.
app.post('/api/world/move', (req, res) => {
  const result = store.moveOnWorldGrid(req.body.playerId, req.body.direction);
  if (result.error) return res.status(400).json(result);
  broadcastPresence();
  res.json(result);
});

// One shared endpoint that starts any gathering skill (mining, woodcutting,
// fishing, hunting, scavenging, harvesting).
app.post('/api/task/start', (req, res) => {
  const result = store.startResourceTask(req.body.playerId, req.body.skillId, req.body.nodeId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/task/stop', (req, res) => {
  const result = store.stopTask(req.body.playerId, req.body.skillId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Missing the bite is a normal result, not an error, so it still gets a 200
// response — only a real problem (like not fishing at all) gets a 400.
app.post('/api/fishing/catch', (req, res) => {
  const result = store.attemptFishingCatch(req.body.playerId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/trait/allocate', (req, res) => {
  const result = store.allocateTraitPoint(req.body.playerId, req.body.trait);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/perk/unlock', (req, res) => {
  const result = store.unlockPerk(req.body.playerId, req.body.perkId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/equip', (req, res) => {
  const result = store.equipItem(req.body.playerId, req.body.itemId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/unequip', (req, res) => {
  const result = store.unequipItem(req.body.playerId, req.body.slot);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/combat/start', (req, res) => {
  const result = store.startCombat(req.body.playerId, req.body.enemyId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/combat/end', (req, res) => {
  const result = store.endCombat(req.body.playerId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Turn-based grid combat: one direction per call — moves the player, or
// attacks whatever enemy is standing in that tile — fully resolved and
// returned in the same response (including the fresh player snapshot) so
// the client never needs a follow-up /api/me poll while a fight is in
// progress.
app.post('/api/combat/move', (req, res) => {
  const result = store.submitCombatMove(req.body.playerId, req.body.direction);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/garden/plant', (req, res) => {
  const result = store.plantSeed(req.body.playerId, req.body.plotIndex, req.body.plantId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/garden/harvest', (req, res) => {
  const result = store.harvestPlot(req.body.playerId, req.body.plotIndex);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/craft', (req, res) => {
  const result = store.craftItem(req.body.playerId, req.body.recipeId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/alchemy/experiment', (req, res) => {
  const result = store.experimentAlchemy(req.body.playerId, req.body.ingredientA, req.body.ingredientB);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/alchemy/craft', (req, res) => {
  const result = store.craftKnownPotion(req.body.playerId, req.body.recipeId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Using an item is a full turn, not a free action — see
// submitCombatItemAction() for why this shares the same turn-resolution
// shape as /api/combat/move.
app.post('/api/combat/item', (req, res) => {
  const result = store.submitCombatItemAction(req.body.playerId, req.body.itemId, req.body.targetUid);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/farm/buy', (req, res) => {
  const result = store.buyAnimal(req.body.playerId, req.body.species);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/farm/collect', (req, res) => {
  const result = store.collectAnimal(req.body.playerId, req.body.animalId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/building/build', (req, res) => {
  const result = store.buildBuilding(req.body.playerId, req.body.buildingType);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/building/collect', (req, res) => {
  const result = store.collectBuilding(req.body.playerId, req.body.buildingType);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/quest/accept', (req, res) => {
  const result = store.acceptQuest(req.body.playerId, req.body.questId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/quest/turn-in', (req, res) => {
  const result = store.turnInQuest(req.body.playerId, req.body.questId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/shop/buy', (req, res) => {
  const result = store.buyItem(req.body.playerId, req.body.itemId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/shop/sell', (req, res) => {
  const result = store.sellItem(req.body.playerId, req.body.itemId, req.body.amount);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/shop/buy-location', (req, res) => {
  const result = store.buyLocationReveal(req.body.playerId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// --- dev/testing endpoints only — see note in store.js ---
app.post('/api/dev/give', (req, res) => {
  const result = store.devGiveItem(req.body.playerId, req.body.itemId, req.body.amount);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/dev/discover', (req, res) => {
  const result = store.devDiscoverLocation(req.body.playerId, req.body.locationId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/dev/set-xp', (req, res) => {
  const result = store.devSetSkillXp(req.body.playerId, req.body.skillId, req.body.xp);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/dev/reset', (req, res) => {
  const result = store.devResetPlayer(req.body.playerId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// --- tavern chat history — kept only in memory, not saved to db.json (it's
// just flavor, not real progress). Sent to the client once when they enter a
// tavern; new messages after that arrive live over the websocket. ---
const MAX_CHAT_HISTORY = 50;
const tavernChatHistory = new Map(); // locationId -> [{username, text, at}]

app.get('/api/tavern/history', (req, res) => {
  res.json({ history: tavernChatHistory.get(req.query.locationId) || [] });
});

const server = app.listen(PORT, () => {
  console.log(`MMOProject server running at http://localhost:${PORT}`);
  // Only for the packaged .exe -- npm start/dev users already have their own
  // way of opening the browser, and this would just pop an extra tab on
  // every restart while actively developing.
  if (process.pkg && process.platform === 'win32') {
    require('child_process').exec(`start http://localhost:${PORT}`);
  }
});

// --- presence: who's online and where, broadcast to everyone on change ---
const wss = new WebSocketServer({ server });
const connections = new Map(); // playerId -> ws

// Same crash-if-nobody's-listening rule applies to the whole websocket
// server, not just each connection — see the per-connection ws.on('error')
// below for the full explanation.
wss.on('error', (err) => {
  console.error('[wss] server error (recovered, server stays up):', err.message);
});

function broadcastPresence() {
  const players = [];
  for (const [playerId, ws] of connections.entries()) {
    const player = store.getPlayer(playerId);
    if (player) players.push({ id: player.id, username: player.username, locationId: player.currentLocation });
  }
  const payload = JSON.stringify({ type: 'players', players });
  for (const ws of connections.values()) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

wss.on('connection', (ws, req) => {
  console.log(`[ws] connection opened from ${req.headers['cf-connecting-ip'] || req.socket.remoteAddress}`);
  let identifiedId = null;
  ws.on('message', (raw) => {
    // Express automatically catches errors in normal routes, but this
    // websocket message handler isn't a route — if something throws in here
    // and nobody catches it, the whole server crashes for every player. This
    // try/catch is that safety net.
    try {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      // A message like "null" or "42" parses fine as JSON but isn't a real
      // message object, so reading msg.type on it would crash. Skip anything
      // that isn't a proper object.
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'identify' && msg.playerId && store.getPlayer(msg.playerId)) {
        identifiedId = msg.playerId;
        connections.set(identifiedId, ws);
        broadcastPresence();
      } else if (msg.type === 'chat' && identifiedId) {
        const player = store.getPlayer(identifiedId);
        if (!player) return;
        const loc = store.LOCATIONS.find((l) => l.id === player.currentLocation);
        if (!loc || !loc.tavern) return; // must actually be standing in a tavern to speak
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;

        const entry = { username: player.username, text, at: Date.now() };
        const history = tavernChatHistory.get(loc.id) || [];
        history.push(entry);
        if (history.length > MAX_CHAT_HISTORY) history.shift();
        tavernChatHistory.set(loc.id, history);

        const payload = JSON.stringify({ type: 'chat', locationId: loc.id, entry });
        for (const [otherPlayerId, otherWs] of connections.entries()) {
          const otherPlayer = store.getPlayer(otherPlayerId);
          if (otherPlayer && otherPlayer.currentLocation === loc.id && otherWs.readyState === otherWs.OPEN) {
            otherWs.send(payload);
          }
        }
      }
    } catch (err) {
      console.error('[ws message] handler error (recovered, server stays up):', err);
    }
  });
  ws.on('close', () => {
    if (identifiedId) {
      connections.delete(identifiedId);
      broadcastPresence();
    }
  });

  // If nobody listens for a socket's 'error' event, Node treats it as a
  // crash. Without this, one player's dropped connection could take the
  // whole server down for everybody else.
  ws.on('error', (err) => {
    console.error('[ws] socket error (recovered, server stays up):', err.message);
  });
});

// Exported so tests can start the server on a random port (PORT=0) and shut
// it down cleanly when done, instead of hitting the real one.
module.exports = { app, server };

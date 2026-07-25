const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const store = require('./store');

const PORT = process.env.PORT || 3000;

// Last-resort safety net for a live multi-hour session: Express already
// catches synchronous throws inside route handlers (turns them into a 500,
// confirmed by fuzzing every endpoint with hostile input — zero crashes),
// but nothing built-in protects async code that throws outside a request
// (e.g. inside a setTimeout, or a promise nobody awaited/caught) or any bug
// class not yet anticipated. Without this, ANY such bug kills the whole
// process — and with it, every connected player's session — instantly.
// Logging and staying up is strictly better than that for a game server.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] recovered, server stays up:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection] recovered, server stays up:', err);
});

const app = express();
app.use(express.json());
// no-store: this is an actively-iterated prototype (edit -> refresh browser),
// so any caching of public/* is pure risk — a stale game.js served after an
// edit would silently reintroduce fixed bugs with zero visible sign why.
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

app.get('/api/locations', (req, res) => {
  res.json(
    store.LOCATIONS.map((l) => ({
      id: l.id,
      name: l.name,
      x: l.x,
      y: l.y,
      skill: l.skill || null,
      combat: l.combat || null,
      tavern: l.tavern || false,
      // loot is granted automatically the moment a location is discovered
      // (see discoverLocation() in store.js) — not a hidden roll, so it's
      // safe to expose here for the discovery popup to show what was found.
      loot: l.loot ? { item: l.loot.item, itemName: store.ITEMS[l.loot.item].name, amount: l.loot.amount } : null,
    }))
  );
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

// Two-step now: an unrecognized username returns { existing: false, username }
// instead of auto-creating a player, so the client can show the trait
// point-buy character-creation screen and call /api/create-character next.
app.post('/api/login', (req, res) => {
  const result = store.login(req.body.username);
  if (!result) return res.status(400).json({ error: 'invalid_username' });
  if (!result.existing) return res.json({ existing: false, username: result.username });
  res.json({ existing: true, player: store.publicPlayer(result.player) });
});

app.post('/api/create-character', (req, res) => {
  const result = store.createCharacter(req.body.username, req.body.traits);
  if (result.error) return res.status(400).json(result);
  res.json({ existing: true, player: result.player });
});

app.get('/api/me', (req, res) => {
  const player = store.getPlayer(req.query.playerId);
  if (!player) return res.status(404).json({ error: 'not_found' });
  res.json(store.publicPlayer(player));
});

app.post('/api/expedition/start', (req, res) => {
  const result = store.startExpedition(req.body.playerId, req.body.path);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/travel', (req, res) => {
  const result = store.travel(req.body.playerId, req.body.locationId);
  if (result.error) return res.status(400).json(result);
  broadcastPresence();
  res.json(result);
});

app.post('/api/task/start', (req, res) => {
  const result = store.startTask(req.body.playerId, req.body.skillId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/task/stop', (req, res) => {
  const result = store.stopTask(req.body.playerId, req.body.skillId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/mining/start', (req, res) => {
  const result = store.startMiningNode(req.body.playerId, req.body.nodeId);
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

app.post('/api/loadout/set', (req, res) => {
  const result = store.setLoadoutSlot(req.body.playerId, req.body.slotIndex, req.body.abilityId);
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

app.post('/api/potion/use', (req, res) => {
  const result = store.usePotion(req.body.playerId, req.body.itemId);
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

// --- tavern chat history — in-memory only, not persisted to db.json (it's
// ephemeral flavor, unlike real player progress). Sent to the client once on
// entering a tavern; new messages after that arrive live over the socket. ---
const MAX_CHAT_HISTORY = 50;
const tavernChatHistory = new Map(); // locationId -> [{username, text, at}]

app.get('/api/tavern/history', (req, res) => {
  res.json({ history: tavernChatHistory.get(req.query.locationId) || [] });
});

const server = app.listen(PORT, () => {
  console.log(`MMOProject server running at http://localhost:${PORT}`);
});

// --- presence: who's online and where, broadcast to everyone on change ---
const wss = new WebSocketServer({ server });
const connections = new Map(); // playerId -> ws

// Same 'error'-event-with-no-listener-crashes-the-process rule applies to
// the server itself, not just individual sockets — belt-and-suspenders
// alongside the per-connection ws.on('error', ...) below.
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

wss.on('connection', (ws) => {
  let identifiedId = null;
  ws.on('message', (raw) => {
    // Everything in this handler runs as a raw EventEmitter callback, NOT
    // through Express — Express's own routes are already safe (it wraps
    // every handler and turns a thrown error into a 500, confirmed by
    // fuzzing every HTTP endpoint with hundreds of hostile payloads with
    // zero crashes), but nothing does that for a WebSocket 'message'
    // listener. An uncaught throw here kills the entire Node process,
    // taking the server down for every connected player at once — this
    // try/catch is the safety net for that whole class of bug, on top of
    // the specific null-message fix below.
    try {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      // JSON.parse succeeds on plenty of things that aren't message
      // objects — "null" -> null, "42" -> a number, "[]" -> an array —
      // none of those are syntax errors, so the catch above never fires
      // for them. Reading .type off null throws (TypeError: Cannot read
      // properties of null), which is exactly what crashed the server
      // over a single 4-character "null" message before this guard.
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

  // Node's EventEmitter has a special rule for 'error' events specifically:
  // if nothing is listening for one, the error is thrown and crashes the
  // process — a well-documented `ws`-library gotcha, distinct from (and in
  // addition to) the try/catch in the message handler above. A single
  // client's dropped connection, malformed frame, or flaky network could
  // otherwise take the whole server down for every other connected player.
  ws.on('error', (err) => {
    console.error('[ws] socket error (recovered, server stays up):', err.message);
  });
});

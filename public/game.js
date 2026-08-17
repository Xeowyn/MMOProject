const SKILL_DISPLAY_NAMES = {
  mining: 'Mining',
  woodcutting: 'Woodcutting',
  fishing: 'Fishing',
  hunting: 'Hunting',
  scavenging: 'Scavenging',
  harvesting: 'Harvesting',
};

// All 6 gathering skills use the same node-picker UI. Mining/woodcutting/
// fishing give a guaranteed item each cycle; hunting/scavenging/harvesting
// only have a chance each cycle.
const RESOURCE_SKILL_IDS = ['mining', 'woodcutting', 'fishing', 'hunting', 'scavenging', 'harvesting'];
const DETERMINISTIC_SKILL_IDS = new Set(['mining', 'woodcutting', 'fishing']);

const state = {
  playerId: localStorage.getItem('mmo_playerId') || null,
  token: localStorage.getItem('mmo_token') || null,
  player: null,
  locations: [],
  others: [], // [{id, username, locationId}]
  clockSync: {}, // { [skillId]: { progressSeconds, cycleSeconds, active, syncedAt } }
  worldInfo: { width: 0, height: 0 }, // fetched once, see /api/world-info
  worldWalking: false, // true while a confirmed route is being walked — blocks overlapping walks
  worldZoomIndex: 1, // index into WORLD_ZOOM_LEVELS, matches WORLD_DEFAULT_ZOOM_INDEX
  worldPendingPath: null, // [{x,y}, ...] a clicked-out route awaiting Confirm/Cancel, not yet walked
  itemsMeta: {},
  enemiesMeta: {},
  worldTiers: {}, // { [tier]: { enemies: [...] } } — which enemies can appear at each area tier, see /api/world-tiers
  plantsMeta: {},
  recipesMeta: [],
  animalSpeciesMeta: {},
  buildingsMeta: {},
  npcsMeta: [],
  dialogueTreesMeta: {},
  questsMeta: {},
  shopMeta: { items: [], locationRevealPrice: 0 },
  activeTab: 'overworld',
  discoveryQueue: [], // location names waiting to show a popup
  discoveryPopupShowing: false,
  dialogue: { npcId: null, nodeId: null },
  tavernMessages: [],
  tavernLocationId: null, // which tavern's history is currently loaded, so it's only fetched once per location change
  selectedSeed: null, // plantId currently picked in the Gardening tab's seed-then-click-plots flow
  combatActionPending: false, // true while a submitted move/item's response hasn't landed yet — blocks double-submit
  combatLog: [], // [{player, playerHit, enemies, enemyHits, playerHp, playerPos, enemyPositions}] turn-by-turn result from the fight so far
  combatItemMenuOpen: false, // true while the potion list is showing instead of the flee/item buttons
  combatLogSidebarOpen: false, // whether the full text log panel is expanded (grid + flashes are the primary feedback, this is opt-in detail)
  lastSeenRareEventAt: null, // dedupes lastRareEvent across polls, same idea as the discovery-array diff
  traitConfig: null, // { keys, base, min, max, extraPoints } — fetched once, drives the character-creation screen
  creationTraits: null, // { strength, dexterity, luck, vigor } while allocating on the creation screen
  creationUsername: null,
  perksMeta: {}, // static perk definitions, keyed by id (tier/requiresLevel/cost) — merged with player.perks' per-player unlocked/levelMet flags
};

const loginScreen = document.getElementById('login-screen');
const gameScreen = document.getElementById('game-screen');

function showError(text) {
  const el = document.getElementById('error-banner');
  el.textContent = text;
  el.classList.remove('hidden');
}

function clearError() {
  document.getElementById('error-banner').classList.add('hidden');
}

// Wraps fetch so a dead/unreachable server shows a visible message instead
// of the button silently doing nothing.
async function api(path, options) {
  let res;
  // Every request that identifies a player must prove it with this token
  // (see verifyToken() in store.js) — attached here once so no individual
  // call site has to remember to do it.
  const headers = Object.assign({}, options && options.headers);
  if (state.token) headers['X-Player-Token'] = state.token;
  const finalOptions = Object.assign({}, options, { headers });
  try {
    res = await fetch(path, finalOptions);
  } catch (err) {
    showError('Cannot reach the server. Is `npm start` still running?');
    throw err;
  }
  let body = {};
  try {
    body = await res.json();
  } catch {
    // no JSON body
  }
  if (!res.ok) {
    showError(body.error ? `Error: ${body.error}` : `Request failed (${res.status})`);
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  clearError();
  return body;
}

// Every player-triggered action (craft, equip, buy, etc) is a POST with a
// JSON body — this saves every call site from repeating the same
// method/headers/JSON.stringify boilerplate.
function post(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username-input').value.trim();
  const password = document.getElementById('password-input').value;
  if (!username) return;
  let result;
  try {
    result = await post('/api/login', { username, password });
  } catch {
    return;
  }
  if (!result.existing) {
    await showCreationScreen(result.username);
    return;
  }
  finishLogin(result.player, result.token);
});

function finishLogin(player, token) {
  state.playerId = player.id;
  localStorage.setItem('mmo_playerId', player.id);
  // token is null for legacy/no-password accounts (see verifyToken() in
  // store.js) — clearing any stale token in that case, not just skipping
  // the write, so a re-login on a legacy account can't keep sending a
  // leftover token from a previous session on this browser.
  state.token = token || null;
  if (state.token) localStorage.setItem('mmo_token', state.token);
  else localStorage.removeItem('mmo_token');
  state.player = player;
  enterGame();
}

// --- character creation (Fallout-SPECIAL-style trait point-buy) ---

async function showCreationScreen(username) {
  if (!state.traitConfig) {
    state.traitConfig = await api('/api/trait-config');
  }
  state.creationUsername = username;
  const cfg = state.traitConfig;
  state.creationTraits = {};
  for (const key of cfg.keys) state.creationTraits[key] = cfg.base;

  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('creation-screen').classList.remove('hidden');
  renderCreationScreen();
}

const TRAIT_DISPLAY_NAMES = { strength: 'Strength', dexterity: 'Dexterity', luck: 'Luck', vigor: 'Vigor' };
const TRAIT_DESCRIPTIONS = {
  strength: 'Increases melee damage.',
  dexterity: 'Increases attack damage, crit chance, and dodge chance.',
  luck: 'Increases crit chance, loot chance, and gather success chance.',
  vigor: 'Increases max HP.',
};

function creationPointsRemaining() {
  const cfg = state.traitConfig;
  const spent = cfg.keys.reduce((sum, k) => sum + (state.creationTraits[k] - cfg.base), 0);
  return cfg.extraPoints - spent;
}

function renderCreationScreen() {
  const cfg = state.traitConfig;
  const remaining = creationPointsRemaining();
  document.getElementById('trait-points-remaining').textContent = `Points remaining: ${remaining}`;

  const list = document.getElementById('trait-allocation-list');
  list.innerHTML = '';
  for (const key of cfg.keys) {
    const value = state.creationTraits[key];
    const row = document.createElement('div');
    row.className = 'trait-alloc-row';
    row.innerHTML = `
      <div class="trait-alloc-name">${TRAIT_DISPLAY_NAMES[key]}</div>
      <div class="trait-alloc-desc">${TRAIT_DESCRIPTIONS[key]}</div>
      <div class="trait-alloc-controls">
        <button data-trait-dec="${key}" ${value <= cfg.min ? 'disabled' : ''}>&minus;</button>
        <span class="trait-alloc-value">${value}</span>
        <button data-trait-inc="${key}" ${value >= cfg.max || remaining <= 0 ? 'disabled' : ''}>+</button>
      </div>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll('button[data-trait-inc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.traitInc;
      if (state.creationTraits[key] < cfg.max && creationPointsRemaining() > 0) {
        state.creationTraits[key] += 1;
        renderCreationScreen();
      }
    });
  });
  list.querySelectorAll('button[data-trait-dec]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.traitDec;
      if (state.creationTraits[key] > cfg.min) {
        state.creationTraits[key] -= 1;
        renderCreationScreen();
      }
    });
  });

  document.getElementById('creation-begin-btn').disabled = remaining !== 0;
}

document.getElementById('creation-begin-btn').addEventListener('click', async () => {
  if (creationPointsRemaining() !== 0) return;
  const password = document.getElementById('creation-password-input').value;
  let result;
  try {
    result = await post('/api/create-character', { username: state.creationUsername, traits: state.creationTraits, password });
  } catch {
    return;
  }
  document.getElementById('creation-screen').classList.add('hidden');
  finishLogin(result.player, result.token);
});

async function enterGame() {
  loginScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  document.getElementById('player-name').textContent = state.player.username;

  state.locations = await api('/api/locations');
  state.worldInfo = await api('/api/world-info');
  state.itemsMeta = await api('/api/items');
  state.enemiesMeta = await api('/api/enemies');
  state.worldTiers = await api('/api/world-tiers');
  state.plantsMeta = await api('/api/plants');
  state.recipesMeta = await api('/api/recipes');
  state.animalSpeciesMeta = await api('/api/animal-species');
  state.buildingsMeta = await api('/api/buildings');
  state.npcsMeta = await api('/api/npcs');
  state.dialogueTreesMeta = await api('/api/dialogue-trees');
  state.questsMeta = await api('/api/quests');
  state.shopMeta = await api('/api/shop');
  state.perksMeta = await api('/api/perks');
  document.getElementById('buy-location-btn').textContent =
    `Buy Location Coordinates (${state.shopMeta.locationRevealPrice} gold)`;

  buildSkillsTab();
  setupTabs();
  connectSocket();
  await refreshMe();
  scheduleNextPoll();

  // Fishing tab is static HTML (not built dynamically like the old
  // per-skill Skills-tab cards were), so its one-off Catch button is wired
  // here rather than inside a build function.
  document.getElementById('fishing-catch-btn').addEventListener('click', attemptFishingCatch);
  document.getElementById('unequip-weapon-btn').addEventListener('click', () => unequipSlot('weapon'));
  document.getElementById('unequip-armor-btn').addEventListener('click', () => unequipSlot('armor'));
  document.getElementById('flee-btn').addEventListener('click', endCombat);
  document.getElementById('combat-continue-btn').addEventListener('click', endCombat);
  document.getElementById('combat-log-toggle').addEventListener('click', () => {
    state.combatLogSidebarOpen = !state.combatLogSidebarOpen;
    renderCombatTab();
  });
  document.getElementById('item-btn').addEventListener('click', () => {
    state.combatItemMenuOpen = !state.combatItemMenuOpen;
    renderCombatTab();
  });
  for (const btn of document.querySelectorAll('.dpad-btn[data-dir]')) {
    btn.addEventListener('click', () => submitCombatMove(btn.dataset.dir));
  }
  for (const btn of document.querySelectorAll('.dpad-btn[data-wdir]')) {
    btn.addEventListener('click', () => submitWorldMove(btn.dataset.wdir));
  }
  document.getElementById('world-confirm-btn').addEventListener('click', confirmWorldPath);
  document.getElementById('world-cancel-btn').addEventListener('click', cancelWorldPath);
  document.getElementById('world-zoom-in-btn').addEventListener('click', zoomWorldIn);
  document.getElementById('world-zoom-out-btn').addEventListener('click', zoomWorldOut);
  // { passive: false } so preventDefault() can actually stop the page from
  // scrolling while the player scrolls over the map to zoom it instead.
  document.getElementById('world-grid-wrap').addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.deltaY < 0) zoomWorldIn();
      else if (e.deltaY > 0) zoomWorldOut();
    },
    { passive: false }
  );
  // Arrow keys/WASD: move in an active fight if the Combat tab is open,
  // otherwise walk the overworld if the Overworld tab is open — ignored
  // while typing in any text field (e.g. tavern chat) so this can't hijack
  // normal typing.
  document.addEventListener('keydown', (e) => {
    if (!state.player) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const key = e.key.toLowerCase();
    const direction = { arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down', arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right' }[key];
    if (!direction) return;
    if (state.player.combat && !state.player.combat.result && !document.getElementById('tab-combat').classList.contains('hidden')) {
      e.preventDefault();
      submitCombatMove(direction);
    } else if (!state.player.combat && !document.getElementById('tab-overworld').classList.contains('hidden')) {
      e.preventDefault();
      submitWorldMove(direction);
    }
  });
  document.getElementById('buy-location-btn').addEventListener('click', buyLocationReveal);
  document.getElementById('alchemy-experiment-btn').addEventListener('click', runExperiment);
  document.getElementById('alchemy-ingredient-a').addEventListener('change', renderAlchemyTab);
  document.getElementById('alchemy-ingredient-b').addEventListener('change', renderAlchemyTab);
  document.getElementById('discovery-modal-ok').addEventListener('click', closeDiscoveryPopup);
  document.getElementById('rare-event-modal-ok').addEventListener('click', () => {
    document.getElementById('rare-event-modal').classList.add('hidden');
  });
  document.getElementById('dialogue-close-btn').addEventListener('click', closeDialogue);
  document.getElementById('tavern-chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('tavern-chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.send(JSON.stringify({ type: 'chat', playerId: state.playerId, text }));
    input.value = '';
  });
  render();
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
      state.activeTab = btn.dataset.tab;
    });
  });
}

// Combat and overworld movement both need no fast polling at all: nothing
// changes server-side between player actions, and each submitted move/action
// already returns the fresh state directly (see submitWorldMove()/
// submitCombatMove()), so this normal-rate poll is only ever a fallback
// (e.g. picking up a hunting-ambush fight nobody clicked into, or another
// player's presence) rather than how the active UI actually stays in sync.
function scheduleNextPoll() {
  setTimeout(async () => {
    await refreshMe();
    scheduleNextPoll();
  }, 2000);
}

// Shared "a fresh player snapshot just arrived" handling — used by both
// refreshMe()'s poll and every direct action response (world move/combat
// move already hand back the updated player instead of making the caller
// wait for the next poll) so discovery popups/ambush toasts/rare-event
// popups/clock sync all fire immediately regardless of which path produced
// the new data, not just on the next 2s poll.
function applyPlayerSnapshot(newPlayer) {
  const previousDiscoveries = new Set(state.player ? state.player.discoveries : []);
  const wasInCombat = !!(state.player && state.player.combat);
  state.player = newPlayer;

  const newlyDiscovered = state.player.discoveries
    .filter((id) => !previousDiscoveries.has(id))
    .map((id) => state.locations.find((l) => l.id === id))
    .filter(Boolean);
  if (newlyDiscovered.length > 0) {
    queueDiscoveryPopups(newlyDiscovered.map((l) => ({ name: l.name, loot: l.loot })));
  }

  // A hunting cycle can trigger combat server-side with nobody clicking
  // anything — surface that transition distinctly from a fight the player
  // chose to start (which they already know about, having just clicked it).
  if (!wasInCombat && state.player.combat && state.player.combat.ambush) {
    const attacker = state.player.combat.enemies[0];
    showToast(`Ambushed! A ${attacker ? attacker.name : 'creature'} attacks while you were hunting!`);
  }

  if (
    state.player.lastRareEvent &&
    (!state.lastSeenRareEventAt || state.player.lastRareEvent.at > state.lastSeenRareEventAt)
  ) {
    state.lastSeenRareEventAt = state.player.lastRareEvent.at;
    showRareEventPopup(state.player.lastRareEvent);
  }

  const now = Date.now();
  // Each resource skill's clock progress lives on its active node, not the
  // skill itself. Save the same info for all 6 skills so animate() can draw
  // every clock the same way.
  for (const skillId of RESOURCE_SKILL_IDS) {
    const activeNode = state.player[`${skillId}Nodes`].find((n) => n.active);
    state.clockSync[skillId] = activeNode
      ? { progressSeconds: activeNode.progressSeconds, cycleSeconds: activeNode.cycleSeconds, active: true, syncedAt: now }
      : { progressSeconds: 0, cycleSeconds: 1, active: false, syncedAt: now };
  }

  render();
}

async function refreshMe() {
  let newPlayer;
  try {
    newPlayer = await api(`/api/me?playerId=${state.playerId}`);
  } catch {
    return;
  }
  applyPlayerSnapshot(newPlayer);

  // Tavern chat history is only fetched once per tavern entered (not on
  // every poll) — new messages after that arrive live over the socket.
  const currentLoc = state.locations.find((l) => l.id === state.player.currentLocation);
  if (currentLoc && currentLoc.tavern) {
    if (state.tavernLocationId !== currentLoc.id) {
      state.tavernLocationId = currentLoc.id;
      try {
        const data = await api(`/api/tavern/history?locationId=${currentLoc.id}`);
        state.tavernMessages = data.history;
      } catch {
        // ignore — chat is non-critical, don't block the rest of the poll on it
      }
    }
  } else {
    state.tavernLocationId = null;
  }
}

// Popups (not toasts) for newly discovered locations, per the original
// request — shown one at a time via a queue in case several land close
// together (e.g. two locations near each other on the same route). Each
// entry is {name, loot} — loot (if the location has one) was already
// granted server-side the instant it was discovered (see discoverLocation()
// in store.js), this is purely informational.
function queueDiscoveryPopups(entries) {
  state.discoveryQueue.push(...entries);
  showNextDiscoveryPopup();
}

function showNextDiscoveryPopup() {
  if (state.discoveryPopupShowing || state.discoveryQueue.length === 0) return;
  state.discoveryPopupShowing = true;
  const entry = state.discoveryQueue.shift();
  document.getElementById('discovery-modal-name').textContent = entry.name;
  document.getElementById('discovery-modal-loot').textContent = entry.loot
    ? `Found: ${entry.loot.amount}x ${entry.loot.itemName}!`
    : '';
  document.getElementById('discovery-modal').classList.remove('hidden');
}

function closeDiscoveryPopup() {
  document.getElementById('discovery-modal').classList.add('hidden');
  state.discoveryPopupShowing = false;
  showNextDiscoveryPopup();
}

// The 0.01% gather-task jackpot (armor or a quest nudge) — rare enough that
// it gets its own distinct, more celebratory modal rather than sharing the
// plain discovery popup.
function showRareEventPopup(event) {
  const text =
    event.type === 'armor'
      ? `While gathering, you stumble upon ${event.itemName}!`
      : `While gathering, you meet ${event.npcName}, who could use your help. Quest started: ${event.questName}!`;
  document.getElementById('rare-event-modal-text').textContent = text;
  document.getElementById('rare-event-modal').classList.remove('hidden');
}

// --- overworld tab: a very large grid the player walks around on ---
//
// Each tile is either empty (plain floor) or a named location, hidden until
// discovered. A tile is only ever discovered by physically stepping onto
// it — no field-of-view radius, no free peek at what's nearby — and once
// revealed it stays revealed forever (player.revealedTiles only ever
// grows), classic-roguelike "explored map" style. Re-walking any already-
// revealed tile is free; stepping onto genuinely new ground costs 1
// supplies (see moveOnWorldGrid() server-side) — supplies are the cost of
// pushing the frontier outward, not of moving in general. The viewport
// fills the whole overworld screen, centered on the player and zoomable
// (more tiles visible = more of the world at once, each tile smaller), same
// visual language as the Combat tab's grid. Clicking a tile previews the
// route there (highlighted, not yet taken) and needs an explicit Confirm
// before the player actually walks it — dpad/keyboard moves stay instant,
// single-tile nudges with no confirm step.

const WORLD_DIRS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

// Each entry is how many tiles are visible at once (w x h) — more tiles
// visible = zoomed out (each individually smaller, since the viewport
// always stretches to fill the whole screen either way), fewer = zoomed in.
// Index 1 is the default, matching the original fixed 15x11 viewport size.
const WORLD_ZOOM_LEVELS = [
  { w: 9, h: 7 },
  { w: 15, h: 11 },
  { w: 21, h: 15 },
  { w: 29, h: 21 },
];
const WORLD_DEFAULT_ZOOM_INDEX = 1;

function currentWorldViewport() {
  return WORLD_ZOOM_LEVELS[state.worldZoomIndex];
}

function zoomWorldIn() {
  state.worldZoomIndex = Math.max(0, state.worldZoomIndex - 1);
  render();
}

function zoomWorldOut() {
  state.worldZoomIndex = Math.min(WORLD_ZOOM_LEVELS.length - 1, state.worldZoomIndex + 1);
  render();
}

function isWorldMoveBlocked(direction) {
  const delta = WORLD_DIRS[direction];
  const nx = state.player.worldPos.x + delta.dx;
  const ny = state.player.worldPos.y + delta.dy;
  return nx < 0 || ny < 0 || nx >= state.worldInfo.width || ny >= state.worldInfo.height;
}

// The actual network call, shared by a single dpad/keyboard step and by
// confirmWorldPath()'s walk-the-previewed-route loop. Returns whether the
// step actually happened, so a caller stepping repeatedly knows when to
// stop (out of supplies on new ground, hit the world edge, network hiccup —
// all just "false, stop").
async function worldMoveStep(direction) {
  let result;
  try {
    result = await api('/api/world/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, direction }),
    });
  } catch {
    return false;
  }
  applyPlayerSnapshot(result.player);
  return true;
}

// A direct dpad/keyboard step — instant, no confirmation, and supersedes
// any route the player had clicked out but not yet confirmed.
async function submitWorldMove(direction) {
  if (state.worldWalking || !state.player || (state.player.combat && !state.player.combat.result)) return;
  state.worldPendingPath = null;
  if (isWorldMoveBlocked(direction)) {
    const wrap = document.getElementById('world-grid-wrap');
    if (wrap) {
      wrap.classList.add('blocked-shake');
      setTimeout(() => wrap.classList.remove('blocked-shake'), 250);
    }
    render();
    return;
  }
  const supplies = state.player.inventory.find((i) => i.id === 'supplies');
  const revealed = new Set(state.player.revealedTiles);
  const delta = WORLD_DIRS[direction];
  const destKey = `${state.player.worldPos.x + delta.dx},${state.player.worldPos.y + delta.dy}`;
  if (!revealed.has(destKey) && (!supplies || supplies.count <= 0)) {
    showToast("Out of supplies — you can't push into new ground until you find or buy more.");
    return;
  }
  await worldMoveStep(direction);
}

// No pathfinding needed (unlike a dungeon room, the overworld has no
// walls) — a simple greedy axis-priority walk always reaches any tile in
// view, one step per array entry, in the order they'll actually be walked.
function computeWorldPath(targetX, targetY) {
  const path = [];
  let cx = state.player.worldPos.x;
  let cy = state.player.worldPos.y;
  let guard = 0;
  while ((cx !== targetX || cy !== targetY) && guard < 2000) {
    guard++;
    const dx = targetX - cx;
    const dy = targetY - cy;
    if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) cx += Math.sign(dx);
    else if (dy !== 0) cy += Math.sign(dy);
    else break;
    path.push({ x: cx, y: cy });
  }
  return path;
}

// Clicking a tile in view only plans the route — it doesn't move anyone.
// The path stays highlighted on the grid until the player explicitly
// confirms or cancels it (see confirmWorldPath()/cancelWorldPath()).
function previewWorldPath(targetX, targetY) {
  if (state.worldWalking || !state.player || (state.player.combat && !state.player.combat.result)) return;
  state.worldPendingPath = computeWorldPath(targetX, targetY);
  render();
}

function cancelWorldPath() {
  state.worldPendingPath = null;
  render();
}

// Walks the exact previewed route, one server-authoritative step at a time
// — not recomputed mid-walk, so what was shown is what actually happens.
// Stops early (banking whatever already happened) if a step fails, e.g.
// supplies ran out partway into new territory.
async function confirmWorldPath() {
  const path = state.worldPendingPath;
  if (!path || path.length === 0 || state.worldWalking) return;
  state.worldPendingPath = null;
  state.worldWalking = true;
  render();
  try {
    let prev = state.player.worldPos;
    for (const step of path) {
      const dir = step.x > prev.x ? 'right' : step.x < prev.x ? 'left' : step.y > prev.y ? 'down' : 'up';
      const moved = await worldMoveStep(dir);
      if (!moved) break;
      prev = step;
      await sleep(150);
    }
  } finally {
    state.worldWalking = false;
    render();
  }
}

function worldViewportOrigin() {
  const { width, height } = state.worldInfo;
  const { w: vw, h: vh } = currentWorldViewport();
  const pos = state.player.worldPos;
  let ox = pos.x - Math.floor(vw / 2);
  let oy = pos.y - Math.floor(vh / 2);
  ox = Math.max(0, Math.min(Math.max(0, width - vw), ox));
  oy = Math.max(0, Math.min(Math.max(0, height - vh), oy));
  return { ox, oy };
}

function locationGridIcon(loc) {
  if (loc.tavern) return '🍺';
  if (loc.combat) return '⚔️';
  if (loc.skill) return '⛏️';
  return '📍';
}

// Rebuilt fresh every render (cheap — at most a few hundred tiles). A tile
// the player has never physically stepped onto renders as blank fog — no
// floor, no icon, indistinguishable from any other unexplored tile even if
// a location secretly sits there. Once revealed, a tile stays revealed
// forever, so walking away doesn't re-hide anything.
function renderWorldGrid() {
  const gridDiv = document.getElementById('world-grid');
  if (!state.worldInfo.width) return; // /api/world-info hasn't landed yet
  const { w: vw, h: vh } = currentWorldViewport();
  const { ox, oy } = worldViewportOrigin();
  gridDiv.innerHTML = '';
  gridDiv.style.gridTemplateColumns = `repeat(${vw}, 1fr)`;
  gridDiv.style.gridTemplateRows = `repeat(${vh}, 1fr)`;

  const revealed = new Set(state.player.revealedTiles);
  const locByCell = {};
  for (const loc of state.locations) {
    if (!state.player.discoveries.includes(loc.id)) continue;
    if (loc.x < ox || loc.x >= ox + vw || loc.y < oy || loc.y >= oy + vh) continue;
    locByCell[`${loc.x},${loc.y}`] = loc;
  }
  const othersByCell = {};
  for (const other of state.others) {
    const loc = state.locations.find((l) => l.id === other.locationId);
    if (!loc) continue;
    const key = `${loc.x},${loc.y}`;
    (othersByCell[key] = othersByCell[key] || []).push(other);
  }
  const pathByCell = {};
  const pendingPath = state.worldPendingPath || [];
  pendingPath.forEach((step, i) => {
    pathByCell[`${step.x},${step.y}`] = i === pendingPath.length - 1 ? 'end' : 'mid';
  });

  for (let y = oy; y < oy + vh; y++) {
    for (let x = ox; x < ox + vw; x++) {
      const cell = document.createElement('div');
      cell.dataset.x = x;
      cell.dataset.y = y;
      const isPlayer = state.player.worldPos.x === x && state.player.worldPos.y === y;
      const isRevealed = isPlayer || revealed.has(`${x},${y}`);
      cell.className = 'grid-cell ' + (isRevealed ? 'world-floor' : 'world-fog');
      const loc = locByCell[`${x},${y}`];
      if (isPlayer) {
        cell.classList.add('grid-player');
        cell.textContent = '@';
        cell.title = loc ? loc.name : 'You';
      } else if (isRevealed && loc) {
        cell.classList.add('world-location');
        cell.textContent = locationGridIcon(loc);
        cell.title = loc.name;
      }
      if (!isPlayer && othersByCell[`${x},${y}`]) {
        cell.classList.add('world-has-others');
      }
      const pathState = pathByCell[`${x},${y}`];
      if (pathState === 'mid') cell.classList.add('world-path');
      else if (pathState === 'end') cell.classList.add('world-path-end');
      if (!isPlayer) {
        cell.addEventListener('click', () => previewWorldPath(x, y));
      }
      gridDiv.appendChild(cell);
    }
  }
}

function renderOverworldTab() {
  const loc = state.locations.find((l) => l.id === state.player.currentLocation);
  document.getElementById('current-location').textContent = `Location: ${
    loc ? loc.name : state.player.currentLocation ? '--' : 'the wilds'
  }`;

  const supplies = state.player.inventory.find((i) => i.id === 'supplies');
  const suppliesCount = supplies ? supplies.count : 0;
  document.getElementById('supplies-info').textContent = `Supplies: ${suppliesCount}`;

  const inCombat = !!(state.player.combat && !state.player.combat.result);
  const pendingPath = state.worldPendingPath;
  document.getElementById('world-message-line').textContent = inCombat
    ? 'Finish or flee your fight before moving.'
    : state.worldWalking
      ? 'Walking...'
      : pendingPath
        ? ''
        : "Click a tile to plan a route, or use the arrows. Re-walking known ground is free — only new ground costs supplies.";

  const pathControls = document.getElementById('world-path-controls');
  if (pendingPath && pendingPath.length > 0 && !state.worldWalking && !inCombat) {
    pathControls.classList.remove('hidden');
    const revealed = new Set(state.player.revealedTiles);
    const newTiles = pendingPath.filter((t) => !revealed.has(`${t.x},${t.y}`)).length;
    document.getElementById('world-path-status').textContent =
      `Route: ${pendingPath.length} tile${pendingPath.length === 1 ? '' : 's'}` +
      (newTiles > 0 ? ` (${newTiles} new — costs ${newTiles} supplies)` : ' (all known ground — free)');
    document.getElementById('world-confirm-btn').disabled = newTiles > suppliesCount;
  } else {
    pathControls.classList.add('hidden');
  }

  const disabled = state.worldWalking || inCombat;
  for (const btn of document.querySelectorAll('.dpad-btn[data-wdir]')) btn.disabled = disabled;

  renderWorldGrid();
}

// --- skills tab ---
// Only Woodcutting lives here — Mining and Fishing each got promoted to
// their own top-level tab (more room for the node grid), and Hunting/
// Scavenging/Harvesting live in the Overworld sidebar's Gather panel.
// Combat has no card here — it's leveled by xp like any skill but isn't a
// node-based task, and its UI lives entirely in the Combat tab.

function buildSkillsTab() {
  const container = document.getElementById('skills-container');
  container.innerHTML = `
    <div class="skill-card">
      <h3>Woodcutting</h3>
      <div class="task-row">
        <canvas id="woodcutting-clock" class="task-clock" width="70" height="70"></canvas>
        <div class="task-info">
          <div class="bar-wrap"><div id="woodcutting-bar-fill" class="bar-fill"></div></div>
          <div id="woodcutting-label" class="skill-label"></div>
        </div>
      </div>
      <div id="woodcutting-grid" class="mining-grid mining-grid-compact"></div>
    </div>
  `;
}

// The minigame is just a bonus on top of the passive fishing clock. The
// server is the one that decides if the click actually landed in the real
// bite window — the client's own timer is only used to decide when to let
// the player try.
async function attemptFishingCatch() {
  let result;
  try {
    result = await post('/api/fishing/catch', { playerId: state.playerId });
  } catch {
    return;
  }
  if (result.success) {
    showToast(`Bonus catch! +${result.amount} ${result.itemName}, +${result.xp} xp`);
  } else if (result.reason === 'missed') {
    showToast('Missed the bite!');
  } else if (result.reason === 'already_attempted') {
    showToast('Already tried this bite — wait for the next one.');
  }
  await refreshMe();
}

// --- shared rendering for all 6 gathering skills ---
// Every node is workable no matter where the player is, once its location
// is discovered; each skill's starting camp node is always unlocked.
// Mining and Fishing get their own full tab with a big "currently working
// X" panel; Woodcutting, Hunting, Scavenging, and Harvesting use a smaller
// compact version (just the clock, bar, and grid) since they share space
// with other UI. opts: { gridId, barFillId, labelId, activePanelId?, activeNameId? }
function renderNodeSkill(skillId, opts) {
  const nodes = state.player[`${skillId}Nodes`];
  const skill = state.player.skills[skillId];
  const deterministic = DETERMINISTIC_SKILL_IDS.has(skillId);
  const activeNode = nodes.find((n) => n.active);

  if (opts.activePanelId) {
    const panel = document.getElementById(opts.activePanelId);
    if (activeNode) {
      panel.classList.remove('hidden');
      document.getElementById(opts.activeNameId).textContent = `${SKILL_DISPLAY_NAMES[skillId]}: ${activeNode.name}`;
    } else {
      panel.classList.add('hidden');
    }
  }

  const barFill = document.getElementById(opts.barFillId);
  const label = document.getElementById(opts.labelId);
  if (barFill && label) {
    barFill.style.width = `${(skill.xpIntoLevel / skill.xpToNextLevel) * 100}%`;
    let status;
    if (!activeNode) {
      status = 'idle — select a spot below';
    } else if (deterministic) {
      status = `yields ${activeNode.itemName} every ${activeNode.cycleSeconds}s`;
    } else {
      status = `working — chance of ${activeNode.resultItemNames.join(' / ')} every ${activeNode.cycleSeconds}s`;
    }
    label.textContent = `Lvl ${skill.level} — ${skill.xpIntoLevel} / ${skill.xpToNextLevel} xp — ${status}`;
  }

  const grid = document.getElementById(opts.gridId);
  if (!grid) return;
  grid.innerHTML = '';
  for (const node of nodes) {
    grid.appendChild(renderNodeTile(skillId, node, deterministic));
  }
}

function renderNodeTile(skillId, node, deterministic) {
  const tile = document.createElement('div');
  tile.className = 'mining-node-tile';
  if (!node.unlocked) {
    tile.classList.add('locked');
    tile.title = `${node.name}: locked — discover ${node.locationName} on the Overworld map to unlock.`;
    tile.innerHTML = `<span class="mining-node-icon">🔒</span><span class="mining-node-label">${node.name}</span>`;
    return tile;
  }
  const yieldLabel = deterministic ? node.itemName : node.resultItemNames.join(' / ');
  tile.classList.toggle('active', node.active);
  tile.title = node.active
    ? `${node.name}: working now — click to stop`
    : `${node.name}: click to start (yields ${yieldLabel})`;
  tile.innerHTML = `<span class="mining-node-icon">${deterministic ? '⛏️' : '🎯'}</span><span class="mining-node-label">${node.name}</span><span class="mining-node-sub">${yieldLabel}</span>`;
  tile.addEventListener('click', () => onNodeTileClick(skillId, node));
  return tile;
}

async function onNodeTileClick(skillId, node) {
  try {
    if (node.active) {
      await post('/api/task/stop', { playerId: state.playerId, skillId });
    } else {
      await post('/api/task/start', { playerId: state.playerId, skillId, nodeId: node.id });
    }
  } catch {
    return;
  }
  await refreshMe();
}

function renderAllNodeSkills() {
  renderNodeSkill('mining', {
    activePanelId: 'mining-active-panel',
    activeNameId: 'mining-active-name',
    barFillId: 'mining-bar-fill',
    labelId: 'mining-label',
    gridId: 'mining-grid',
  });
  renderNodeSkill('fishing', {
    activePanelId: 'fishing-active-panel',
    activeNameId: 'fishing-active-name',
    barFillId: 'fishing-bar-fill',
    labelId: 'fishing-label',
    gridId: 'fishing-grid',
  });
  renderNodeSkill('woodcutting', { barFillId: 'woodcutting-bar-fill', labelId: 'woodcutting-label', gridId: 'woodcutting-grid' });
  renderNodeSkill('hunting', { barFillId: 'hunting-bar-fill', labelId: 'hunting-label', gridId: 'hunting-grid' });
  renderNodeSkill('scavenging', { barFillId: 'scavenging-bar-fill', labelId: 'scavenging-label', gridId: 'scavenging-grid' });
  renderNodeSkill('harvesting', { barFillId: 'harvesting-bar-fill', labelId: 'harvesting-label', gridId: 'harvesting-grid' });
}

// --- inventory tab ---

function renderInventoryTab() {
  const grid = document.getElementById('inventory-grid');
  grid.innerHTML = '';
  if (state.player.inventory.length === 0) {
    grid.innerHTML = '<div class="card">Empty.</div>';
    return;
  }
  for (const item of state.player.inventory) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${item.name}</h3><div class="card-sub">Quantity: ${item.count}</div>`;
    grid.appendChild(card);
  }
}

// --- equipment tab ---

function renderEquipmentTab() {
  const equip = state.player.equipment;
  document.getElementById('equipped-weapon').textContent = equip.weapon ? equip.weapon.name : 'None';
  document.getElementById('equipped-armor').textContent = equip.armor ? equip.armor.name : 'None';
  document.getElementById('unequip-weapon-btn').disabled = !equip.weapon;
  document.getElementById('unequip-armor-btn').disabled = !equip.armor;

  const s = equip.stats;
  const effectLine = s.effect
    ? ` &nbsp; Effect: ${s.effect.type} (${Math.round(s.effect.chance * 100)}% chance, ${s.effect.dps}/s for ${s.effect.duration}s)`
    : '';
  document.getElementById('combat-stats-display').innerHTML = `
    <strong>Combat stats</strong><br>
    Damage: ${s.damage[0]}-${s.damage[1]} &nbsp; Crit: ${Math.round(s.critChance * 100)}% &nbsp; Attack speed: ${s.attackSpeed}s<br>
    Armor: ${s.armor}${effectLine}
  `;

  const list = document.getElementById('equippable-list');
  list.innerHTML = '';
  const equippable = state.player.inventory.filter((i) => {
    const meta = state.itemsMeta[i.id];
    return meta && (meta.type === 'weapon' || meta.type === 'armor');
  });
  if (equippable.length === 0) {
    list.innerHTML = '<div class="card">Nothing equippable in inventory.</div>';
    return;
  }
  for (const item of equippable) {
    const meta = state.itemsMeta[item.id];
    const statsLine =
      meta.type === 'weapon'
        ? `Dmg ${meta.damage[0]}-${meta.damage[1]}, Crit ${Math.round(meta.critChance * 100)}%, Speed ${meta.attackSpeed}s`
        : `Armor ${meta.armor}`;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${item.name} (x${item.count})</h3><div class="card-sub">${statsLine}</div><button data-item="${item.id}">Equip</button>`;
    list.appendChild(card);
  }
  list.querySelectorAll('button[data-item]').forEach((btn) => {
    btn.addEventListener('click', () => equipItem(btn.dataset.item));
  });
}

async function equipItem(itemId) {
  try {
    await post('/api/equip', { playerId: state.playerId, itemId });
  } catch {
    return;
  }
  await refreshMe();
}

async function unequipSlot(slot) {
  try {
    await post('/api/unequip', { playerId: state.playerId, slot });
  } catch {
    return;
  }
  await refreshMe();
}

// --- character tab (traits + perk tree) ---
// Character-level xp is a separate pool from every skill's xp, earned from
// discovering new locations (see gainCharacterXp() in store.js). Each
// character level grants one trait point and one perk point.

function renderCharacterTab() {
  const ch = state.player.character;
  document.getElementById('character-level-info').textContent =
    `Level ${ch.level} — ${ch.xpIntoLevel} / ${ch.xpToNextLevel} xp — Trait points: ${state.player.traitPointsAvailable} — Perk points: ${state.player.perkPoints}`;
  document.getElementById('character-xp-fill').style.width = `${(ch.xpIntoLevel / ch.xpToNextLevel) * 100}%`;

  const traitsList = document.getElementById('traits-list');
  traitsList.innerHTML = '';
  for (const [key, value] of Object.entries(state.player.traits)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${TRAIT_DISPLAY_NAMES[key]}: ${value}</h3><div class="card-sub">${TRAIT_DESCRIPTIONS[key]}</div><button data-alloc-trait="${key}" ${state.player.traitPointsAvailable > 0 ? '' : 'disabled'}>+1 (spend a trait point)</button>`;
    traitsList.appendChild(card);
  }
  traitsList.querySelectorAll('button[data-alloc-trait]').forEach((btn) => {
    btn.addEventListener('click', () => allocateTrait(btn.dataset.allocTrait));
  });

  document.getElementById('perk-points-info').textContent = `Perk points available: ${state.player.perkPoints}`;

  const tree = document.getElementById('perk-tree');
  tree.innerHTML = '';
  const tiers = [...new Set(state.player.perks.map((p) => p.tier))].sort((a, b) => a - b);
  for (const tier of tiers) {
    const tierPerks = state.player.perks.filter((p) => p.tier === tier);
    const section = document.createElement('div');
    section.className = 'perk-tier';
    section.innerHTML = `<h3>Tier ${tier} &mdash; requires character level ${tierPerks[0].requiresLevel}</h3>`;
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    for (const perk of tierPerks) {
      const card = document.createElement('div');
      card.className = 'card' + (perk.unlocked ? ' perk-unlocked' : !perk.levelMet ? ' perk-locked' : '');
      const canAfford = state.player.perkPoints >= perk.cost;
      let buttonHtml = '';
      if (perk.unlocked) {
        buttonHtml = `<div class="card-sub">Unlocked</div>`;
      } else if (!perk.levelMet) {
        buttonHtml = `<div class="card-sub">🔒 Requires character level ${perk.requiresLevel}</div>`;
      } else {
        buttonHtml = `<button data-unlock-perk="${perk.id}" ${canAfford ? '' : 'disabled'}>Unlock (${perk.cost} pt)</button>`;
      }
      card.innerHTML = `<h3>${perk.name}</h3><div class="card-sub">${perk.description}</div>${buttonHtml}`;
      grid.appendChild(card);
    }
    section.appendChild(grid);
    tree.appendChild(section);
  }
  tree.querySelectorAll('button[data-unlock-perk]').forEach((btn) => {
    btn.addEventListener('click', () => unlockPerkUI(btn.dataset.unlockPerk));
  });
}

async function allocateTrait(traitName) {
  try {
    await post('/api/trait/allocate', { playerId: state.playerId, trait: traitName });
  } catch {
    return;
  }
  showToast(`${TRAIT_DISPLAY_NAMES[traitName]} increased!`);
  await refreshMe();
}

async function unlockPerkUI(perkId) {
  let result;
  try {
    result = await post('/api/perk/unlock', { playerId: state.playerId, perkId });
  } catch {
    return;
  }
  showToast(`Perk unlocked: ${state.perksMeta[result.perkId].name}!`);
  await refreshMe();
}

// --- combat tab ---
//
// Classic-Roguelike grid combat: the player and every enemy share a small
// room. Moving into an empty tile just moves; moving into a tile an enemy
// occupies attacks it instead ("bump to attack"); using a potion is the
// only other legal turn. Each turn is one server round-trip that resolves
// the whole exchange (player's move/attack/item, then every living enemy's
// response) and returns it as a single-turn log plus the fresh player
// state — see playCombatRound() below for how that's shown on screen.

const ENEMY_ICONS = {
  giant_rat: '🐀',
  wolf: '🐺',
  bog_zombie: '🧟',
  bandit: '🥷',
  forest_spider: '🕷️',
  forest_archer: '🏹',
  marsh_wraith: '👻',
  orc_raider: '👹',
  stone_troll: '🗿',
};

const COMBAT_DIRS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FLOATING_NUMBER_MS = 1000; // how long a damage/heal number stays visible before fading out
const HIT_FLASH_MS = 450; // how long a hit's flash/shake + floating number gets to read before the next turn can submit

function spawnFloatingNumber(container, text, kind) {
  if (!container) return;
  const el = document.createElement('div');
  el.className = `floating-number ${kind}`;
  el.textContent = text;
  container.appendChild(el);
  setTimeout(() => el.remove(), FLOATING_NUMBER_MS);
}

function gridCellEl(x, y) {
  return document.querySelector(`#combat-grid .grid-cell[data-x="${x}"][data-y="${y}"]`);
}

// Rebuilds the whole grid from scratch every render — cheap given it's at
// most 9x7 tiles and only re-renders on real state changes, not every
// frame. Dead enemies simply don't get drawn (their tile just shows as
// floor), matching how a defeated monster would vanish in Rogue.
function renderCombatGrid(c) {
  const gridDiv = document.getElementById('combat-grid');
  gridDiv.innerHTML = '';
  gridDiv.style.gridTemplateColumns = `repeat(${c.grid.width}, 1fr)`;
  gridDiv.style.gridTemplateRows = `repeat(${c.grid.height}, 1fr)`;
  const wallSet = new Set(c.grid.walls.map((w) => `${w.x},${w.y}`));
  for (let y = 0; y < c.grid.height; y++) {
    for (let x = 0; x < c.grid.width; x++) {
      const cell = document.createElement('div');
      cell.dataset.x = x;
      cell.dataset.y = y;
      const wall = wallSet.has(`${x},${y}`);
      cell.className = 'grid-cell' + (wall ? ' wall' : ' floor');
      if (!wall) {
        if (c.playerPos.x === x && c.playerPos.y === y) {
          cell.classList.add('grid-player');
          cell.textContent = '@';
        } else {
          const enemy = c.enemies.find((e) => e.hp > 0 && e.x === x && e.y === y);
          if (enemy) {
            cell.classList.add('grid-enemy');
            cell.dataset.uid = enemy.uid;
            cell.textContent = ENEMY_ICONS[enemy.enemyId] || '?';
          }
        }
      }
      gridDiv.appendChild(cell);
    }
  }
}

// A compact HP list beside the grid — the grid glyphs alone don't show
// numbers, so this is where "how much HP does that wolf have left" actually
// comes from.
function renderEnemyHpList(c) {
  const listDiv = document.getElementById('combat-enemy-hp-list');
  listDiv.innerHTML = '';
  for (const e of c.enemies) {
    if (e.hp <= 0) continue;
    const row = document.createElement('div');
    row.className = 'enemy-hp-row';
    row.innerHTML = `
      <span class="enemy-hp-name">${ENEMY_ICONS[e.enemyId] || ''} ${e.name}</span>
      <div class="hp-bar-wrap small"><div class="hp-bar-fill enemy" style="width:${(e.hp / e.maxHp) * 100}%"></div></div>
      <span class="enemy-hp-num">${e.hp}/${e.maxHp}</span>
      ${e.dot ? `<span class="effect-label">Afflicted: ${e.dot.type}</span>` : ''}
    `;
    listDiv.appendChild(row);
  }
}

function renderCombatTab() {
  const idleDiv = document.getElementById('combat-idle');
  const activeDiv = document.getElementById('combat-active');

  if (state.player.combat) {
    idleDiv.classList.add('hidden');
    activeDiv.classList.remove('hidden');
    const c = state.player.combat;

    document.getElementById('player-hp-fill').style.width = `${(c.playerHp / c.playerMaxHp) * 100}%`;
    document.getElementById('player-hp-label').textContent = `${c.playerHp} / ${c.playerMaxHp} HP`;
    document.getElementById('player-status-line').textContent = [
      c.dotOnPlayer ? `Afflicted: ${c.dotOnPlayer.type}` : '',
      c.buff ? `Buffed: ${c.buff.type}` : '',
    ]
      .filter(Boolean)
      .join(' | ');

    renderCombatGrid(c);
    renderEnemyHpList(c);
    document.getElementById('combat-message-line').textContent =
      c.lastPlayerActionText || (c.ambush ? 'You are ambushed!' : 'Walk into an enemy to attack it.');

    // The full text log lives in a collapsed-by-default sidebar — the grid
    // and flashes are the primary way to follow a fight now, this is just
    // an opt-in detailed record for anyone who wants exact numbers/order.
    document.getElementById('combat-log-sidebar').classList.toggle('hidden', !state.combatLogSidebarOpen);
    document.getElementById('combat-log-toggle').textContent = state.combatLogSidebarOpen ? '📜 Hide Battle Log' : '📜 Battle Log';
    const logDiv = document.getElementById('combat-log');
    if (state.combatLog.length > 0) {
      logDiv.innerHTML = state.combatLog.map(roundLogHtml).join('');
    } else {
      logDiv.innerHTML = roundLogHtml({ player: c.lastPlayerActionText, enemies: c.lastEnemyActionTexts });
    }
    logDiv.scrollTop = logDiv.scrollHeight; // keep the newest turn in view

    const disabled = state.combatActionPending || !!c.result;
    for (const btn of document.querySelectorAll('.dpad-btn[data-dir]')) btn.disabled = disabled;
    document.getElementById('item-btn').disabled = disabled;

    const resultDiv = document.getElementById('combat-result');
    const fleeBtn = document.getElementById('flee-btn');
    const continueBtn = document.getElementById('combat-continue-btn');
    const dpad = document.getElementById('combat-dpad');
    const turnActions = document.getElementById('combat-turn-actions');
    const itemMenu = document.getElementById('combat-item-menu');
    if (c.result) {
      resultDiv.classList.remove('hidden');
      if (c.result === 'win') {
        const lootLine = c.rewardLoot.length > 0 ? ` (found ${c.rewardLoot.map((l) => l.name).join(', ')})` : '';
        resultDiv.textContent = `Victory! +${c.rewardGold} gold${lootLine}`;
      } else {
        resultDiv.textContent = 'Defeated...';
      }
      dpad.classList.add('hidden');
      turnActions.classList.add('hidden');
      itemMenu.classList.add('hidden');
      continueBtn.classList.remove('hidden');
    } else {
      resultDiv.classList.add('hidden');
      dpad.classList.remove('hidden');
      turnActions.classList.remove('hidden');
      fleeBtn.disabled = disabled;
      continueBtn.classList.add('hidden');
      if (state.combatItemMenuOpen) {
        renderCombatItemMenu(disabled);
        itemMenu.classList.remove('hidden');
      } else {
        itemMenu.classList.add('hidden');
      }
    }
  } else {
    idleDiv.classList.remove('hidden');
    activeDiv.classList.add('hidden');
    const loc = state.locations.find((l) => l.id === state.player.currentLocation);
    document.getElementById('combat-location-info').textContent = `Location: ${loc ? loc.name : '--'}`;

    const listDiv = document.getElementById('combat-enemy-list');
    listDiv.innerHTML = '';
    // The pickable roster comes from the location's tier (see
    // /api/world-tiers), not a fixed per-location list — the dungeon,
    // exact enemy mix, and loot are all randomized by area every fight.
    const tierEnemies = loc && loc.combat ? (state.worldTiers[loc.tier] || {}).enemies || [] : [];
    if (tierEnemies.length > 0) {
      for (const enemyId of tierEnemies) {
        const meta = state.enemiesMeta[enemyId];
        const btn = document.createElement('button');
        btn.className = 'enemy-btn';
        btn.innerHTML = `<span class="enemy-icon">${ENEMY_ICONS[enemyId] || '❔'}</span><strong>${meta.name}</strong><br>${meta.maxHp} HP`;
        btn.addEventListener('click', () => startFight(enemyId));
        listDiv.appendChild(btn);
      }
      const hint = document.createElement('p');
      hint.className = 'card-sub';
      hint.textContent = 'Sometimes 2-3 enemies from this area will join the fight together, and the dungeon layout and loot vary every time.';
      listDiv.appendChild(hint);
    } else {
      listDiv.innerHTML = '<p>No enemies here. Explore to find a combat area.</p>';
    }
  }
}

function roundLogHtml(r) {
  const enemyLines = (r.enemies || []).filter(Boolean).map((t) => `<div class="log-enemy">${t}</div>`).join('');
  const playerLine = r.player ? `<div class="log-player">${r.player}</div>` : '';
  if (!playerLine && !enemyLines) return '';
  return `<div class="log-round">${playerLine}${enemyLines}</div>`;
}

function renderCombatItemMenu(disabled) {
  const container = document.getElementById('combat-item-menu');
  container.innerHTML = '';
  const backBtn = document.createElement('button');
  backBtn.className = 'item-menu-btn';
  backBtn.textContent = '← Back';
  backBtn.addEventListener('click', () => {
    state.combatItemMenuOpen = false;
    renderCombatTab();
  });
  container.appendChild(backBtn);

  const ownedPotions = state.player.inventory.filter((i) => state.itemsMeta[i.id] && state.itemsMeta[i.id].type === 'potion');
  if (ownedPotions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'card-sub';
    empty.textContent = "You aren't carrying any usable potions.";
    container.appendChild(empty);
    return;
  }
  for (const potion of ownedPotions) {
    const meta = state.itemsMeta[potion.id];
    const btn = document.createElement('button');
    btn.className = 'item-menu-btn';
    btn.disabled = disabled;
    btn.textContent = `${meta.name} (${potion.count})`;
    if (!disabled) btn.addEventListener('click', () => submitCombatItem(potion.id));
    container.appendChild(btn);
  }
}

// Shows the already-resolved (server-authoritative) turn's effects as a
// brief flash + floating number on the grid, then settles on the final
// state — much lighter-weight than the old FF-style multi-second staged
// playback, since a grid bump-attack is a single instant event rather than
// a queue of abilities landing on a lined-up row of enemies. Renders the
// final positions/HP first (so the grid is already correct), then animates
// on top of it — the target of a kill still gets its flash even though its
// glyph itself has already disappeared, since every tile always has a cell
// element to animate regardless of what's currently drawn on it.
async function playCombatRound(round, finalPlayer) {
  state.combatLog.push(round);
  state.player = finalPlayer;
  renderCombatTab();

  let animated = false;
  if (round.playerHit) {
    const hit = round.playerHit;
    if (hit.type === 'damage' || hit.type === 'debuff') {
      const pos = round.enemyPositions.find((e) => e.uid === hit.targetUid);
      const cell = pos ? gridCellEl(pos.x, pos.y) : null;
      if (cell) {
        animated = true;
        if (hit.type === 'damage') {
          cell.classList.add('hit-flash');
          spawnFloatingNumber(cell, hit.crit ? `-${hit.amount}!` : `-${hit.amount}`, hit.crit ? 'damage crit' : 'damage');
        } else {
          spawnFloatingNumber(cell, 'Poisoned!', 'miss');
        }
      }
    } else if (hit.type === 'heal') {
      const cell = gridCellEl(round.playerPos.x, round.playerPos.y);
      if (cell) {
        animated = true;
        spawnFloatingNumber(cell, `+${hit.amount}`, 'heal');
      }
    }
  }

  const playerCell = gridCellEl(round.playerPos.x, round.playerPos.y);
  for (const hit of round.enemyHits || []) {
    if (!playerCell) continue;
    animated = true;
    if (hit.type === 'dodged') {
      spawnFloatingNumber(playerCell, 'Dodged!', 'miss');
    } else {
      playerCell.classList.add('hit-shake');
      spawnFloatingNumber(playerCell, hit.crit ? `-${hit.amount}!` : `-${hit.amount}`, hit.crit ? 'damage crit' : 'damage');
    }
  }

  if (animated) await sleep(HIT_FLASH_MS);
}

// Bumping into a wall or the grid edge is checked client-side against data
// the player already has (state.player.combat.grid) so it never round-trips
// to the server at all — it's not a real action, just an invalid input, and
// should feel instant rather than surfacing a scary "Error: blocked" banner
// for something as routine as misjudging a corner.
function isCombatMoveBlocked(direction) {
  const c = state.player.combat;
  const delta = COMBAT_DIRS[direction];
  const nx = c.playerPos.x + delta.dx;
  const ny = c.playerPos.y + delta.dy;
  if (nx < 0 || ny < 0 || nx >= c.grid.width || ny >= c.grid.height) return true;
  return c.grid.walls.some((w) => w.x === nx && w.y === ny);
}

async function submitCombatMove(direction) {
  if (state.combatActionPending || !state.player.combat || state.player.combat.result) return;
  if (isCombatMoveBlocked(direction)) {
    const wrap = document.getElementById('combat-grid-wrap');
    if (wrap) {
      wrap.classList.add('blocked-shake');
      setTimeout(() => wrap.classList.remove('blocked-shake'), 250);
    }
    return;
  }
  state.combatActionPending = true;
  state.combatItemMenuOpen = false;
  renderCombatTab(); // immediately grey out the controls so a slow response can't be double-submitted
  let result;
  try {
    result = await api('/api/combat/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, direction }),
    });
  } catch {
    state.combatActionPending = false;
    renderCombatTab();
    return;
  }
  state.combatActionPending = false;
  await playCombatRound(result.log[0], result.player);
}

async function submitCombatItem(itemId) {
  if (state.combatActionPending) return;
  state.combatActionPending = true;
  renderCombatTab();
  let result;
  try {
    result = await api('/api/combat/item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, itemId }),
    });
  } catch {
    state.combatActionPending = false;
    renderCombatTab();
    return;
  }
  state.combatActionPending = false;
  state.combatItemMenuOpen = false;
  await playCombatRound(result.log[0], result.player);
}

async function startFight(enemyId) {
  try {
    await post('/api/combat/start', { playerId: state.playerId, enemyId });
  } catch {
    return;
  }
  state.combatLog = [];
  state.combatItemMenuOpen = false;
  await refreshMe();
}

async function endCombat() {
  try {
    await post('/api/combat/end', { playerId: state.playerId });
  } catch {
    return;
  }
  state.combatLog = [];
  state.combatItemMenuOpen = false;
  await refreshMe();
}

// --- gardening tab ---

// Pick-a-seed-once-then-click-many-plots flow: state.selectedSeed stays set
// across plantings (instead of the old design that reopened a per-plot
// modal every time) so planting a full row is one seed selection + N plot
// clicks instead of N modal round-trips.
function renderGardeningTab() {
  // auto-clear the selection if the player just ran out of that seed —
  // state.selectedSeed holds a PLANT id (e.g. 'carrot'), but inventory is
  // keyed by the SEED item id (e.g. 'carrot_seed'), so look it up via
  // plantsMeta rather than comparing directly against inventory ids.
  if (state.selectedSeed) {
    const plant = state.plantsMeta[state.selectedSeed];
    const owned = plant && state.player.inventory.find((i) => i.id === plant.seed);
    if (!owned || owned.count <= 0) state.selectedSeed = null;
  }

  const pickerDiv = document.getElementById('garden-seed-picker');
  pickerDiv.innerHTML = '';
  for (const [plantId, plant] of Object.entries(state.plantsMeta)) {
    const owned = state.player.inventory.find((i) => i.id === plant.seed);
    const count = owned ? owned.count : 0;
    const btn = document.createElement('button');
    btn.className = 'plant-option-btn';
    btn.classList.toggle('active', state.selectedSeed === plantId);
    btn.disabled = count <= 0;
    btn.textContent = `${plant.name} (${count} seeds)`;
    btn.addEventListener('click', () => {
      state.selectedSeed = state.selectedSeed === plantId ? null : plantId;
      renderGardeningTab();
    });
    pickerDiv.appendChild(btn);
  }
  document.getElementById('garden-seed-status').textContent = state.selectedSeed
    ? `Planting ${state.plantsMeta[state.selectedSeed].name} — click empty plots to plant, click the seed again to stop.`
    : 'Select a seed above, then click empty plots to plant it.';

  const container = document.getElementById('garden-plots');
  container.innerHTML = '';
  state.player.garden.plots.forEach((plot, index) => {
    const tile = document.createElement('div');
    tile.className = 'garden-plot-tile';
    if (!plot) {
      tile.title = state.selectedSeed ? `Plot ${index + 1}: empty — click to plant` : `Plot ${index + 1}: empty — select a seed first`;
      tile.innerHTML = `<span class="plot-label">+</span>`;
    } else {
      const pct = Math.round(plot.progress * 100);
      tile.classList.toggle('ready', plot.ready);
      tile.title = plot.ready
        ? `${plot.plantName}: ready to harvest — click to harvest`
        : `${plot.plantName}: ${pct}% grown`;
      tile.innerHTML = `<div class="plot-fill" style="height:${pct}%"></div><span class="plot-label">${plot.plantName[0]}</span>`;
    }
    tile.addEventListener('click', () => onGardenTileClick(index, plot));
    container.appendChild(tile);
  });
}

function onGardenTileClick(plotIndex, plot) {
  if (!plot) {
    if (!state.selectedSeed) {
      showToast('Select a seed above first.');
      return;
    }
    plantSeed(plotIndex, state.selectedSeed);
  } else if (plot.ready) {
    harvestPlot(plotIndex);
  } else {
    showToast(`${plot.plantName}: ${Math.round(plot.progress * 100)}% grown`);
  }
}

async function plantSeed(plotIndex, plantId) {
  try {
    await post('/api/garden/plant', { playerId: state.playerId, plotIndex, plantId });
  } catch {
    return;
  }
  await refreshMe();
}

async function harvestPlot(plotIndex) {
  let result;
  try {
    result = await post('/api/garden/harvest', { playerId: state.playerId, plotIndex });
  } catch {
    return;
  }
  showToast(`Harvested ${state.itemsMeta[result.yield].name}!`);
  await refreshMe();
}

// --- crafting tab ---

function ownedCount(itemId) {
  return state.player.inventory.find((i) => i.id === itemId)?.count || 0;
}

function renderCraftingTab() {
  const container = document.getElementById('crafting-recipes');
  container.innerHTML = '';
  for (const recipe of state.recipesMeta) {
    const canCraft = Object.entries(recipe.ingredients).every(([itemId, amount]) => ownedCount(itemId) >= amount);
    const ingredientsLine = Object.entries(recipe.ingredients)
      .map(([itemId, amount]) => `${amount}x ${state.itemsMeta[itemId].name} (have ${ownedCount(itemId)})`)
      .join(', ');
    const resultMeta = state.itemsMeta[recipe.result];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${recipe.resultAmount}x ${resultMeta.name}</h3><div class="card-sub">Needs: ${ingredientsLine}</div><button class="craft-btn" data-craft="${recipe.id}" ${canCraft ? '' : 'disabled'}>Craft</button>`;
    container.appendChild(card);
  }
  container.querySelectorAll('button[data-craft]').forEach((btn) => {
    btn.addEventListener('click', () => craftRecipe(btn.dataset.craft));
  });
}

async function craftRecipe(recipeId) {
  let result;
  try {
    result = await post('/api/craft', { playerId: state.playerId, recipeId });
  } catch {
    return;
  }
  showToast(`Crafted ${result.resultAmount}x ${state.itemsMeta[result.result].name}!`);
  await refreshMe();
}

// --- alchemy tab ---

function ownedIngredientIds() {
  return state.player.inventory
    .filter((i) => state.itemsMeta[i.id] && state.itemsMeta[i.id].type === 'ingredient' && i.count > 0)
    .map((i) => i.id);
}

function renderAlchemyTab() {
  const selA = document.getElementById('alchemy-ingredient-a');
  const selB = document.getElementById('alchemy-ingredient-b');
  const owned = ownedIngredientIds();

  // Rebuild options only when the owned set actually changed, so an
  // in-progress selection doesn't get reset out from under the player on
  // every 2s poll.
  const optionsKey = owned.slice().sort().join(',');
  if (selA.dataset.optionsKey !== optionsKey) {
    const buildOptions = () =>
      owned.map((id) => `<option value="${id}">${state.itemsMeta[id].name} (have ${ownedCount(id)})</option>`).join('');
    selA.innerHTML = buildOptions();
    selB.innerHTML = buildOptions();
    selA.dataset.optionsKey = optionsKey;
    selB.dataset.optionsKey = optionsKey;
    if (selB.options.length > 1) selB.selectedIndex = 1;
  } else {
    // still refresh the "(have N)" counts shown in each option's label
    for (const opt of selA.options) opt.textContent = `${state.itemsMeta[opt.value].name} (have ${ownedCount(opt.value)})`;
    for (const opt of selB.options) opt.textContent = `${state.itemsMeta[opt.value].name} (have ${ownedCount(opt.value)})`;
  }

  const btn = document.getElementById('alchemy-experiment-btn');
  const haveTwoDistinct = owned.length >= 2 && selA.value && selB.value && selA.value !== selB.value;
  btn.disabled = !haveTwoDistinct;

  document.getElementById('alchemy-tried-count').textContent = `Failed combinations tried so far: ${state.player.alchemy.triedCount}`;

  const container = document.getElementById('alchemy-known-recipes');
  container.innerHTML = '';
  if (state.player.alchemy.knownRecipes.length === 0) {
    container.innerHTML = '<p>No recipes discovered yet &mdash; experiment above to find some.</p>';
  }
  for (const recipe of state.player.alchemy.knownRecipes) {
    const canCraft = recipe.ingredients.every((id) => ownedCount(id) >= 1);
    const ingredientsLine = recipe.ingredients.map((id) => `${state.itemsMeta[id].name} (have ${ownedCount(id)})`).join(', ');
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${recipe.resultName}</h3><div class="card-sub">Needs: ${ingredientsLine}</div><button class="craft-btn" data-potion-craft="${recipe.id}" ${canCraft ? '' : 'disabled'}>Craft</button>`;
    container.appendChild(card);
  }
  container.querySelectorAll('button[data-potion-craft]').forEach((btn) => {
    btn.addEventListener('click', () => craftKnownPotion(btn.dataset.potionCraft));
  });
}

async function runExperiment() {
  const ingredientA = document.getElementById('alchemy-ingredient-a').value;
  const ingredientB = document.getElementById('alchemy-ingredient-b').value;
  if (!ingredientA || !ingredientB || ingredientA === ingredientB) return;
  let result;
  try {
    result = await post('/api/alchemy/experiment', { playerId: state.playerId, ingredientA, ingredientB });
  } catch {
    return;
  }
  if (result.discovered) {
    showToast(result.newDiscovery ? `Discovered: ${result.resultName}!` : `Brewed another ${result.resultName}.`);
  } else if (result.alreadyTried) {
    showToast("You've already tried that combination.");
  } else {
    showToast('The mixture fizzles. Nothing happens.');
  }
  await refreshMe();
}

async function craftKnownPotion(recipeId) {
  let result;
  try {
    result = await post('/api/alchemy/craft', { playerId: state.playerId, recipeId });
  } catch {
    return;
  }
  showToast(`Brewed ${result.resultName}!`);
  await refreshMe();
}

// --- farming tab ---

function renderFarmingTab() {
  const buyList = document.getElementById('farm-buy-list');
  buyList.innerHTML = '';
  for (const [speciesId, species] of Object.entries(state.animalSpeciesMeta)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${species.name}</h3><div class="card-sub">${species.price} gold</div><button data-buy-animal="${speciesId}">Buy</button>`;
    buyList.appendChild(card);
  }
  buyList.querySelectorAll('button[data-buy-animal]').forEach((btn) => {
    btn.addEventListener('click', () => buyAnimal(btn.dataset.buyAnimal));
  });

  const animalsList = document.getElementById('farm-animals-list');
  animalsList.innerHTML = '';
  if (state.player.farm.animals.length === 0) {
    animalsList.innerHTML = '<div class="card">No animals yet — buy one above.</div>';
    return;
  }
  for (const animal of state.player.farm.animals) {
    const pct = Math.round(animal.progress * 100);
    const statusLine = !animal.mature
      ? `Growing: ${pct}%`
      : animal.ready
        ? animal.oneTime
          ? 'Ready to butcher!'
          : `Ready to collect ${animal.producesItemName}!`
        : `Next ${animal.producesItemName} in progress: ${pct}%`;
    const btnLabel = animal.oneTime ? 'Butcher' : 'Collect';
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${animal.speciesName}</h3><div class="card-sub">${statusLine}</div><button data-collect="${animal.id}" ${animal.ready ? '' : 'disabled'}>${btnLabel}</button>`;
    animalsList.appendChild(card);
  }
  animalsList.querySelectorAll('button[data-collect]').forEach((btn) => {
    btn.addEventListener('click', () => collectAnimal(btn.dataset.collect));
  });
}

async function buyAnimal(speciesId) {
  try {
    await post('/api/farm/buy', { playerId: state.playerId, species: speciesId });
  } catch {
    return;
  }
  showToast(`Bought a ${state.animalSpeciesMeta[speciesId].name}!`);
  await refreshMe();
}

async function collectAnimal(animalId) {
  let result;
  try {
    result = await post('/api/farm/collect', { playerId: state.playerId, animalId });
  } catch {
    return;
  }
  showToast(result.removed ? `Butchered for ${state.itemsMeta[result.item].name}!` : `Collected ${state.itemsMeta[result.item].name}!`);
  await refreshMe();
}

// --- buildings tab ---

function renderBuildingsTab() {
  const list = document.getElementById('buildings-list');
  list.innerHTML = '';
  for (const [type, config] of Object.entries(state.buildingsMeta)) {
    const built = state.player.buildings[type];
    const card = document.createElement('div');
    card.className = 'card';
    if (!built) {
      const costLine = Object.entries(config.cost)
        .map(([itemId, amount]) => `${amount}x ${state.itemsMeta[itemId].name} (have ${ownedCount(itemId)})`)
        .join(', ');
      const canBuild = Object.entries(config.cost).every(([itemId, amount]) => ownedCount(itemId) >= amount);
      card.innerHTML = `<h3>${config.name}</h3><div class="card-sub">Produces ${state.itemsMeta[config.producesItem].name} every ${config.produceIntervalSeconds}s</div><div class="card-sub">Cost: ${costLine}</div><button data-build="${type}" ${canBuild ? '' : 'disabled'}>Build</button>`;
    } else {
      const pct = Math.round(built.progress * 100);
      card.innerHTML = `<h3>${built.name}</h3><div class="card-sub">${built.pendingAmount > 0 ? `${built.pendingAmount}x ${built.producesItemName} ready` : `Next ${built.producesItemName} in progress: ${pct}%`}</div><button data-collect-building="${type}" ${built.pendingAmount > 0 ? '' : 'disabled'}>Collect</button>`;
    }
    list.appendChild(card);
  }
  list.querySelectorAll('button[data-build]').forEach((btn) => {
    btn.addEventListener('click', () => buildBuildingUI(btn.dataset.build));
  });
  list.querySelectorAll('button[data-collect-building]').forEach((btn) => {
    btn.addEventListener('click', () => collectBuildingUI(btn.dataset.collectBuilding));
  });
}

async function buildBuildingUI(buildingType) {
  try {
    await post('/api/building/build', { playerId: state.playerId, buildingType });
  } catch {
    return;
  }
  showToast(`Built ${state.buildingsMeta[buildingType].name}!`);
  await refreshMe();
}

async function collectBuildingUI(buildingType) {
  let result;
  try {
    result = await post('/api/building/collect', { playerId: state.playerId, buildingType });
  } catch {
    return;
  }
  showToast(`Collected ${result.amount}x ${state.itemsMeta[result.item].name}!`);
  await refreshMe();
}

// --- NPCs / dialogue / quests tab ---

function renderNpcsTab() {
  const loc = state.locations.find((l) => l.id === state.player.currentLocation);
  document.getElementById('npc-location-info').textContent = `Location: ${loc ? loc.name : '--'}`;
  const list = document.getElementById('npc-list');
  list.innerHTML = '';
  const here = state.npcsMeta.filter((n) => n.locationId === state.player.currentLocation);
  if (here.length === 0) {
    list.innerHTML = '<div class="card">No one here to talk to.</div>';
    return;
  }
  for (const npc of here) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${npc.name}</h3><button data-talk="${npc.id}">Talk</button>`;
    list.appendChild(card);
  }
  list.querySelectorAll('button[data-talk]').forEach((btn) => {
    btn.addEventListener('click', () => openDialogue(btn.dataset.talk));
  });
}

function openDialogue(npcId) {
  const npc = state.npcsMeta.find((n) => n.id === npcId);
  state.dialogue = { npcId, nodeId: npc.dialogueTreeId };
  document.getElementById('dialogue-npc-name').textContent = npc.name;
  document.getElementById('dialogue-modal').classList.remove('hidden');
  renderDialogueNode();
}

function renderDialogueNode() {
  const node = state.dialogueTreesMeta[state.dialogue.nodeId];
  document.getElementById('dialogue-text').textContent = node.text;
  const optionsDiv = document.getElementById('dialogue-options');
  optionsDiv.innerHTML = '';
  for (const opt of node.options) {
    const btn = document.createElement('button');
    btn.className = 'plant-option-btn';
    btn.textContent = opt.text;
    btn.addEventListener('click', () => {
      if (opt.next) {
        state.dialogue.nodeId = opt.next;
        renderDialogueNode();
      } else {
        closeDialogue();
      }
    });
    optionsDiv.appendChild(btn);
  }
  renderDialogueQuestPanel();
}

function renderDialogueQuestPanel() {
  const npc = state.npcsMeta.find((n) => n.id === state.dialogue.npcId);
  const panel = document.getElementById('dialogue-quest-panel');
  if (!npc.questId) {
    panel.classList.add('hidden');
    return;
  }
  const quest = state.questsMeta[npc.questId];
  const completed = state.player.quests.completed.includes(npc.questId);
  const started = state.player.quests.started.find((q) => q.id === npc.questId);
  panel.classList.remove('hidden');
  if (completed) {
    panel.innerHTML = `<div class="card-sub">Quest "${quest.name}" — completed.</div>`;
  } else if (started) {
    panel.innerHTML =
      `<div class="card-sub"><strong>${quest.name}</strong>: ${quest.description}</div>` +
      (started.objectiveMet ? `<button id="quest-turnin-btn">Turn In</button>` : `<div class="card-sub">Not ready yet.</div>`);
    if (started.objectiveMet) {
      document.getElementById('quest-turnin-btn').addEventListener('click', () => turnInQuestUI(npc.questId));
    }
  } else {
    panel.innerHTML = `<div class="card-sub"><strong>${quest.name}</strong>: ${quest.description}</div><button id="quest-accept-btn">Accept Quest</button>`;
    document.getElementById('quest-accept-btn').addEventListener('click', () => acceptQuestUI(npc.questId));
  }
}

function closeDialogue() {
  document.getElementById('dialogue-modal').classList.add('hidden');
  state.dialogue = { npcId: null, nodeId: null };
}

async function acceptQuestUI(questId) {
  try {
    await post('/api/quest/accept', { playerId: state.playerId, questId });
  } catch {
    return;
  }
  await refreshMe();
  if (!document.getElementById('dialogue-modal').classList.contains('hidden')) renderDialogueQuestPanel();
}

async function turnInQuestUI(questId) {
  let result;
  try {
    result = await post('/api/quest/turn-in', { playerId: state.playerId, questId });
  } catch {
    return;
  }
  showToast(`Quest complete! +${result.reward.gold || 0} gold`);
  await refreshMe();
  if (!document.getElementById('dialogue-modal').classList.contains('hidden')) renderDialogueQuestPanel();
}

// --- tavern tab ---

function renderTavernTab() {
  const loc = state.locations.find((l) => l.id === state.player.currentLocation);
  const atTavern = !!(loc && loc.tavern);
  document.getElementById('tavern-not-here').classList.toggle('hidden', atTavern);
  document.getElementById('tavern-chat-wrap').classList.toggle('hidden', !atTavern);
  renderTavernMessages();
}

// Built with textContent, not innerHTML/template-string interpolation —
// username and message text are player-controlled (chosen at login / typed
// in chat), so inserting them as raw HTML would let one player run
// arbitrary script in every other tavern viewer's browser (e.g. a username
// or message containing `<img src=x onerror=...>`).
function renderTavernMessages() {
  const div = document.getElementById('tavern-messages');
  div.innerHTML = '';
  for (const m of state.tavernMessages) {
    const line = document.createElement('div');
    line.className = 'tavern-msg';
    const nameEl = document.createElement('strong');
    nameEl.textContent = `${m.username}:`;
    line.appendChild(nameEl);
    line.appendChild(document.createTextNode(' ' + m.text));
    div.appendChild(line);
  }
  div.scrollTop = div.scrollHeight;
}

// --- statistics tab ---

function renderStatsTab() {
  const p = state.player;
  const container = document.getElementById('stats-content');

  const skillCards = Object.entries(p.skills)
    .map(([id, s]) => {
      const name = SKILL_DISPLAY_NAMES[id] || id.charAt(0).toUpperCase() + id.slice(1);
      return `<div class="card"><h3>${name}</h3><div class="card-sub">Level ${s.level} — ${s.xp} total xp</div></div>`;
    })
    .join('');

  const killEntries = Object.entries(p.killCounts);
  const killLines = killEntries.length
    ? killEntries.map(([enemyId, count]) => `<div class="stats-summary-line">${state.enemiesMeta[enemyId] ? state.enemiesMeta[enemyId].name : enemyId}: ${count}</div>`).join('')
    : '<div class="stats-summary-line">No kills yet.</div>';

  container.innerHTML = `
    <h3>Skills</h3>
    <div class="card-grid">${skillCards}</div>

    <h3>Combat Record</h3>
    <div class="stats-summary-line">Wins: ${p.combatRecord.wins} &nbsp; Losses: ${p.combatRecord.losses}</div>
    ${killLines}

    <h3>Progress</h3>
    <div class="stats-summary-line">Gold: ${ownedCount('gold')}</div>
    <div class="stats-summary-line">Locations discovered: ${p.discoveries.length} / ${state.locations.length}</div>
    <div class="stats-summary-line">Quests completed: ${p.quests.completed.length}</div>
    <div class="stats-summary-line">Animals owned: ${p.farm.animals.length}</div>
    <div class="stats-summary-line">Buildings built: ${Object.keys(p.buildings).length}</div>
    <div class="stats-summary-line">Equipped weapon: ${p.equipment.weapon ? p.equipment.weapon.name : 'None'}</div>
    <div class="stats-summary-line">Equipped armor: ${p.equipment.armor ? p.equipment.armor.name : 'None'}</div>
  `;
}

// --- shop tab ---

function renderShopTab() {
  const container = document.getElementById('shop-items');
  container.innerHTML = '';
  for (const entry of state.shopMeta.items) {
    const meta = state.itemsMeta[entry.id];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${meta.name}</h3><div class="card-sub">${entry.price} gold</div><button class="shop-item-btn" data-buy="${entry.id}">Buy</button>`;
    container.appendChild(card);
  }
  container.querySelectorAll('button[data-buy]').forEach((btn) => {
    btn.addEventListener('click', () => buyShopItem(btn.dataset.buy));
  });
  renderSellList();
}

async function buyShopItem(itemId) {
  try {
    await post('/api/shop/buy', { playerId: state.playerId, itemId });
  } catch {
    return;
  }
  showToast(`Bought ${state.itemsMeta[itemId].name}!`);
  await refreshMe();
}

function renderSellList() {
  const container = document.getElementById('shop-sell-list');
  container.innerHTML = '';
  const sellable = state.player.inventory.filter((i) => state.itemsMeta[i.id] && state.itemsMeta[i.id].sellPrice);
  if (sellable.length === 0) {
    container.innerHTML = '<p>Nothing to sell right now.</p>';
    return;
  }
  for (const entry of sellable) {
    const meta = state.itemsMeta[entry.id];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${meta.name}</h3><div class="card-sub">${meta.sellPrice} gold each &mdash; have ${entry.count}</div>
      <button data-sell="${entry.id}" data-sell-amount="1">Sell 1</button>
      <button data-sell="${entry.id}" data-sell-amount="${entry.count}">Sell All (${entry.count})</button>`;
    container.appendChild(card);
  }
  container.querySelectorAll('button[data-sell]').forEach((btn) => {
    btn.addEventListener('click', () => sellShopItem(btn.dataset.sell, Number(btn.dataset.sellAmount)));
  });
}

async function sellShopItem(itemId, amount) {
  let result;
  try {
    result = await post('/api/shop/sell', { playerId: state.playerId, itemId, amount });
  } catch {
    return;
  }
  showToast(`Sold ${result.amount}x ${state.itemsMeta[itemId].name} for ${result.goldEarned} gold!`);
  await refreshMe();
}

async function buyLocationReveal() {
  let result;
  try {
    result = await post('/api/shop/buy-location', { playerId: state.playerId });
  } catch {
    return;
  }
  showToast(`Revealed: ${result.location.name}!`);
  await refreshMe();
}

let socket;
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}`);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'identify', playerId: state.playerId }));
  });
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'players') {
      state.others = msg.players.filter((p) => p.id !== state.playerId);
      render();
    } else if (msg.type === 'chat') {
      if (state.player && msg.locationId === state.player.currentLocation) {
        state.tavernMessages.push(msg.entry);
        if (state.tavernMessages.length > 100) state.tavernMessages.shift();
        renderTavernMessages();
      }
    }
  });
  socket.addEventListener('close', () => {
    setTimeout(connectSocket, 2000);
  });
}

function showToast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  setTimeout(() => {
    if (el.textContent === text) el.textContent = '';
  }, 4000);
}

function render() {
  if (!state.player) return;

  const gold = state.player.inventory.find((i) => i.id === 'gold');
  document.getElementById('gold-display').textContent = `Gold: ${gold ? gold.count : 0}`;

  renderOverworldTab();
  renderAllNodeSkills();
  renderCharacterTab();
  renderInventoryTab();
  renderEquipmentTab();
  renderCombatTab();
  renderGardeningTab();
  renderFarmingTab();
  renderCraftingTab();
  renderAlchemyTab();
  renderBuildingsTab();
  renderNpcsTab();
  renderTavernTab();
  renderShopTab();
  renderStatsTab();

  // sidebar: other players
  const list = document.getElementById('players-list');
  list.innerHTML = '';
  if (state.others.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No one else around.';
    list.appendChild(li);
  } else {
    for (const other of state.others) {
      const loc = state.locations.find((l) => l.id === other.locationId);
      const li = document.createElement('li');
      li.textContent = `${other.username} — ${loc ? loc.name : 'unknown'}`;
      list.appendChild(li);
    }
  }
}

// One item takes a few seconds — draw that as a clock-style pie fill
// (starts at 12 o'clock, sweeps clockwise) so progress toward the next
// item is visible in real time, not just on the ~2s server poll. Reused
// for skill tasks (mining/woodcutting/fishing) and for combat attack timers.
function drawClock(clockCtx, size, fraction) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  clockCtx.clearRect(0, 0, size, size);

  clockCtx.beginPath();
  clockCtx.arc(cx, cy, r, 0, Math.PI * 2);
  clockCtx.fillStyle = '#33291d';
  clockCtx.fill();
  clockCtx.strokeStyle = '#4a4030';
  clockCtx.lineWidth = 2;
  clockCtx.stroke();

  if (fraction > 0) {
    const start = -Math.PI / 2;
    const end = start + fraction * Math.PI * 2;
    clockCtx.beginPath();
    clockCtx.moveTo(cx, cy);
    clockCtx.arc(cx, cy, r, start, end);
    clockCtx.closePath();
    clockCtx.fillStyle = '#7fae5a';
    clockCtx.fill();
  }
}

// biteAt is an absolute epoch-ms timestamp from the server (see
// getFishingBite() in server/store.js), not a fixed-anchor progress fraction
// like the clocks above — so no extrapolation math is needed at all, just a
// direct Date.now() comparison every frame. The button is only ever
// ENABLED here (a purely cosmetic client-side gate on when clicking is
// worth trying); the server independently re-derives the same window and is
// the sole authority on whether a click actually lands inside it.
function updateFishingCatchButton() {
  const btn = document.getElementById('fishing-catch-btn');
  if (!btn) return;
  const skill = state.player.skills.fishing;
  const now = Date.now();
  const inWindow = skill && skill.active && skill.biteAt && now >= skill.biteAt && now <= skill.biteAt + skill.biteWindowMs;
  btn.disabled = !inWindow;
  btn.classList.toggle('bite-active', !!inWindow);
}

function animate() {
  // A single bad frame must never permanently kill the loop — without this,
  // one exception here would silently freeze the whole map/clocks forever,
  // which would look exactly like "nothing renders" with no error visible.
  try {
    if (state.player) {
      for (const skillId of Object.keys(state.player.skills)) {
        const sync = state.clockSync[skillId];
        const clockCanvas = document.getElementById(`${skillId}-clock`);
        if (!sync || !clockCanvas) continue;

        let progress = sync.progressSeconds;
        if (sync.active) {
          progress += (Date.now() - sync.syncedAt) / 1000;
          progress %= sync.cycleSeconds;
        }
        const fraction = sync.cycleSeconds > 0 ? progress / sync.cycleSeconds : 0;
        drawClock(clockCanvas.getContext('2d'), clockCanvas.width, fraction);
      }

      updateFishingCatchButton();
    }
  } catch (err) {
    console.error('[animate] frame error (recovered):', err);
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// Dev/testing console commands — type dev.help() in devtools. Not gated
// behind anything since this is a solo/local prototype; remove or lock
// down before any public launch.
window.dev = {
  async give(itemId, amount = 1) {
    const r = await post('/api/dev/give', { playerId: state.playerId, itemId, amount });
    await refreshMe();
    console.log(`[dev] ${itemId} -> ${r.count}`);
    return r;
  },
  async discover(locationId) {
    const r = await post('/api/dev/discover', { playerId: state.playerId, locationId });
    await refreshMe();
    console.log(`[dev] discovered ${locationId}`);
    return r;
  },
  async setXp(skillId, xp) {
    const r = await post('/api/dev/set-xp', { playerId: state.playerId, skillId, xp });
    await refreshMe();
    console.log(`[dev] ${skillId} xp -> ${r.xp}`);
    return r;
  },
  locations() {
    console.table(
      state.locations.map((l) => ({
        id: l.id,
        name: l.name,
        skill: l.skill || '',
        combat: l.combat ? l.combat.join(',') : '',
        discovered: state.player.discoveries.includes(l.id),
      }))
    );
  },
  async reset() {
    await post('/api/dev/reset', { playerId: state.playerId });
    await refreshMe();
    console.log('[dev] account reset to a fresh character (same login) — discoveries, inventory, equipment, garden, skills all cleared');
  },
  help() {
    console.log(
      `Dev commands:\n` +
        `  dev.give(itemId, amount)   e.g. dev.give('gold', 100), dev.give('rusty_sword', 1)\n` +
        `  dev.discover(locationId)   e.g. dev.discover('ironbrook_mine')\n` +
        `  dev.setXp(skillId, xp)     e.g. dev.setXp('mining', 500)\n` +
        `  dev.locations()            list all location ids/names/discovered status/skill/combat\n` +
        `  dev.reset()                wipe THIS character back to fresh (discoveries/inventory/equipment/garden/skills) — for repeat-testing exploration etc.`
    );
  },
};
console.log('%cDev commands available — type dev.help() in this console.', 'color:#d8b04a;font-weight:bold;');

if (state.playerId) {
  fetch(`/api/me?playerId=${state.playerId}`, { headers: state.token ? { 'X-Player-Token': state.token } : {} })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((player) => {
      state.player = player;
      enterGame();
    })
    .catch((err) => {
      if (err instanceof TypeError) {
        // network error (server unreachable) — keep the saved session, just warn
        showError('Cannot reach the server. Is `npm start` still running?');
        return;
      }
      // server reachable but this playerId/token is no longer valid
      localStorage.removeItem('mmo_playerId');
      localStorage.removeItem('mmo_token');
      state.playerId = null;
      state.token = null;
    });
}

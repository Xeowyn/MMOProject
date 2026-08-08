const SKILL_DISPLAY_NAMES = {
  mining: 'Mining',
  woodcutting: 'Woodcutting',
  fishing: 'Fishing',
  hunting: 'Hunting',
  scavenging: 'Scavenging',
  harvesting: 'Harvesting',
};

// Every resource-gathering skill is node-grid based (server: RESOURCE_NODES/
// DETERMINISTIC_TASKS in server/store.js) — mining/woodcutting/fishing yield
// one guaranteed item per cycle, hunting/scavenging/harvesting only have a
// chance each cycle. Drives the generic renderNodeSkill()/clockSync loop
// below so every one of the 6 gets the same node-tile picker UI.
const RESOURCE_SKILL_IDS = ['mining', 'woodcutting', 'fishing', 'hunting', 'scavenging', 'harvesting'];
const DETERMINISTIC_SKILL_IDS = new Set(['mining', 'woodcutting', 'fishing']);

const state = {
  playerId: localStorage.getItem('mmo_playerId') || null,
  token: localStorage.getItem('mmo_token') || null,
  player: null,
  locations: [],
  others: [], // [{id, username, locationId}]
  markers: [], // hit-test cache: [{x, y, r, locationId}] in canvas pixel space
  clockSync: {}, // { [skillId]: { progressSeconds, cycleSeconds, active, syncedAt } }
  expeditionSync: null, // { path, totalLength, durationSeconds, startedAt } — fixed anchor, set once per expedition
  drawMode: false,
  isDrawing: false,
  drawPath: [], // percent-space points while actively dragging out a route
  drawLength: 0,
  itemsMeta: {},
  enemiesMeta: {},
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
  selectedAbility: null, // ability id (or CLEAR_SLOT_SENTINEL) currently picked in the Combat tab's sidebar-then-click-slots flow
  lastSeenRareEventAt: null, // dedupes lastRareEvent across polls, same idea as the discovery-array diff
  traitConfig: null, // { keys, base, min, max, extraPoints } — fetched once, drives the character-creation screen
  creationTraits: null, // { strength, dexterity, luck, vigor } while allocating on the creation screen
  creationUsername: null,
  perksMeta: {}, // static perk definitions, keyed by id (tier/requiresLevel/cost) — merged with player.perks' per-player unlocked/levelMet flags
  camera: { x: 50, y: 50, zoom: 1 }, // percent-space camera center + zoom (1 = whole map visible, up to CAMERA_MAX_ZOOM)
  isPanning: false,
  panStart: null, // { clientX, clientY, camX, camY }
  wasPanning: false, // suppresses the click-to-travel handler right after a pan drag
  pinch: null, // { startDist, startZoom } while a two-finger touch gesture is active
};

const CAMERA_MAX_ZOOM = 20;

// Camera-aware world<->screen transforms — the map's underlying 0-100
// percent-space world is unchanged (so all server-side distance math for
// expeditions stays correct), but the camera lets the player zoom into a
// small slice of it (as tight as 1/20th) or pan around, purely as a
// rendering transform.
function pixelToPercent(px, py) {
  const viewSize = 100 / state.camera.zoom;
  const left = state.camera.x - viewSize / 2;
  const top = state.camera.y - viewSize / 2;
  return { x: left + (px / canvas.width) * viewSize, y: top + (py / canvas.height) * viewSize };
}

function percentToPixel(x, y) {
  const viewSize = 100 / state.camera.zoom;
  const left = state.camera.x - viewSize / 2;
  const top = state.camera.y - viewSize / 2;
  return { x: ((x - left) / viewSize) * canvas.width, y: ((y - top) / viewSize) * canvas.height };
}

const loginScreen = document.getElementById('login-screen');
const gameScreen = document.getElementById('game-screen');
const canvas = document.getElementById('map-canvas');
const ctx = canvas.getContext('2d');

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

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username-input').value.trim();
  const password = document.getElementById('password-input').value;
  if (!username) return;
  let result;
  try {
    result = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
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
  dexterity: 'Increases ability speed, crit chance, and dodge chance.',
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
    result = await api('/api/create-character', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: state.creationUsername, traits: state.creationTraits, password }),
    });
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
  state.itemsMeta = await api('/api/items');
  state.enemiesMeta = await api('/api/enemies');
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
  document.getElementById('explore-btn').addEventListener('click', toggleDrawMode);
  document.getElementById('confirm-btn').addEventListener('click', confirmDrawnPath);
  document.getElementById('cancel-btn').addEventListener('click', cancelDrawnPath);
  document.getElementById('unequip-weapon-btn').addEventListener('click', () => unequipSlot('weapon'));
  document.getElementById('unequip-armor-btn').addEventListener('click', () => unequipSlot('armor'));
  document.getElementById('flee-btn').addEventListener('click', endCombat);
  document.getElementById('combat-continue-btn').addEventListener('click', endCombat);
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
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('mousedown', onCanvasMouseDown);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  window.addEventListener('mouseup', onCanvasMouseUp);
  canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
  // touch: { passive: false } so preventDefault() can actually stop the page
  // from scrolling/zooming while a finger is on the map. Unlike mouse events,
  // touchend keeps firing on the element a touch started on even if the
  // finger drifts elsewhere first, so (unlike mouseup) canvas itself is the
  // right place to listen, not window.
  canvas.addEventListener('touchstart', onCanvasTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onCanvasTouchMove, { passive: false });
  canvas.addEventListener('touchend', onCanvasTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onCanvasTouchEnd, { passive: false });
  document.getElementById('zoom-in-btn').addEventListener('click', () => zoomCamera(1.5));
  document.getElementById('zoom-out-btn').addEventListener('click', () => zoomCamera(1 / 1.5));
  document.getElementById('center-btn').addEventListener('click', centerCameraOnPlayer);

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

// Polls faster while a fight or an expedition is active. Combat attack
// speeds (1-2.5s) are faster than the normal 2s poll, so combat needs
// tighter sync or the on-screen attack timers visibly lag. Expeditions are
// often even shorter (as little as ~2s) — at the normal poll rate the whole
// trip could complete between two polls, and every location it found would
// appear to be revealed all at once instead of one by one as the sweep
// actually passes over each one.
function scheduleNextPoll() {
  const inCombat = state.player && state.player.combat && !state.player.combat.result;
  const exploring = state.player && state.player.expedition;
  const delay = inCombat || exploring ? 300 : 2000;
  setTimeout(async () => {
    await refreshMe();
    scheduleNextPoll();
  }, delay);
}

async function refreshMe() {
  const previousDiscoveries = new Set(state.player ? state.player.discoveries : []);
  const wasInCombat = !!(state.player && state.player.combat);
  try {
    state.player = await api(`/api/me?playerId=${state.playerId}`);
  } catch {
    return;
  }

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
  // Every resource skill's clock lives in its node list (player.<skillId>Nodes,
  // one active node at a time), not on the skill entry itself — sync the
  // same shape for all 6 so animate() can drive each `${skillId}-clock`
  // canvas with the identical fixed-anchor extrapolation trick.
  for (const skillId of RESOURCE_SKILL_IDS) {
    const activeNode = state.player[`${skillId}Nodes`].find((n) => n.active);
    state.clockSync[skillId] = activeNode
      ? { progressSeconds: activeNode.progressSeconds, cycleSeconds: activeNode.cycleSeconds, active: true, syncedAt: now }
      : { progressSeconds: 0, cycleSeconds: 1, active: false, syncedAt: now };
  }

  // Anchor the sweep to the expedition's fixed startedAt/durationSeconds
  // ONCE, the moment it's first seen — never re-derive it from a later
  // poll's fraction. Recomputing the anchor every poll let small per-request
  // latency accumulate into real drift (worse the more often we poll), so
  // the client's estimate could end up well behind the server's true
  // progress; when the server then reported the expedition finished, the
  // line would vanish wherever the drifted estimate happened to be instead
  // of at 100%. Computing fraction fresh every frame from fixed anchor
  // values is immune to that regardless of network/processing latency.
  if (state.player.expedition) {
    const exp = state.player.expedition;
    if (!state.expeditionSync || state.expeditionSync.startedAt !== exp.startedAt) {
      state.expeditionSync = {
        path: exp.path,
        totalLength: exp.totalLength,
        durationSeconds: exp.durationSeconds,
        startedAt: exp.startedAt,
      };
    }
  } else if (state.expeditionSync) {
    // Server says it's done — but let the local animation actually finish
    // reaching 100% before clearing, rather than cutting it off the instant
    // this poll landed (which is exactly the premature-disappearance bug).
    const localFraction = (Date.now() - state.expeditionSync.startedAt) / 1000 / state.expeditionSync.durationSeconds;
    if (localFraction >= 1) {
      state.expeditionSync = null;
    }
  }

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

  render();
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

function toggleDrawMode() {
  if (state.player.expedition) return; // button should already be disabled in this case
  if (state.drawMode) {
    console.log('[explore] exiting draw mode via toggle');
    exitDrawMode();
    return;
  }
  if ((state.player.maxExplorationRange || 0) <= 0) {
    console.log('[explore] blocked — no supplies (maxExplorationRange <= 0)');
    showToast('Not enough supplies to explore.');
    return;
  }
  console.log('[explore] entering draw mode, maxRange =', state.player.maxExplorationRange);
  state.drawMode = true;
  canvas.classList.add('draw-mode');
  document.getElementById('draw-hint').classList.remove('hidden');
  render();
}

function exitDrawMode() {
  state.drawMode = false;
  state.isDrawing = false;
  state.drawPath = [];
  state.drawLength = 0;
  canvas.classList.remove('draw-mode');
  document.getElementById('draw-hint').classList.add('hidden');
  render();
}

// --- map camera: pan (click-drag) + zoom (wheel/buttons) ---
// Only active outside draw mode — while drawing an expedition route,
// mousedown/move/up already mean "draw the path", so panning would collide
// with that. A plain click (no real drag) still falls through to
// onCanvasClick for travel — wasPanning distinguishes the two.

function zoomCamera(factor) {
  state.camera.zoom = Math.min(CAMERA_MAX_ZOOM, Math.max(1, state.camera.zoom * factor));
}

function clampCamera() {
  state.camera.x = Math.min(100, Math.max(0, state.camera.x));
  state.camera.y = Math.min(100, Math.max(0, state.camera.y));
}

function centerCameraOnPlayer() {
  const loc = state.locations.find((l) => l.id === state.player.currentLocation);
  if (loc) {
    state.camera.x = loc.x;
    state.camera.y = loc.y;
  }
}

function onCanvasWheel(e) {
  e.preventDefault();
  zoomCamera(e.deltaY < 0 ? 1.15 : 1 / 1.15);
}

// clientX/clientY-based versions of the pointer-down/move/up logic, shared
// between mouse events and single-finger touch events (a finger and a mouse
// cursor are the same "one point moving across the canvas" input as far as
// pan/draw/tap care — only how the coordinates are read differs).
function handlePointerDown(clientX, clientY) {
  if (!state.drawMode) {
    state.isPanning = true;
    state.wasPanning = false;
    state.panStart = { clientX, clientY, camX: state.camera.x, camY: state.camera.y };
    return;
  }
  const currentLoc = state.locations.find((l) => l.id === state.player.currentLocation);
  if (!currentLoc) {
    console.warn('[explore] pointerdown: could not find current location', state.player.currentLocation);
    return;
  }
  console.log('[explore] pointerdown — starting path at', currentLoc.name);
  state.isDrawing = true;
  state.drawPath = [{ x: currentLoc.x, y: currentLoc.y }];
  state.drawLength = 0;
  render();
}

function handlePointerMove(clientX, clientY) {
  if (!state.drawMode) {
    if (!state.isPanning) return;
    const rect = canvas.getBoundingClientRect();
    const dxPixel = clientX - state.panStart.clientX;
    const dyPixel = clientY - state.panStart.clientY;
    if (Math.hypot(dxPixel, dyPixel) > 3) state.wasPanning = true;
    const viewSize = 100 / state.camera.zoom;
    const dxPercent = (dxPixel / rect.width) * viewSize;
    const dyPercent = (dyPixel / rect.height) * viewSize;
    state.camera.x = state.panStart.camX - dxPercent;
    state.camera.y = state.panStart.camY - dyPercent;
    clampCamera();
    return;
  }
  if (!state.isDrawing) return;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const px = (clientX - rect.left) * scaleX;
  const py = (clientY - rect.top) * scaleY;
  const point = pixelToPercent(px, py);

  const last = state.drawPath[state.drawPath.length - 1];
  const segLength = Math.hypot(point.x - last.x, point.y - last.y);
  const MIN_STEP = 0.4; // percent-units, avoids flooding the path with points
  if (segLength < MIN_STEP) return;

  const maxLength = state.player.maxExplorationRange;
  if (state.drawLength + segLength > maxLength) {
    const remaining = Math.max(0, maxLength - state.drawLength);
    if (remaining <= 0) return; // already at max range, ignore further movement
    const ratio = remaining / segLength;
    state.drawPath.push({ x: last.x + (point.x - last.x) * ratio, y: last.y + (point.y - last.y) * ratio });
    state.drawLength = maxLength;
    return;
  }

  state.drawPath.push(point);
  state.drawLength += segLength;
}

// Releasing the pointer just stops the drag — the drawn route stays on
// screen until the player explicitly confirms or cancels it, so there's
// no window where the line silently disappears before anything happens.
function handlePointerUp() {
  if (state.isPanning) {
    state.isPanning = false;
  }
  if (!state.drawMode || !state.isDrawing) {
    return;
  }
  state.isDrawing = false;
  console.log('[explore] pointerup — path points:', state.drawPath.length, 'length:', state.drawLength.toFixed(2));
  if (state.drawPath.length < 2 || state.drawLength <= 0) {
    console.log('[explore] path too short, discarding (normal for a tap/click with no drag)');
    state.drawPath = [];
    state.drawLength = 0;
  }
  render();
}

function onCanvasMouseDown(e) {
  handlePointerDown(e.clientX, e.clientY);
}

function onCanvasMouseMove(e) {
  handlePointerMove(e.clientX, e.clientY);
}

function onCanvasMouseUp() {
  handlePointerUp();
}

// --- touch support: single finger = pan/draw/tap (same as a mouse), two
// fingers = pinch-to-zoom. preventDefault() throughout stops the page from
// scrolling/zooming natively while the player is interacting with the map,
// and (critically) suppresses the browser's own synthetic click it would
// otherwise fire after touchend — without that suppression, a tap would
// travel to a location twice, or start a draw path and then immediately
// misfire a click on top of it.
function touchDistance(t0, t1) {
  return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
}

function onCanvasTouchStart(e) {
  e.preventDefault();
  if (e.touches.length === 2) {
    // switching to a pinch gesture always wins over an in-progress
    // pan/draw from whatever the first finger was doing
    state.isPanning = false;
    state.isDrawing = false;
    state.pinch = { startDist: touchDistance(e.touches[0], e.touches[1]), startZoom: state.camera.zoom };
    return;
  }
  if (e.touches.length === 1) {
    state.pinch = null;
    const t = e.touches[0];
    handlePointerDown(t.clientX, t.clientY);
  }
}

function onCanvasTouchMove(e) {
  e.preventDefault();
  if (state.pinch && e.touches.length === 2) {
    const dist = touchDistance(e.touches[0], e.touches[1]);
    const ratio = dist / state.pinch.startDist;
    state.camera.zoom = Math.min(CAMERA_MAX_ZOOM, Math.max(1, state.pinch.startZoom * ratio));
    return;
  }
  if (e.touches.length === 1) {
    const t = e.touches[0];
    handlePointerMove(t.clientX, t.clientY);
  }
}

function onCanvasTouchEnd(e) {
  e.preventDefault();
  if (e.touches.length > 0) return; // still at least one finger down (e.g. lifting one of two) — not done yet
  const wasPinching = !!state.pinch;
  state.pinch = null;
  handlePointerUp();
  // A genuine tap-to-travel: not the end of a pinch, and not the end of a
  // real drag (handlePointerUp already turned a drag past the 3px
  // threshold into state.wasPanning; handlePointerClick itself already
  // skips this while in draw mode, matching the mouse 'click' behavior).
  if (!wasPinching && !state.wasPanning) {
    const t = e.changedTouches[0];
    if (t) handlePointerClick(t.clientX, t.clientY);
  }
}

function cancelDrawnPath() {
  if (state.drawPath.length === 0) {
    // nothing drawn yet — cancel backs all the way out of draw mode
    exitDrawMode();
    return;
  }
  state.drawPath = [];
  state.drawLength = 0;
  render();
}

async function confirmDrawnPath() {
  if (state.drawPath.length < 2 || state.drawLength <= 0) return;
  const path = state.drawPath;

  let result;
  try {
    result = await api('/api/expedition/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, path }),
    });
  } catch {
    return;
  }
  exitDrawMode();
  showToast(
    result.locationsFound > 0
      ? `Expedition underway — ${result.locationsFound} location${result.locationsFound === 1 ? '' : 's'} within reach!`
      : 'Expedition underway...'
  );
  await refreshMe();
}

async function travelTo(locationId) {
  try {
    await api('/api/travel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, locationId }),
    });
  } catch {
    return;
  }
  await refreshMe();
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

// The minigame is purely a client-side-rendered bonus on top of the passive
// clock (see animate()'s bite-window check, which enables/disables this
// button) — clicking sends exactly one lightweight request, same shape as
// any other player-triggered action (craft/equip/buy). The server is the
// sole authority on whether the click landed in the real window (see
// getFishingBite()/attemptFishingCatch() in server/store.js); this never
// trusts the client's own clock for anything but when to let the player try.
async function attemptFishingCatch() {
  let result;
  try {
    result = await api('/api/fishing/catch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId }),
    });
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

// --- unified node-skill engine (Melvor-Idle-style node grid) ---
// Drives all 6 resource skills (mining/woodcutting/fishing/hunting/
// scavenging/harvesting) off player.<skillId>Nodes — see RESOURCE_NODES/
// publicResourceNodes() in server/store.js. Every node is workable from
// wherever the player currently is once its location has been discovered;
// each skill's starting-camp node is always unlocked. Tiles reuse the same
// visual language as the garden's plot grid (.garden-plot-tile) rather than
// inventing a new pattern. Mining/Fishing each get a full dedicated tab with
// a big "currently working X" header panel; Woodcutting (Skills tab) and
// Hunting/Scavenging/Harvesting (Overworld sidebar) use the compact form —
// just the clock/bar/label and grid, no separate header panel — since they
// share space with other UI. opts: { gridId, barFillId, labelId,
// activePanelId?, activeNameId? }
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
      await api('/api/task/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: state.playerId, skillId }),
      });
    } else {
      await api('/api/task/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: state.playerId, skillId, nodeId: node.id }),
      });
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
    await api('/api/equip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, itemId }),
    });
  } catch {
    return;
  }
  await refreshMe();
}

async function unequipSlot(slot) {
  try {
    await api('/api/unequip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, slot }),
    });
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
    await api('/api/trait/allocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, trait: traitName }),
    });
  } catch {
    return;
  }
  showToast(`${TRAIT_DISPLAY_NAMES[traitName]} increased!`);
  await refreshMe();
}

async function unlockPerkUI(perkId) {
  let result;
  try {
    result = await api('/api/perk/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, perkId }),
    });
  } catch {
    return;
  }
  showToast(`Perk unlocked: ${state.perksMeta[result.perkId].name}!`);
  await refreshMe();
}

// --- combat tab ---
//
// Combat 2.0: a tick-based, multi-enemy ability-sequencer arena. The player
// picks up to 6 unlocked abilities into a persistent loadout (editable any
// time outside a fight); during a fight, each combat round the player
// resolves (or continues charging, for heavier multi-round abilities) their
// current loadout ability, then every living enemy takes one AI-driven
// action of its own. See server/store.js resolvePlayerTurn()/
// enemyTakeTurn()/tickCombat() for the simulation this renders.

// Player-adjustable pacing — how fast combat rounds tick by. A persisted
// preference (state.player.combatSpeed, carries between fights) that also
// applies live to a fight in progress. Rendered in both the idle screen
// (so it can be set before a fight starts) and the active-fight screen.
const COMBAT_SPEEDS = [
  { id: 'slow', label: 'Slow' },
  { id: 'normal', label: 'Normal' },
  { id: 'fast', label: 'Fast' },
];

function renderSpeedControls(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '<span>Combat speed:</span>';
  for (const speed of COMBAT_SPEEDS) {
    const btn = document.createElement('button');
    btn.className = 'speed-btn' + (state.player.combatSpeed === speed.id ? ' active' : '');
    btn.textContent = speed.label;
    btn.addEventListener('click', () => setCombatSpeed(speed.id));
    container.appendChild(btn);
  }
}

async function setCombatSpeed(speed) {
  try {
    await api('/api/combat/speed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, speed }),
    });
  } catch {
    return;
  }
  await refreshMe();
}

// One card per enemy in the fight — HP bar, distance-from-player (mirrors
// the arena canvas so players who prefer exact numbers over the visual
// don't need it), and any affliction. Dead enemies stay visible but dimmed
// rather than disappearing, so a multi-enemy fight's outcome reads clearly.
function renderEnemyList(c) {
  const listDiv = document.getElementById('enemy-list');
  listDiv.innerHTML = '';
  for (const e of c.enemies) {
    const card = document.createElement('div');
    card.className = 'enemy-card' + (e.alive ? '' : ' dead');
    card.innerHTML = `
      <div class="arena-combatant-header"><span>${e.name}</span><span>${e.hp} / ${e.maxHp} HP</span></div>
      <div class="hp-bar-wrap"><div class="hp-bar-fill enemy" style="width:${(e.hp / e.maxHp) * 100}%"></div></div>
      <div class="effect-label">${e.alive ? (e.dot ? `Afflicted: ${e.dot.type}` : '') : 'Defeated'}</div>
    `;
    listDiv.appendChild(card);
  }
}

function renderCombatTab() {
  const idleDiv = document.getElementById('combat-idle');
  const activeDiv = document.getElementById('combat-active');

  if (state.player.combat) {
    idleDiv.classList.add('hidden');
    activeDiv.classList.remove('hidden');
    const c = state.player.combat;

    renderSpeedControls('combat-speed-controls');
    document.getElementById('player-hp-fill').style.width = `${(c.playerHp / c.playerMaxHp) * 100}%`;
    document.getElementById('player-hp-label').textContent = `${c.playerHp} / ${c.playerMaxHp} HP`;
    document.getElementById('player-status-line').textContent = [
      c.dotOnPlayer ? `Afflicted: ${c.dotOnPlayer.type}` : '',
      c.buff ? `Buffed: ${c.buff.type}` : '',
      c.armorBuffActive ? 'Guard up' : '',
      c.evasionActive ? 'Evading' : '',
      c.comboReady ? 'Combo ready!' : '',
      c.hasteReady ? 'Haste ready!' : '',
    ]
      .filter(Boolean)
      .join(' | ');

    renderEnemyList(c);

    const logDiv = document.getElementById('combat-log');
    logDiv.innerHTML = [c.lastPlayerActionText, c.lastEnemyActionText].filter(Boolean).join('<br>');

    renderLiveAbilitySlots(c);

    const resultDiv = document.getElementById('combat-result');
    const fleeBtn = document.getElementById('flee-btn');
    const continueBtn = document.getElementById('combat-continue-btn');
    if (c.result) {
      resultDiv.classList.remove('hidden');
      if (c.result === 'win') {
        const lootLine = c.rewardLoot.length > 0 ? ` (found ${c.rewardLoot.map((l) => l.name).join(', ')})` : '';
        resultDiv.textContent = `Victory! +${c.rewardGold} gold${lootLine}`;
      } else {
        resultDiv.textContent = 'Defeated...';
      }
      fleeBtn.classList.add('hidden');
      continueBtn.classList.remove('hidden');
    } else {
      resultDiv.classList.add('hidden');
      fleeBtn.classList.remove('hidden');
      continueBtn.classList.add('hidden');
    }

    const potionsDiv = document.getElementById('combat-potions');
    potionsDiv.innerHTML = '';
    if (!c.result) {
      const ownedPotions = state.player.inventory.filter((i) => state.itemsMeta[i.id] && state.itemsMeta[i.id].type === 'potion');
      for (const potion of ownedPotions) {
        const btn = document.createElement('button');
        btn.className = 'potion-btn';
        btn.textContent = `${state.itemsMeta[potion.id].name} (${potion.count})`;
        btn.addEventListener('click', () => usePotion(potion.id));
        potionsDiv.appendChild(btn);
      }
    }
  } else {
    idleDiv.classList.remove('hidden');
    activeDiv.classList.add('hidden');
    const loc = state.locations.find((l) => l.id === state.player.currentLocation);
    document.getElementById('combat-location-info').textContent = `Location: ${loc ? loc.name : '--'}`;
    renderSpeedControls('combat-speed-controls-idle');

    const listDiv = document.getElementById('combat-enemy-list');
    listDiv.innerHTML = '';
    if (loc && loc.combat && loc.combat.length > 0) {
      for (const enemyId of loc.combat) {
        const meta = state.enemiesMeta[enemyId];
        const btn = document.createElement('button');
        btn.className = 'enemy-btn';
        btn.innerHTML = `<strong>${meta.name}</strong><br>${meta.maxHp} HP`;
        btn.addEventListener('click', () => startFight(enemyId));
        listDiv.appendChild(btn);
      }
      const hint = document.createElement('p');
      hint.className = 'card-sub';
      hint.textContent = 'Sometimes 2-3 enemies from this area will join the fight together.';
      listDiv.appendChild(hint);
    } else {
      listDiv.innerHTML = '<p>No enemies here. Explore to find a combat area.</p>';
    }

    renderLoadoutEditor();
    renderAbilitySidebar();
  }
}

// Sentinel for "Clear Slot" being the selected sidebar entry — distinct from
// null (nothing selected at all), since the loadout API itself already uses
// abilityId: null to mean "empty this slot".
const CLEAR_SLOT_SENTINEL = '__clear__';

// The persistent loadout, editable any time the player isn't mid-fight.
// Selection flow mirrors the Gardening tab's seed-then-click-plots pattern:
// pick an ability once in the sidebar (renderAbilitySidebar), then click any
// number of slots to place it — the selection stays active so filling
// several slots with the same ability doesn't require re-selecting each
// time.
function renderLoadoutEditor() {
  const row = document.getElementById('loadout-slots');
  row.innerHTML = '';
  state.player.abilityLoadout.forEach((abilityId, index) => {
    const slot = document.createElement('div');
    const ability = abilityId ? state.player.abilities.find((a) => a.id === abilityId) : null;
    slot.className = 'ability-slot' + (ability ? '' : ' empty');
    slot.title = ability ? ability.description : 'Empty — select an ability from the panel on the right';
    slot.innerHTML = ability
      ? `<span class="ability-slot-name">${ability.name}</span><span>${ability.castRounds}${ability.castRounds === 1 ? ' round' : ' rounds'}</span>`
      : '<span>Empty</span>';
    slot.addEventListener('click', () => placeSelectedAbility(index));
    row.appendChild(slot);
  });

  const statusEl = document.getElementById('ability-select-status');
  if (state.selectedAbility === CLEAR_SLOT_SENTINEL) {
    statusEl.textContent = 'Clearing slots — click a slot to empty it, or click "Clear Slot" again to stop.';
  } else if (state.selectedAbility) {
    const ability = state.player.abilities.find((a) => a.id === state.selectedAbility);
    statusEl.textContent = `Placing ${ability.name} — click a slot to assign it, or click it again in the panel to stop.`;
  } else {
    statusEl.textContent = '';
  }
}

// Scrollable side panel listing every ability (locked ones included, greyed
// out, so players can see what's coming and plan toward it) with a full
// description — this doubles as both the "what do abilities do" reference
// and the source you select from to fill loadout slots.
function renderAbilitySidebar() {
  const container = document.getElementById('ability-sidebar-list');
  container.innerHTML = '';

  const clearCard = document.createElement('div');
  clearCard.className = 'ability-card selectable' + (state.selectedAbility === CLEAR_SLOT_SENTINEL ? ' selected' : '');
  clearCard.innerHTML = `<h3>Clear Slot</h3><div class="card-sub">Empty out a loadout slot.</div>`;
  clearCard.addEventListener('click', () => toggleAbilitySelection(CLEAR_SLOT_SENTINEL));
  container.appendChild(clearCard);

  for (const ability of state.player.abilities) {
    const card = document.createElement('div');
    if (ability.unlocked) {
      card.className = 'ability-card selectable' + (state.selectedAbility === ability.id ? ' selected' : '');
      card.innerHTML = `<h3>${ability.name}</h3><div class="card-sub">${ability.description}</div><div class="card-sub">Takes ${ability.castRounds} ${ability.castRounds === 1 ? 'round' : 'rounds'} to cast &mdash; ${ability.tags.join(', ')}</div>`;
      card.addEventListener('click', () => toggleAbilitySelection(ability.id));
    } else {
      card.className = 'ability-card locked';
      card.innerHTML = `<h3>${ability.name} 🔒</h3><div class="card-sub">${ability.description}</div><div class="card-sub">Unlocks at Combat level ${ability.unlockLevel}</div>`;
    }
    container.appendChild(card);
  }
}

function toggleAbilitySelection(idOrSentinel) {
  state.selectedAbility = state.selectedAbility === idOrSentinel ? null : idOrSentinel;
  renderAbilitySidebar();
  renderLoadoutEditor();
}

async function placeSelectedAbility(slotIndex) {
  if (!state.selectedAbility) return;
  const abilityId = state.selectedAbility === CLEAR_SLOT_SENTINEL ? null : state.selectedAbility;
  try {
    await api('/api/loadout/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, slotIndex, abilityId }),
    });
  } catch {
    return;
  }
  await refreshMe();
}

// The live rotation during a fight — same 6 boxes as the editor, but
// read-only, with the currently-executing slot highlighted. Its fill bar is
// animated every frame in animate() (see drawAbilitySlotFill()), not here —
// this just rebuilds the boxes/labels on each ~2s poll.
function renderLiveAbilitySlots(c) {
  const row = document.getElementById('ability-slots-live');
  row.innerHTML = '';
  c.loadout.forEach((ability, index) => {
    const slot = document.createElement('div');
    const isCurrent = index === c.abilityCursor;
    slot.className = 'ability-slot live' + (ability ? '' : ' empty') + (isCurrent ? ' current' : '');
    slot.id = `ability-slot-${index}`;
    const statusText = isCurrent && c.castRoundsRemaining > 0 ? `charging (${c.castRoundsRemaining} left)` : isCurrent ? 'next up' : '';
    slot.innerHTML = ability
      ? `<span class="ability-slot-name">${ability.name}</span><span>${statusText}</span><div class="ability-slot-fill" id="ability-slot-fill-${index}"></div>`
      : '<span>Empty</span>';
    row.appendChild(slot);
  });
}

async function startFight(enemyId) {
  try {
    await api('/api/combat/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, enemyId }),
    });
  } catch {
    return;
  }
  await refreshMe();
}

async function endCombat() {
  try {
    await api('/api/combat/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId }),
    });
  } catch {
    return;
  }
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
    await api('/api/garden/plant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, plotIndex, plantId }),
    });
  } catch {
    return;
  }
  await refreshMe();
}

async function harvestPlot(plotIndex) {
  let result;
  try {
    result = await api('/api/garden/harvest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, plotIndex }),
    });
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
    result = await api('/api/craft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, recipeId }),
    });
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
    result = await api('/api/alchemy/experiment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, ingredientA, ingredientB }),
    });
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
    result = await api('/api/alchemy/craft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, recipeId }),
    });
  } catch {
    return;
  }
  showToast(`Brewed ${result.resultName}!`);
  await refreshMe();
}

async function usePotion(itemId) {
  let result;
  try {
    result = await api('/api/potion/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, itemId }),
    });
  } catch {
    return;
  }
  showToast(`Used ${state.itemsMeta[itemId].name}!`);
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
    await api('/api/farm/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, species: speciesId }),
    });
  } catch {
    return;
  }
  showToast(`Bought a ${state.animalSpeciesMeta[speciesId].name}!`);
  await refreshMe();
}

async function collectAnimal(animalId) {
  let result;
  try {
    result = await api('/api/farm/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, animalId }),
    });
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
    await api('/api/building/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, buildingType }),
    });
  } catch {
    return;
  }
  showToast(`Built ${state.buildingsMeta[buildingType].name}!`);
  await refreshMe();
}

async function collectBuildingUI(buildingType) {
  let result;
  try {
    result = await api('/api/building/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, buildingType }),
    });
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
    await api('/api/quest/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, questId }),
    });
  } catch {
    return;
  }
  await refreshMe();
  if (!document.getElementById('dialogue-modal').classList.contains('hidden')) renderDialogueQuestPanel();
}

async function turnInQuestUI(questId) {
  let result;
  try {
    result = await api('/api/quest/turn-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, questId }),
    });
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
    await api('/api/shop/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, itemId }),
    });
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
    result = await api('/api/shop/sell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, itemId, amount }),
    });
  } catch {
    return;
  }
  showToast(`Sold ${result.amount}x ${state.itemsMeta[itemId].name} for ${result.goldEarned} gold!`);
  await refreshMe();
}

async function buyLocationReveal() {
  let result;
  try {
    result = await api('/api/shop/buy-location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId }),
    });
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

// clientX/clientY-based (not the raw event) so touch handlers can share this
// exact logic — a tap is just a click with coordinates read from
// changedTouches instead of the event itself.
function handlePointerClick(clientX, clientY) {
  if (state.drawMode) return; // clicks while drawing are handled by the down/move/up flow instead
  if (state.wasPanning) {
    // this click is the tail end of a pan drag, not an intentional
    // click-to-travel — suppress it once, then go back to normal
    state.wasPanning = false;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const clickX = (clientX - rect.left) * scaleX;
  const clickY = (clientY - rect.top) * scaleY;
  for (const marker of state.markers) {
    const dx = clickX - marker.x;
    const dy = clickY - marker.y;
    if (Math.sqrt(dx * dx + dy * dy) <= marker.r + 4) {
      travelTo(marker.locationId);
      return;
    }
  }
}

function onCanvasClick(e) {
  handlePointerClick(e.clientX, e.clientY);
}

function showToast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  setTimeout(() => {
    if (el.textContent === text) el.textContent = '';
  }, 4000);
}

// Split out from render() because this also needs to update live, every
// animation frame, while the player is actively dragging a route — render()
// itself only runs on data changes (poll/websocket), which is too infrequent
// for a smooth "distance so far" readout during a drag.
function renderExplorationPanel() {
  const supplies = state.player.inventory.find((i) => i.id === 'supplies');
  const suppliesCount = supplies ? supplies.count : 0;
  const maxRange = state.player.maxExplorationRange;
  document.getElementById('supplies-info').textContent =
    `Supplies: ${suppliesCount} (max range: ${maxRange.toFixed(1)})`;

  const exploreBtn = document.getElementById('explore-btn');
  const drawHint = document.getElementById('draw-hint');
  const drawStatus = document.getElementById('draw-status');
  const drawControls = document.getElementById('draw-controls');
  const confirmBtn = document.getElementById('confirm-btn');
  const hasPendingPath = state.drawPath.length >= 2 && state.drawLength > 0;

  if (state.player.expedition) {
    exploreBtn.classList.remove('hidden');
    exploreBtn.disabled = true;
    // Use the same smooth, fixed-anchor fraction the map's sweep line uses
    // (not the raw server-reported fraction, which only changes once per
    // ~300ms poll) — otherwise this text visibly jumps in chunks every poll
    // while the line animates every frame, and the two read as wildly
    // different speeds even though they're tracking the same underlying
    // progress.
    const sync = state.expeditionSync;
    const liveFraction = sync
      ? Math.min(1, Math.max(0, (Date.now() - sync.startedAt) / 1000 / sync.durationSeconds))
      : state.player.expedition.fraction;
    exploreBtn.textContent = `Expedition underway (${Math.round(liveFraction * 100)}%)`;
    drawHint.classList.add('hidden');
    drawStatus.classList.add('hidden');
    drawControls.classList.add('hidden');
  } else if (state.drawMode) {
    exploreBtn.classList.add('hidden');
    drawHint.classList.toggle('hidden', hasPendingPath || state.isDrawing);
    drawStatus.classList.remove('hidden');
    const unitPerSupply = suppliesCount > 0 ? maxRange / suppliesCount : 0;
    const suppliesCost = state.drawLength > 0 ? Math.max(1, Math.ceil(state.drawLength / unitPerSupply)) : 0;
    drawStatus.textContent = `Route: ${state.drawLength.toFixed(1)} / ${maxRange.toFixed(1)}  —  Supplies to use: ${suppliesCost} / ${suppliesCount}`;
    // Cancel must stay reachable the entire time draw mode is active (not
    // just once a path exists) — without this, a player who clicks Explore
    // and then doesn't draw anything has no visible way back out at all,
    // since the Explore button itself is hidden for the whole time
    // draw-mode is on. Confirm only makes sense once there's an actual path.
    drawControls.classList.toggle('hidden', state.isDrawing);
    confirmBtn.classList.toggle('hidden', !hasPendingPath);
  } else {
    exploreBtn.classList.remove('hidden');
    exploreBtn.disabled = suppliesCount <= 0;
    exploreBtn.textContent = suppliesCount <= 0 ? 'Need Supplies to Explore' : 'Explore';
    drawHint.classList.add('hidden');
    drawStatus.classList.add('hidden');
    drawControls.classList.add('hidden');
  }
}

function render() {
  if (!state.player) return;

  const gold = state.player.inventory.find((i) => i.id === 'gold');
  document.getElementById('gold-display').textContent = `Gold: ${gold ? gold.count : 0}`;

  // sidebar: current location
  const currentLoc = state.locations.find((l) => l.id === state.player.currentLocation);
  document.getElementById('current-location').textContent = `Location: ${currentLoc ? currentLoc.name : '--'}`;

  renderExplorationPanel();
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

function drawMap() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#24382c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  state.markers = [];

  const discovered = state.locations.filter((l) => state.player.discoveries.includes(l.id));

  for (const loc of discovered) {
    const { x, y } = percentToPixel(loc.x, loc.y);
    const isCurrent = loc.id === state.player.currentLocation;
    const radius = 10;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isCurrent ? '#d8b04a' : loc.combat ? '#b3543f' : '#e8ddc7';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#14110f';
    ctx.stroke();

    ctx.fillStyle = '#e8ddc7';
    ctx.font = '14px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(loc.name, x, y - radius - 8);

    state.markers.push({ x, y, r: radius, locationId: loc.id });
  }

  // other players, offset by index so multiple at the same spot don't fully overlap
  const grouped = {};
  for (const other of state.others) {
    grouped[other.locationId] = grouped[other.locationId] || [];
    grouped[other.locationId].push(other);
  }
  for (const [locationId, players] of Object.entries(grouped)) {
    const loc = state.locations.find((l) => l.id === locationId);
    if (!loc) continue;
    const { x: baseX, y: baseY } = percentToPixel(loc.x, loc.y);
    players.forEach((p, i) => {
      const ox = baseX + 18 + (i % 3) * 14;
      const oy = baseY + 14 + Math.floor(i / 3) * 14;
      ctx.beginPath();
      ctx.arc(ox, oy, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#7fae5a';
      ctx.fill();
      ctx.font = '11px Georgia, serif';
      ctx.fillStyle = '#c9bfa7';
      ctx.textAlign = 'left';
      ctx.fillText(p.username, ox + 8, oy + 4);
    });
  }

  drawExpedition();
  drawInProgressPath();
}

// The full committed route, drawn faint, plus a brighter overlay that
// sweeps along it as the expedition progresses — same "reveals locations
// without pausing" idea as the mining clock, just along a path instead of
// in a circle. Computed every frame straight from the expedition's fixed
// startedAt/durationSeconds (set once in refreshMe(), not re-derived from
// each poll) so it's a smooth, drift-free sweep regardless of poll timing.
function drawExpedition() {
  const sync = state.expeditionSync;
  if (!sync) return;

  const fraction = Math.min(1, Math.max(0, (Date.now() - sync.startedAt) / 1000 / sync.durationSeconds));

  const pixelPath = sync.path.map((p) => percentToPixel(p.x, p.y));

  ctx.beginPath();
  ctx.moveTo(pixelPath[0].x, pixelPath[0].y);
  for (const p of pixelPath.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = 'rgba(216, 176, 74, 0.35)';
  ctx.lineWidth = 3;
  ctx.setLineDash([6, 6]);
  ctx.stroke();
  ctx.setLineDash([]);

  // targetLength/sync.totalLength are in percent-space units (matching
  // sync.path's coordinates), so segment lengths must be measured in that
  // same space too — measuring them in pixel-space instead (10-16x larger
  // per unit) made the very first segment blow past the target almost
  // immediately, stopping the visible sweep within its first few percent
  // regardless of the true fraction. Pixel coordinates are only used for
  // where to actually draw, not for measuring distance.
  const targetLength = sync.totalLength * fraction;
  let coveredLength = 0;
  ctx.beginPath();
  ctx.moveTo(pixelPath[0].x, pixelPath[0].y);
  for (let i = 1; i < sync.path.length; i++) {
    const aPct = sync.path[i - 1];
    const bPct = sync.path[i];
    const aPixel = pixelPath[i - 1];
    const bPixel = pixelPath[i];
    const segLength = Math.hypot(bPct.x - aPct.x, bPct.y - aPct.y);
    if (coveredLength + segLength <= targetLength || sync.totalLength === 0) {
      ctx.lineTo(bPixel.x, bPixel.y);
      coveredLength += segLength;
    } else {
      const remaining = Math.max(0, targetLength - coveredLength);
      const ratio = segLength > 0 ? remaining / segLength : 0;
      ctx.lineTo(aPixel.x + (bPixel.x - aPixel.x) * ratio, aPixel.y + (bPixel.y - aPixel.y) * ratio);
      break;
    }
  }
  ctx.strokeStyle = '#ffd75e';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawInProgressPath() {
  if (!state.drawMode || state.drawPath.length < 2) return;
  const pixelPath = state.drawPath.map((p) => percentToPixel(p.x, p.y));
  ctx.beginPath();
  ctx.moveTo(pixelPath[0].x, pixelPath[0].y);
  for (const p of pixelPath.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = '#ffd75e';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
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

// The arena: player dot fixed at center; each enemy is positioned at its own
// fixed angle (assigned once at fight start, never changed — see
// COMBAT_GROUP_ANGLES server-side) and a radius scaled from its own
// distance, so multiple enemies spread around the top arc instead of
// stacking on the player or each other. angle 0 = straight up, matching the
// original single-enemy layout; positive angles sweep clockwise. A dashed
// ring marks the melee-range boundary so it's visually obvious when a melee
// ability would whiff against a given enemy. The nearest living enemy (the
// player's default target for offensive abilities) gets a subtle highlight
// ring so it's clear who an attack will actually land on.
function drawArena(c) {
  const canvas = document.getElementById('arena-canvas');
  if (!canvas) return;
  const actx = canvas.getContext('2d');
  const size = canvas.width;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 20;
  actx.clearRect(0, 0, size, size);

  const meleeR = (c.meleeRange / c.maxDistance) * maxR;
  actx.beginPath();
  actx.arc(cx, cy, meleeR, 0, Math.PI * 2);
  actx.strokeStyle = 'rgba(216, 176, 74, 0.35)';
  actx.lineWidth = 1;
  actx.setLineDash([4, 4]);
  actx.stroke();
  actx.setLineDash([]);

  const living = c.enemies.filter((e) => e.alive);
  const target = living.reduce((a, b) => (!a || b.distance < a.distance ? b : a), null);

  for (const e of c.enemies) {
    const r = Math.min(maxR, (e.distance / c.maxDistance) * maxR);
    const theta = (e.angle * Math.PI) / 180;
    const ex = cx + Math.sin(theta) * r;
    const ey = cy - Math.cos(theta) * r;

    if (e.alive) {
      actx.beginPath();
      actx.moveTo(cx, cy);
      actx.lineTo(ex, ey);
      actx.strokeStyle = 'rgba(216, 176, 74, 0.2)';
      actx.lineWidth = 1;
      actx.stroke();
    }

    if (e.alive && target && e.uid === target.uid) {
      actx.beginPath();
      actx.arc(ex, ey, 17, 0, Math.PI * 2);
      actx.strokeStyle = 'rgba(216, 176, 74, 0.7)';
      actx.lineWidth = 2;
      actx.stroke();
    }

    actx.beginPath();
    actx.arc(ex, ey, 12, 0, Math.PI * 2);
    actx.fillStyle = e.alive ? '#c0392b' : '#5a4a42';
    actx.fill();
    actx.strokeStyle = e.alive ? '#ffb3a1' : '#8a7a6f';
    actx.lineWidth = 2;
    actx.stroke();
  }

  actx.beginPath();
  actx.arc(cx, cy, 10, 0, Math.PI * 2);
  actx.fillStyle = '#d8b04a';
  actx.fill();
  actx.strokeStyle = '#fff3c9';
  actx.lineWidth = 2;
  actx.stroke();
}

// Animates the current loadout slot's fill bar between polls — now tracking
// "time until the next combat round resolves" rather than a per-ability cast
// timer (rounds are the shared unit for both the player and every enemy).
// Same fixed-anchor extrapolation trick as the mining/gather clocks: server
// sends nextTickAt + tickIntervalSeconds once, client recomputes the
// fraction fresh every frame from real elapsed time.
function updateAbilitySlotFill(c) {
  if (c.abilityCursor < 0 || c.abilityCursor > 5) return;
  const fillEl = document.getElementById(`ability-slot-fill-${c.abilityCursor}`);
  if (!fillEl || !c.nextTickAt || !c.tickIntervalSeconds) return;
  const msUntilNextTick = c.nextTickAt - Date.now();
  const fraction = Math.min(1, Math.max(0, 1 - msUntilNextTick / (c.tickIntervalSeconds * 1000)));
  fillEl.style.width = `${fraction * 100}%`;
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

      if (state.player.combat && !state.player.combat.result) {
        drawArena(state.player.combat);
        updateAbilitySlotFill(state.player.combat);
      }

      drawMap();

      if (state.drawMode || state.player.expedition) {
        renderExplorationPanel();
      }
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
    const r = await api('/api/dev/give', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, itemId, amount }),
    });
    await refreshMe();
    console.log(`[dev] ${itemId} -> ${r.count}`);
    return r;
  },
  async discover(locationId) {
    const r = await api('/api/dev/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, locationId }),
    });
    await refreshMe();
    console.log(`[dev] discovered ${locationId}`);
    return r;
  },
  async setXp(skillId, xp) {
    const r = await api('/api/dev/set-xp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, skillId, xp }),
    });
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
    await api('/api/dev/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId }),
    });
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

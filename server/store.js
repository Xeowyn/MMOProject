const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// When bundled into a standalone .exe (see tools/build-exe.js), __dirname
// points inside the packaged binary's read-only virtual filesystem, so the
// save file has to live next to the real .exe on disk instead.
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

// Can be overridden so tests can use a scratch file instead of the real
// save data.
const DB_PATH = process.env.MMO_DB_PATH || path.join(BASE_DIR, 'data', 'db.json');

const XP_PER_LEVEL = 100; // cost of the very first level-up (level 1 -> 2)
const XP_LEVEL_INCREMENT = 15; // each subsequent level costs this much more than the last


// --- traits (point-buy stats picked at character creation) ---
// Every trait starts at TRAIT_BASE; the player spreads TRAIT_EXTRA_POINTS
// across the 4 traits when creating their character, each clamped between
// TRAIT_MIN and TRAIT_MAX. After that, traits can only go up further by
// spending points earned from leveling up (see allocateTraitPoint()).
const TRAIT_KEYS = ['strength', 'dexterity', 'luck', 'vigor'];
const TRAIT_BASE = 5;
const TRAIT_MIN = 1;
const TRAIT_MAX = 10;
const TRAIT_EXTRA_POINTS = 10;

// Character-level xp is separate from skill xp — earned by discovering new
// locations.
const DISCOVERY_XP = 25;

// Perks are permanent one-time unlocks bought with perk points earned from
// leveling up, grouped into tiers unlocked at higher levels.
const PERKS = {
  brute_force: { name: 'Brute Force', description: '+10% melee damage.', tier: 1, requiresLevel: 1, cost: 1, effect: { type: 'meleeDamageMult', value: 0.1 } },
  swift_strikes: { name: 'Swift Strikes', description: '+8% damage on every ability.', tier: 1, requiresLevel: 1, cost: 1, effect: { type: 'bonusDamageMult', value: 0.08 } },
  lucky_strikes: { name: 'Lucky Strikes', description: '+5% critical hit chance.', tier: 1, requiresLevel: 1, cost: 1, effect: { type: 'critChance', value: 0.05 } },
  iron_skin: { name: 'Iron Skin', description: '+3 armor.', tier: 1, requiresLevel: 1, cost: 1, effect: { type: 'armorFlat', value: 3 } },
  vitality: { name: 'Vitality', description: '+15 max HP.', tier: 1, requiresLevel: 1, cost: 1, effect: { type: 'maxHpFlat', value: 15 } },
  green_thumb: { name: 'Green Thumb', description: '+15% plant growth speed.', tier: 1, requiresLevel: 1, cost: 1, effect: { type: 'plantGrowthMult', value: 0.15 } },
  prospector: { name: 'Prospector', description: '+10% mining speed.', tier: 2, requiresLevel: 5, cost: 1, effect: { type: 'miningSpeedMult', value: 0.1 } },
  woodsman: { name: 'Woodsman', description: '+10% woodcutting speed.', tier: 2, requiresLevel: 5, cost: 1, effect: { type: 'woodcuttingSpeedMult', value: 0.1 } },
  anglers_patience: { name: "Angler's Patience", description: '+10% fishing speed.', tier: 2, requiresLevel: 5, cost: 1, effect: { type: 'fishingSpeedMult', value: 0.1 } },
  treasure_hunter: { name: 'Treasure Hunter', description: '+10% success chance on Hunting/Scavenging/Harvesting.', tier: 2, requiresLevel: 5, cost: 1, effect: { type: 'gatherSuccessBonus', value: 0.1 } },
  brutal_force: { name: 'Brutal Force', description: '+15% melee damage (stacks with Brute Force).', tier: 3, requiresLevel: 10, cost: 1, effect: { type: 'meleeDamageMult', value: 0.15 } },
  adrenal_focus: { name: 'Adrenal Focus', description: '+12% damage on every ability (stacks with Swift Strikes).', tier: 3, requiresLevel: 10, cost: 1, effect: { type: 'bonusDamageMult', value: 0.12 } },
  deep_roots: { name: 'Deep Roots', description: '+20% plant growth speed (stacks with Green Thumb).', tier: 3, requiresLevel: 10, cost: 1, effect: { type: 'plantGrowthMult', value: 0.2 } },
  hardened: { name: 'Hardened', description: '+5 armor, +25 max HP.', tier: 3, requiresLevel: 10, cost: 1, effect: { type: 'armorFlat', value: 5 } },
};

// --- mining nodes (Melvor-Idle-style skill grid) ---
// Mining doesn't care where the player currently is standing — once a
// node's location has been discovered, it can be mined from the Mining tab
// from anywhere. Nodes are ordered with weaker ores near the starting
// location and rarer ores farther out.
const MINING_NODES = {
  // Always unlocked, since the starting location is always discovered.
  // Deliberately the weakest node here, so the ores found further out are
  // worth traveling for.
  stone: { name: 'Loose Rocks', item: 'stone', locationId: 'wanderers_camp', tier: 1, cycleSeconds: 2, xpPerItem: 2 },
  copper: { name: 'Copper Vein', item: 'copper_ore', locationId: 'wyrmwood_hold', tier: 1, cycleSeconds: 2.5, xpPerItem: 4 }, // dist ~10.7
  tin: { name: 'Tin Vein', item: 'tin_ore', locationId: 'moonshade_reach', tier: 1, cycleSeconds: 2.5, xpPerItem: 4 }, // dist ~13.3
  coal: { name: 'Coal Seam', item: 'coal', locationId: 'duskhollow_crossing', tier: 2, cycleSeconds: 3.5, xpPerItem: 8 }, // dist ~13.9
  iron: { name: 'Iron Vein', item: 'iron_ore', locationId: 'ironbrook_mine', tier: 2, cycleSeconds: 3, xpPerItem: 5 }, // dist ~27.4
  silver: { name: 'Silver Vein', item: 'silver_ore', locationId: 'tidewater_spire', tier: 3, cycleSeconds: 4, xpPerItem: 11 }, // dist ~32.9
  gold: { name: 'Gold Vein', item: 'gold_ore', locationId: 'duskmere_mine', tier: 3, cycleSeconds: 4.5, xpPerItem: 14 }, // dist ~33.3
  mithril: { name: 'Mithril Vein', item: 'mithril_ore', locationId: 'ruined_mine', tier: 4, cycleSeconds: 5.5, xpPerItem: 20 }, // dist ~38.8
};

// Woodcutting and fishing work exactly like mining: one item guaranteed
// per cycle, workable from anywhere once the node's location is unlocked.
const WOODCUTTING_NODES = {
  camp_grove: { name: 'Camp Grove', item: 'wood', locationId: 'wanderers_camp', tier: 1, cycleSeconds: 4, xpPerItem: 5 },
  gladewind_grove: { name: 'Gladewind Grove', item: 'oak_wood', locationId: 'gladewind_grove', tier: 2, cycleSeconds: 5, xpPerItem: 9 },
};
const FISHING_NODES = {
  camp_pond: { name: 'Camp Pond', item: 'fish', locationId: 'wanderers_camp', tier: 1, cycleSeconds: 5, xpPerItem: 6 },
  grimwater_bridge: { name: 'Grimwater Bridge', item: 'trout', locationId: 'grimwater_bridge', tier: 2, cycleSeconds: 6, xpPerItem: 10 },
};

// sellPrice: how much gold selling one of this item back to the shop pays.
// Every item has one except 'gold' itself. For anything also bought at the
// shop, sellPrice is roughly half the buy price, so buying just to resell
// isn't a way to make free money.
const ITEMS = {
  iron_ore: { name: 'Iron Ore', sellPrice: 2 },
  // mining node grid ores (see MINING_NODES) — sellPrice roughly scales with tier
  copper_ore: { name: 'Copper Ore', sellPrice: 1 },
  tin_ore: { name: 'Tin Ore', sellPrice: 1 },
  coal: { name: 'Coal', sellPrice: 3 },
  silver_ore: { name: 'Silver Ore', sellPrice: 5 },
  gold_ore: { name: 'Gold Ore', sellPrice: 7 },
  mithril_ore: { name: 'Mithril Ore', sellPrice: 12 },
  supplies: { name: 'Supplies', sellPrice: 3 },
  stone: { name: 'Stone', sellPrice: 1 },
  wood: { name: 'Wood', sellPrice: 2 },
  oak_wood: { name: 'Oak Wood', sellPrice: 4 },
  fish: { name: 'Fish', sellPrice: 2 },
  trout: { name: 'Trout', sellPrice: 4 },
  thick_hide: { name: 'Thick Hide', sellPrice: 6 },
  gold: { name: 'Gold' },
  // weapons — damage is a [min,max] roll per hit, attackSpeed is seconds between attacks
  rusty_sword: { name: 'Rusty Sword', type: 'weapon', damage: [4, 7], critChance: 0.05, attackSpeed: 2.0, sellPrice: 25 },
  hunting_bow: { name: 'Hunting Bow', type: 'weapon', damage: [3, 5], critChance: 0.1, attackSpeed: 1.5, sellPrice: 40 },
  iron_dagger: {
    name: 'Iron Dagger',
    type: 'weapon',
    damage: [2, 4],
    critChance: 0.15,
    attackSpeed: 1.0,
    effect: { type: 'poison', chance: 0.25, dps: 2, duration: 4 },
    sellPrice: 50,
  },
  // armor — flat damage reduction on incoming hits
  leather_vest: { name: 'Leather Vest', type: 'armor', armor: 3, sellPrice: 20 },
  iron_plate: { name: 'Iron Plate', type: 'armor', armor: 6, sellPrice: 45 },
  // gardening
  wheat_seed: { name: 'Wheat Seed', sellPrice: 2 },
  carrot_seed: { name: 'Carrot Seed', sellPrice: 4 },
  potato_seed: { name: 'Potato Seed', sellPrice: 6 },
  wheat_crop: { name: 'Wheat', sellPrice: 3 },
  carrot_crop: { name: 'Carrot', sellPrice: 4 },
  potato_crop: { name: 'Potato', sellPrice: 6 },
  // farming (animal produce)
  milk: { name: 'Milk', sellPrice: 4 },
  egg: { name: 'Egg', sellPrice: 3 },
  pork: { name: 'Pork', sellPrice: 9 },
  // gather tasks
  raw_meat: { name: 'Raw Meat', sellPrice: 4 },
  // rare gather-task jackpot armor — deliberately better than the shop's
  // best armor (iron_plate, armor 6), since it's meant to feel like a real
  // find at 0.01% odds
  wanderers_plate: { name: "Wanderer's Plate", type: 'armor', armor: 12, sellPrice: 70 },
  // alchemy ingredients — never crafted or bought, only found via
  // harvesting/scavenging (flora) or combat loot (monster parts). Inert on
  // their own; only useful combined via experimentAlchemy().
  sunpetal: { name: 'Sunpetal', type: 'ingredient', sellPrice: 5 },
  moonleaf: { name: 'Moonleaf', type: 'ingredient', sellPrice: 5 },
  redcap_cap: { name: 'Redcap Mushroom', type: 'ingredient', sellPrice: 5 },
  bog_root: { name: 'Bog Root', type: 'ingredient', sellPrice: 5 },
  rat_tail: { name: 'Rat Tail', type: 'ingredient', sellPrice: 6 },
  wolf_fang: { name: 'Wolf Fang', type: 'ingredient', sellPrice: 6 },
  zombie_ichor: { name: 'Zombie Ichor', type: 'ingredient', sellPrice: 6 },
  // trophy drops from the 5 new tier-2-4 enemies — sellable flavor items,
  // not alchemy ingredients (kept separate from POTION_RECIPES scope for now)
  bandit_dagger: { name: "Bandit's Dagger", sellPrice: 8 },
  spider_silk: { name: 'Spider Silk', sellPrice: 9 },
  orc_tusk: { name: 'Orc Tusk', sellPrice: 14 },
  wraith_essence: { name: 'Wraith Essence', sellPrice: 16 },
  troll_hide: { name: 'Troll Hide', sellPrice: 25 },
  archer_quiver: { name: "Archer's Quiver", sellPrice: 10 },
  // alchemy potions — result items of POTION_RECIPES, consumed via
  // submitCombatItemAction() during combat only (see potionEffect.kind)
  healing_potion: { name: 'Healing Potion', type: 'potion', potionEffect: { kind: 'heal', amount: 30 }, sellPrice: 18 },
  antidote: { name: 'Antidote', type: 'potion', potionEffect: { kind: 'cure' }, sellPrice: 18 },
  potion_of_strength: {
    name: 'Potion of Strength',
    type: 'potion',
    potionEffect: { kind: 'buff_damage', multiplier: 1.5, durationSeconds: 15 },
    sellPrice: 22,
  },
  potion_of_swiftness: {
    // Was an attack-speed buff back when combat ran in real time — with
    // turn-based combat there's no "speed" left to boost, so this is now a
    // flat bonus to dodge chance instead (kind stays 'buff_speed' for
    // save-data/recipe continuity, but see resolveEnemyAttackOn()'s
    // 'evasion'-type buff for what it actually does now).
    name: 'Potion of Swiftness',
    type: 'potion',
    potionEffect: { kind: 'buff_speed', multiplier: 0.35, durationSeconds: 15 },
    sellPrice: 22,
  },
  venom_draught: {
    name: 'Venom Draught',
    type: 'potion',
    potionEffect: { kind: 'poison_enemy', dps: 5, duration: 6 },
    sellPrice: 22,
  },
};

// Fixed per-creature attacks/effects (not derived from equipment, unlike the
// player) — goldReward/xpReward are [min,max] rolled on a win. Every enemy
// takes its one action each round the same way now (see resolveEnemyTurns()):
// attack the player, with a chance of its effect (poison, etc) on a hit —
// there's no more positioning/range to close, so what used to differentiate
// enemy archetypes is now purely damage/crit/effect stats.
const ENEMIES = {
  giant_rat: {
    name: 'Giant Rat',
    maxHp: 20,
    damage: [1, 3],
    critChance: 0.05,
    attackSpeed: 1.8,
    effect: null,
    goldReward: [2, 5],
    xpReward: 5,
    lootTable: [{ item: 'rat_tail', chance: 0.25 }],
  },
  wolf: {
    name: 'Wolf',
    maxHp: 35,
    damage: [3, 6],
    critChance: 0.08,
    attackSpeed: 1.5,
    effect: null,
    goldReward: [5, 10],
    xpReward: 10,
    lootTable: [{ item: 'wolf_fang', chance: 0.25 }],
  },
  bog_zombie: {
    name: 'Bog Zombie',
    maxHp: 50,
    damage: [4, 8],
    critChance: 0.05,
    attackSpeed: 2.5,
    effect: { type: 'poison', chance: 0.3, dps: 2, duration: 4 },
    goldReward: [8, 15],
    xpReward: 15,
    lootTable: [{ item: 'zombie_ichor', chance: 0.25 }],
  },
  // Added so the ~40 previously-empty locations have varied, tier-appropriate
  // fights instead of reusing just these original 3 everywhere — tiers
  // loosely track distance-from-center the same way MINING_NODES' tiers do
  // (see LOCATIONS' combat assignments below).
  bandit: {
    // tier 1 — a human raider, close to the starting area
    name: 'Bandit',
    maxHp: 25,
    damage: [2, 5],
    critChance: 0.08,
    attackSpeed: 1.7,
    effect: null,
    goldReward: [4, 9],
    xpReward: 7,
    lootTable: [{ item: 'bandit_dagger', chance: 0.2 }],
  },
  forest_spider: {
    // tier 2 — fast, poisonous
    name: 'Forest Spider',
    maxHp: 30,
    damage: [2, 4],
    critChance: 0.1,
    attackSpeed: 1.4,
    effect: { type: 'poison', chance: 0.35, dps: 2, duration: 3 },
    goldReward: [4, 8],
    xpReward: 9,
    lootTable: [{ item: 'spider_silk', chance: 0.25 }],
  },
  forest_archer: {
    // tier 2 — hits from the first shot, no melee whiff risk to weigh
    // against (there's no more range to be out of)
    name: 'Forest Archer',
    maxHp: 26,
    damage: [3, 6],
    critChance: 0.1,
    attackSpeed: 1.6,
    effect: null,
    goldReward: [5, 10],
    xpReward: 10,
    lootTable: [{ item: 'archer_quiver', chance: 0.25 }],
  },
  orc_raider: {
    // tier 3 — a real step up in raw damage
    name: 'Orc Raider',
    maxHp: 55,
    damage: [5, 9],
    critChance: 0.07,
    attackSpeed: 2.0,
    effect: null,
    goldReward: [10, 18],
    xpReward: 18,
    lootTable: [{ item: 'orc_tusk', chance: 0.25 }],
  },
  marsh_wraith: {
    // tier 3 — a ghostly poisoner, favors a high crit chance over raw damage
    name: 'Marsh Wraith',
    maxHp: 45,
    damage: [4, 8],
    critChance: 0.15,
    attackSpeed: 2.2,
    effect: { type: 'poison', chance: 0.4, dps: 3, duration: 4 },
    goldReward: [10, 16],
    xpReward: 18,
    lootTable: [{ item: 'wraith_essence', chance: 0.25 }],
  },
  stone_troll: {
    // tier 4 — the toughest fight in the game right now, a real "boss" feel
    // for the far-flung locations
    name: 'Stone Troll',
    maxHp: 90,
    damage: [8, 14],
    critChance: 0.05,
    attackSpeed: 2.8,
    effect: null,
    goldReward: [20, 35],
    xpReward: 35,
    lootTable: [{ item: 'troll_hide', chance: 0.3 }],
  },
};

const MAX_ENCOUNTER_GROUP_SIZE = 3;

const PLANTS = {
  wheat: { name: 'Wheat', seed: 'wheat_seed', growSeconds: 60, yield: 'wheat_crop' },
  carrot: { name: 'Carrot', seed: 'carrot_seed', growSeconds: 90, yield: 'carrot_crop' },
  potato: { name: 'Potato', seed: 'potato_seed', growSeconds: 120, yield: 'potato_crop' },
};
const GARDEN_PLOT_COUNT = 24;

// Converts garden crops into supplies — the resource overworld movement
// spends one of per tile walked — so gardening and exploration feed into
// each other instead of being isolated systems. resultAmount scales with
// the crop's grow time (potato
// takes longest to grow, so it converts to the most supplies) to keep the
// three crop types roughly comparable in supplies-per-second-grown.
const RECIPES = [
  { id: 'wheat_supplies', ingredients: { wheat_crop: 2 }, result: 'supplies', resultAmount: 1 },
  { id: 'carrot_supplies', ingredients: { carrot_crop: 2 }, result: 'supplies', resultAmount: 2 },
  { id: 'potato_supplies', ingredients: { potato_crop: 2 }, result: 'supplies', resultAmount: 3 },
  { id: 'meat_supplies', ingredients: { raw_meat: 2 }, result: 'supplies', resultAmount: 2 },
];

// Unlike RECIPES (crafting), these are never sent to the client as a full
// list — the whole point of alchemy is that players don't know the combos
// up front and have to discover them by experimenting. Each recipe always
// combines exactly two different ingredients, one of each.
const POTION_RECIPES = [
  { id: 'healing_potion', ingredients: { sunpetal: 1, moonleaf: 1 }, result: 'healing_potion' },
  { id: 'antidote', ingredients: { redcap_cap: 1, bog_root: 1 }, result: 'antidote' },
  { id: 'potion_of_strength', ingredients: { wolf_fang: 1, sunpetal: 1 }, result: 'potion_of_strength' },
  { id: 'potion_of_swiftness', ingredients: { rat_tail: 1, moonleaf: 1 }, result: 'potion_of_swiftness' },
  { id: 'venom_draught', ingredients: { zombie_ichor: 1, bog_root: 1 }, result: 'venom_draught' },
];

function ingredientComboKey(ids) {
  return [...ids].sort().join('+');
}

// Animals are bought with gold, take matureSeconds to grow up, then either
// produce an item repeatedly on a timer (cow/chicken — collect, timer
// resets) or yield a one-time butcherItem once mature and are then removed
// (pig) — same two-shape split as PLANTS (repeatable) vs a one-shot resource.
const ANIMAL_SPECIES = {
  cow: { name: 'Cow', price: 40, matureSeconds: 45, produceItem: 'milk', produceIntervalSeconds: 30 },
  chicken: { name: 'Chicken', price: 20, matureSeconds: 25, produceItem: 'egg', produceIntervalSeconds: 15 },
  pig: { name: 'Pig', price: 60, matureSeconds: 60, butcherItem: 'pork' },
};

// One of each building type per player (v1 — like equipment slots, not a
// list). Once built, passively accrues 1 unit of producesItem every
// produceIntervalSeconds, collected manually (same lazy elapsed-time math as
// tickSkills, just player-triggered instead of ticked on every poll).
const BUILDINGS = {
  sawmill: { name: 'Sawmill', cost: { gold: 60, wood: 10 }, producesItem: 'wood', produceIntervalSeconds: 20 },
  mineshaft: { name: 'Mineshaft', cost: { gold: 90, iron_ore: 10 }, producesItem: 'iron_ore', produceIntervalSeconds: 25 },
  granary: { name: 'Granary', cost: { gold: 50, wheat_crop: 5 }, producesItem: 'supplies', produceIntervalSeconds: 15 },
};

const SHOP_ITEMS = [
  { id: 'wheat_seed', price: 5 },
  { id: 'carrot_seed', price: 8 },
  { id: 'potato_seed', price: 12 },
  { id: 'supplies', price: 6 },
  { id: 'rusty_sword', price: 50 },
  { id: 'hunting_bow', price: 80 },
  { id: 'iron_dagger', price: 100 },
  { id: 'leather_vest', price: 40 },
  { id: 'iron_plate', price: 90 },
];
const LOCATION_REVEAL_PRICE = 30;

const PLAYER_BASE_HP = 50;
const PLAYER_HP_PER_LEVEL = 5;

// Combat is a classic-Roguelike grid fight: the player and every enemy
// share a small room (see generateCombatGrid()) and act in strict alternating
// turns. The player's whole turn is one step in a direction — stepping onto
// an empty tile just moves, stepping onto a tile an enemy occupies attacks
// it instead (the "bump to attack" convention Rogue popularized), and using
// a potion is the only other legal turn. There's no ability menu anymore —
// every attack uses whatever's equipped, exactly like the old "Swing"
// ability did. After the player's turn, every living enemy either steps
// toward the player (if not adjacent) or attacks (if adjacent), same as
// before: a clean 1-for-1 exchange, resolved fully server-side in a single
// request (see server.js's /api/combat/move route).
const COMBAT_GRID_WIDTH = 9;
const COMBAT_GRID_HEIGHT = 7;
const COMBAT_WALL_CHANCE = 0.12;
const COMBAT_MIN_ENEMY_DISTANCE = 3; // Chebyshev distance from the player, for a normal (non-ambush) encounter
const COMBAT_DIRECTIONS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

// Given to brand new players so movement is testable before a real supplies
// source (shop / garden) exists — see WORLD_SUPPLIES_PER_MOVE below.
const STARTER_SUPPLIES = 8;

// Overworld movement tuning. A tile is only ever discovered by physically
// stepping onto it — no field-of-view radius, no free peek at what's
// nearby. Stepping onto a tile not already in player.revealedTiles costs a
// supply and reveals it (and whatever location is on it, if any) for good;
// re-walking any tile already revealed is free forever after (see
// moveOnWorldGrid()) — supplies are the cost of genuinely new ground, not
// of moving in general.
const WORLD_SUPPLIES_PER_MOVE = 1;

// Gather tasks — Hunting/Scavenging/Harvesting. Unlocked by discovery and
// workable from anywhere, same as mining/woodcutting/fishing, except each
// completed cycle only has a *chance* of finding something instead of a
// guaranteed item. Each skill's starting camp node only gives common items —
// the better stuff only drops from nodes you have to go discover.
const HUNTING_NODES = {
  camp_hunt: {
    name: 'Camp Woods',
    locationId: 'wanderers_camp',
    tier: 1,
    cycleSeconds: 6,
    encounterChance: 0.15, // chance per cycle of a hostile animal instead of a find
    successChance: 0.3,
    attemptXp: 3, // granted every completed cycle regardless of outcome, see below
    xpPerSuccess: 10, // on top of attemptXp, only when the cycle actually finds something
    resultItem: 'raw_meat',
    huntableEnemies: ['giant_rat', 'wolf', 'bog_zombie'],
  },
  highcrest_forest: {
    name: 'Highcrest Forest',
    locationId: 'highcrest_forest',
    tier: 2,
    cycleSeconds: 7,
    encounterChance: 0.18,
    successChance: 0.3,
    attemptXp: 4,
    xpPerSuccess: 14,
    resultItem: 'thick_hide',
    huntableEnemies: ['wolf', 'bog_zombie'],
  },
};
const SCAVENGING_NODES = {
  camp_scavenge: {
    name: 'Camp Outskirts',
    locationId: 'wanderers_camp',
    tier: 1,
    cycleSeconds: 4,
    successChance: 0.3,
    attemptXp: 2,
    xpPerSuccess: 6,
    resultPool: ['supplies', 'gold', 'wood'],
  },
  ashfall_ruins: {
    name: 'Ashfall Ruins',
    locationId: 'ashfall_ruins',
    tier: 2,
    cycleSeconds: 5,
    successChance: 0.3,
    attemptXp: 3,
    xpPerSuccess: 9,
    resultPool: ['iron_ore', 'fish', 'redcap_cap', 'bog_root'],
  },
};
const HARVESTING_NODES = {
  camp_harvest: {
    name: 'Camp Garden Plot',
    locationId: 'wanderers_camp',
    tier: 1,
    cycleSeconds: 5,
    successChance: 0.3,
    attemptXp: 2,
    xpPerSuccess: 6,
    resultPool: ['wheat_seed', 'carrot_seed', 'potato_seed', 'wheat_crop', 'carrot_crop', 'potato_crop'],
  },
  duskhollow_marsh: {
    name: 'Duskhollow Marsh',
    locationId: 'duskhollow_marsh',
    tier: 2,
    cycleSeconds: 6,
    successChance: 0.3,
    attemptXp: 3,
    xpPerSuccess: 9,
    resultPool: ['sunpetal', 'moonleaf'],
  },
};

// Every resource-gathering skill's node registry in one place, keyed by
// skillId — the single source of truth tickResourceTask()/startResourceTask()/
// publicResourceNodes() all read from. DETERMINISTIC_TASKS marks which ones
// use the guaranteed-yield-per-cycle model (mining/woodcutting/fishing) vs
// the chance-per-cycle model (hunting/scavenging/harvesting) — every skill's
// nodes are one kind or the other, never mixed within a skill.
const RESOURCE_NODES = {
  mining: MINING_NODES,
  woodcutting: WOODCUTTING_NODES,
  fishing: FISHING_NODES,
  hunting: HUNTING_NODES,
  scavenging: SCAVENGING_NODES,
  harvesting: HARVESTING_NODES,
};
const DETERMINISTIC_TASKS = new Set(['mining', 'woodcutting', 'fishing']);

// Extremely rare (0.01%), checked on every completed gather-task cycle
// regardless of which task or node it was, ahead of that task's own roll —
// a jackpot layer shared across all gather tasks rather than per-task, so
// it stays meaningfully rare no matter which task is running.
const RARE_GATHER_EVENT_CHANCE = 0.0001;

const LOCATIONS = [
  { id: 'wanderers_camp', name: "Wanderer's Camp", x: 50, y: 50, skill: null, startingLocation: true, tavern: true },
  { id: 'gladewind_grove', name: 'Gladewind Grove', x: 67.1, y: 53.1, skill: 'woodcutting' },
  { id: 'grimwater_bridge', name: 'Grimwater Bridge', x: 64, y: 58.8, skill: 'fishing' },
  { id: 'moonshade_reach', name: 'Moonshade Reach', x: 49.4, y: 63.3 },
  { id: 'duskhollow_crossing', name: 'Duskhollow Crossing', x: 40.5, y: 60.1 },
  { id: 'ashfall_ruins', name: 'Ashfall Ruins', x: 32.3, y: 54.9, combat: ['bog_zombie'], skill: 'scavenging' },
  { id: 'copperhall_village', name: 'Copperhall Village', x: 36.4, y: 46.4 },
  { id: 'duskhollow_marsh', name: 'Duskhollow Marsh', x: 39.2, y: 42.7, skill: 'harvesting' },
  { id: 'wyrmwood_hold', name: 'Wyrmwood Hold', x: 48.6, y: 39.4 },
  { id: 'thornwatch_hall', name: 'Thornwatch Hall', x: 60, y: 36.6 },
  { id: 'amberfield_vale', name: 'Amberfield Vale', x: 61.8, y: 43.8, combat: ['giant_rat', 'bandit'], loot: { item: 'gold', amount: 8 } },
  { id: 'sunspire_camp', name: 'Sunspire Camp', x: 81, y: 52.3 },
  { id: 'highcrest_forest', name: 'Highcrest Forest', x: 74.2, y: 66.7, combat: ['bog_zombie'], skill: 'hunting' },
  { id: 'tidewater_grove', name: 'Tidewater Grove', x: 65, y: 68, combat: ['wolf', 'forest_spider', 'forest_archer'], loot: { item: 'fish', amount: 4 } },
  { id: 'vintermere_keep', name: 'Vintermere Keep', x: 48.5, y: 73.6 },
  { id: 'vintermere_hollow', name: 'Vintermere Hollow', x: 33.3, y: 68.2, combat: ['forest_spider'], loot: { item: 'wood', amount: 5 } },
  { id: 'ashgate_ruins', name: 'Ashgate Ruins', x: 32.8, y: 64.8, combat: ['wolf'], loot: { item: 'gold', amount: 12 } },
  { id: 'tidewater_spire', name: 'Tidewater Spire', x: 17.5, y: 55 },
  { id: 'ironbrook_mine', name: 'Ironbrook Mine', x: 23.7, y: 42.3 },
  { id: 'ravenscar_cove', name: 'Ravenscar Cove', x: 24.2, y: 35.1, combat: ['wolf'] },
  { id: 'nightshade_vale', name: 'Nightshade Vale', x: 35.6, y: 27.5, combat: ['giant_rat', 'wolf'] },
  { id: 'thornwatch_spire', name: 'Thornwatch Spire', x: 47.2, y: 27, combat: ['bog_zombie'] },
  { id: 'marrowfell_grove', name: 'Marrowfell Grove', x: 59.9, y: 29.1, combat: ['forest_spider'], loot: { item: 'wood', amount: 5 } },
  { id: 'nightshade_crossing', name: 'Nightshade Crossing', x: 79.1, y: 38.1, combat: ['marsh_wraith'], loot: { item: 'moonleaf', amount: 2 } },
  { id: 'whisperwood_camp', name: 'Whisperwood Camp', x: 75.4, y: 43.5 },
  { id: 'stonehaven_ruins', name: 'Stonehaven Ruins', x: 91.1, y: 60 },
  { id: 'duskmere_mine', name: 'Duskmere Mine', x: 77.8, y: 68.3 },
  { id: 'ironvale_hall', name: 'Ironvale Hall', x: 70, y: 77.4 },
  { id: 'crowsend_forest', name: 'Crowsend Forest', x: 63.3, y: 79.3, combat: ['orc_raider', 'wolf'], loot: { item: 'wood', amount: 8 } },
  { id: 'thornwatch_marsh', name: 'Thornwatch Marsh', x: 39.3, y: 81.3, combat: ['marsh_wraith'], loot: { item: 'redcap_cap', amount: 2 } },
  { id: 'gladewind_watch', name: 'Gladewind Watch', x: 30.6, y: 73.7, combat: ['orc_raider'], loot: { item: 'wood', amount: 8 } },
  { id: 'graywatch_reach', name: 'Graywatch Reach', x: 20.3, y: 72.1, combat: ['orc_raider'], loot: { item: 'supplies', amount: 4 } },
  { id: 'stormwatch_ruins', name: 'Stormwatch Ruins', x: 12.3, y: 50.8, combat: ['marsh_wraith'], loot: { item: 'gold', amount: 15 } },
  { id: 'ironbrook_spire', name: 'Ironbrook Spire', x: 13.7, y: 48, combat: ['orc_raider'], loot: { item: 'iron_ore', amount: 5 } },
  { id: 'crowsend_village', name: 'Crowsend Village', x: 16.6, y: 36, combat: ['orc_raider'], loot: { item: 'gold', amount: 15 } },
  { id: 'amberfield_cove', name: 'Amberfield Cove', x: 21.8, y: 24.7, combat: ['marsh_wraith'], loot: { item: 'gold', amount: 12 } },
  { id: 'amberfield_port', name: 'Amberfield Port', x: 38, y: 23.5, combat: ['wolf'], loot: { item: 'gold', amount: 10 } },
  { id: 'bleakcliff_grove', name: 'Bleakcliff Grove', x: 56.2, y: 20.8, combat: ['forest_spider'], loot: { item: 'sunpetal', amount: 2 } },
  { id: 'wraithmoor_camp', name: 'Wraithmoor Camp', x: 70.3, y: 25.3, combat: ['marsh_wraith'] },
  { id: 'wolfden_vale', name: 'Wolfden Vale', x: 84, y: 33, combat: ['orc_raider', 'stone_troll'], loot: { item: 'wolf_fang', amount: 2 } },
  { id: 'hollowmere_camp', name: 'Hollowmere Camp', x: 86.9, y: 41.5, combat: ['orc_raider', 'marsh_wraith'], loot: { item: 'gold', amount: 15 } },
  { id: 'wyrmwood_grove', name: 'Wyrmwood Grove', x: 93.2, y: 58.9, combat: ['stone_troll', 'orc_raider'], loot: { item: 'wood', amount: 10 } },
  { id: 'hollowmere_village', name: 'Hollowmere Village', x: 86.9, y: 67.9, combat: ['stone_troll'], loot: { item: 'gold', amount: 20 } },
  { id: 'deepwater_watch', name: 'Deepwater Watch', x: 69.1, y: 80.3, combat: ['orc_raider'], loot: { item: 'fish', amount: 6 } },
  { id: 'oakenshade_hall', name: 'Oakenshade Hall', x: 47, y: 87.7, combat: ['orc_raider'] },
  { id: 'shadowfen_hold', name: 'Shadowfen Hold', x: 35.9, y: 85.9, combat: ['stone_troll'] },
  { id: 'emberpeak_bridge', name: 'Emberpeak Bridge', x: 10, y: 68, combat: ['stone_troll'], loot: { item: 'gold', amount: 20 } },
  { id: 'goldmarsh_crossing', name: 'Goldmarsh Crossing', x: 5.7, y: 54.2, combat: ['stone_troll'], loot: { item: 'gold', amount: 25 } },
  { id: 'gladewind_hold', name: 'Gladewind Hold', x: 6.7, y: 36.5, combat: ['stone_troll', 'marsh_wraith'], loot: { item: 'wood', amount: 10 } },
  { id: 'ruined_mine', name: 'Ruined Mine', x: 18.1, y: 27.9 },
  { id: 'brightmoor_cove', name: 'Brightmoor Cove', x: 28, y: 17.6, combat: ['marsh_wraith', 'stone_troll'], loot: { item: 'gold', amount: 20 } },
  { id: 'marrowfell_reach', name: 'Marrowfell Reach', x: 54.9, y: 14.1, combat: ['marsh_wraith'], loot: { item: 'bog_root', amount: 2 } },
  { id: 'foxhollow_reach', name: 'Foxhollow Reach', x: 70.5, y: 19.3, combat: ['wolf', 'orc_raider'] },
  { id: 'vintermere_bridge', name: 'Vintermere Bridge', x: 87.1, y: 29.9, combat: ['orc_raider', 'stone_troll'], loot: { item: 'supplies', amount: 6 } },
  { id: 'frostmere_watch', name: 'Frostmere Watch', x: 97, y: 38.4, combat: ['stone_troll'], loot: { item: 'gold', amount: 30 } },
  { id: 'wickedge_enclave', name: 'Wickedge Enclave', x: 59.2, y: 83.9, combat: ['wolf', 'orc_raider'] },
  { id: 'silvercliff_hollow', name: 'Silvercliff Hollow', x: 85.7, y: 84.3, combat: ['wolf', 'marsh_wraith'], loot: { item: 'silver_ore', amount: 5 } },
  { id: 'foxford_fen', name: 'Foxford Fen', x: 70.2, y: 42.3, combat: ['bog_zombie'], loot: { item: 'gold', amount: 10 } },
  { id: 'coldstonemere_crossing', name: 'Coldstonemere Crossing', x: 81.6, y: 43.5, combat: ['forest_spider', 'orc_raider'], loot: { item: 'coal', amount: 5 } },
  { id: 'foxshade_bridge', name: 'Foxshade Bridge', x: 70.2, y: 85.6, combat: ['wolf', 'marsh_wraith'], loot: { item: 'gold', amount: 19 } },
  { id: 'wraithvale_haven', name: 'Wraithvale Haven', x: 36.9, y: 2.9, combat: ['orc_raider'], loot: { item: 'wolf_fang', amount: 2 } },
  { id: 'kestrelspire_keep', name: 'Kestrelspire Keep', x: 38.2, y: 88.7, combat: ['wolf', 'marsh_wraith'], loot: { item: 'wolf_fang', amount: 2 } },
  { id: 'bramblewoodburrow_enclave', name: 'Bramblewoodburrow Enclave', x: 87.5, y: 54.3, combat: ['forest_spider', 'orc_raider'], loot: { item: 'coal', amount: 6 } },
  { id: 'loamhollow_ridge', name: 'Loamhollow Ridge', x: 95.5, y: 6.8, combat: ['stone_troll'], loot: { item: 'troll_hide', amount: 1 } },
  { id: 'grimhaven_shire', name: 'Grimhaven Shire', x: 3.1, y: 42.2, combat: ['marsh_wraith'], loot: { item: 'wolf_fang', amount: 2 } },
  { id: 'grayglen_cairn', name: 'Grayglen Cairn', x: 42.5, y: 79.8, combat: ['forest_spider', 'orc_raider'], loot: { item: 'redcap_cap', amount: 2 } },
  { id: 'timberspire_sanctum', name: 'Timberspire Sanctum', x: 63, y: 49.1, combat: ['giant_rat'], loot: { item: 'supplies', amount: 4 } },
  { id: 'shadowshore_barrow', name: 'Shadowshore Barrow', x: 83.4, y: 54.6, combat: ['orc_raider'], loot: { item: 'gold', amount: 15 } },
  { id: 'reedgrove_shire', name: 'Reedgrove Shire', x: 5.6, y: 93.4, combat: ['orc_raider', 'marsh_wraith'] },
  { id: 'duskmoorhall_spire', name: 'Duskmoorhall Spire', x: 16.9, y: 91.9, combat: ['stone_troll', 'marsh_wraith'], loot: { item: 'troll_hide', amount: 2 } },
  { id: 'jademoor_glen', name: 'Jademoor Glen', x: 90, y: 78.8, combat: ['wolf', 'marsh_wraith'], loot: { item: 'gold', amount: 22 } },
  { id: 'wolfridge_hamlet', name: 'Wolfridge Hamlet', x: 41, y: 33.3, combat: ['wolf'], loot: { item: 'gold', amount: 10 } },
  { id: 'vinegap_den', name: 'Vinegap Den', x: 85.9, y: 75.3, combat: ['wolf', 'marsh_wraith'] },
  { id: 'granitemire_glen', name: 'Granitemire Glen', x: 50.9, y: 54.9, combat: ['bandit'], loot: { item: 'gold', amount: 5 } },
  { id: 'goldwick_ruins', name: 'Goldwick Ruins', x: 56.9, y: 46.4, combat: ['giant_rat', 'bandit'] },
  { id: 'elmdale_watch', name: 'Elmdale Watch', x: 2.6, y: 33.5, combat: ['orc_raider', 'marsh_wraith'] },
  { id: 'briarglade_camp', name: 'Briarglade Camp', x: 58, y: 33.6, combat: ['forest_spider'] },
  { id: 'elderkeep_vale', name: 'Elderkeep Vale', x: 7.8, y: 27, combat: ['marsh_wraith'], loot: { item: 'gold', amount: 19 } },
  { id: 'peatcrest_port', name: 'Peatcrest Port', x: 15.5, y: 58.2, combat: ['wolf', 'orc_raider'] },
  { id: 'silvershade_watch', name: 'Silvershade Watch', x: 32, y: 26.4, combat: ['marsh_wraith'], loot: { item: 'gold', amount: 14 } },
  { id: 'gorsespire_vale', name: 'Gorsespire Vale', x: 64, y: 92.1, combat: ['stone_troll'], loot: { item: 'bog_root', amount: 1 } },
  { id: 'timberhollow_overlook', name: 'Timberhollow Overlook', x: 86.4, y: 57, combat: ['forest_spider', 'orc_raider'], loot: { item: 'redcap_cap', amount: 2 } },
  { id: 'cinderwick_watch', name: 'Cinderwick Watch', x: 84.2, y: 38.9, combat: ['marsh_wraith'], loot: { item: 'redcap_cap', amount: 3 } },
  { id: 'wickreach_spire', name: 'Wickreach Spire', x: 76.6, y: 73.5, combat: ['forest_spider', 'orc_raider'] },
  { id: 'longmoorrun_hold', name: 'Longmoorrun Hold', x: 20.2, y: 41.3, combat: ['forest_spider', 'orc_raider'] },
  { id: 'mistralhollow_haven', name: 'Mistralhollow Haven', x: 19.1, y: 87.2, combat: ['orc_raider'] },
  { id: 'thornfen_keep', name: 'Thornfen Keep', x: 67.2, y: 76.2, combat: ['marsh_wraith'], loot: { item: 'moonleaf', amount: 3 } },
  { id: 'cedarglade_bridge', name: 'Cedarglade Bridge', x: 81.8, y: 29.9, combat: ['forest_spider', 'orc_raider'] },
  { id: 'larchward_den', name: 'Larchward Den', x: 12.7, y: 4.8, combat: ['stone_troll', 'orc_raider'] },
  { id: 'juniperkeep_spire', name: 'Juniperkeep Spire', x: 15.4, y: 22.6, combat: ['wolf', 'marsh_wraith'] },
  { id: 'thornkeep_encampment', name: 'Thornkeep Encampment', x: 5, y: 74.9, combat: ['stone_troll'], loot: { item: 'gold_ore', amount: 2 } },
  { id: 'heatherglade_ford', name: 'Heatherglade Ford', x: 79.1, y: 3.1, combat: ['stone_troll'], loot: { item: 'gold_ore', amount: 4 } },
  { id: 'timberhall_barrow', name: 'Timberhall Barrow', x: 11.6, y: 77.7, combat: ['orc_raider'], loot: { item: 'silver_ore', amount: 5 } },
  { id: 'willowstead_overlook', name: 'Willowstead Overlook', x: 79.2, y: 9.9, combat: ['marsh_wraith'], loot: { item: 'silver_ore', amount: 5 } },
  { id: 'reedmarsh_glen', name: 'Reedmarsh Glen', x: 64.9, y: 12.6, combat: ['stone_troll'], loot: { item: 'silver_ore', amount: 3 } },
  { id: 'stormwickbrook_glen', name: 'Stormwickbrook Glen', x: 14.8, y: 14.7, combat: ['marsh_wraith'], loot: { item: 'bog_root', amount: 1 } },
  { id: 'goldedge_bridge', name: 'Goldedge Bridge', x: 8.5, y: 41.1, combat: ['marsh_wraith'] },
  { id: 'ashenhall_cove', name: 'Ashenhall Cove', x: 16.2, y: 68.1, combat: ['wolf', 'marsh_wraith'] },
  { id: 'birchmoor_ridge', name: 'Birchmoor Ridge', x: 7.9, y: 12, combat: ['stone_troll', 'orc_raider'], loot: { item: 'mithril_ore', amount: 3 } },
  { id: 'fogbridge_moor', name: 'Fogbridge Moor', x: 47.5, y: 97.6, combat: ['orc_raider'], loot: { item: 'bog_root', amount: 2 } },
  { id: 'hollowpoint_vale', name: 'Hollowpoint Vale', x: 16.9, y: 49.9, combat: ['wolf', 'orc_raider'], loot: { item: 'gold', amount: 17 } },
  { id: 'ostwickshade_brook', name: 'Ostwickshade Brook', x: 46.4, y: 70.8, combat: ['forest_spider'], loot: { item: 'fish', amount: 6 } },
  { id: 'cinderwood_sanctum', name: 'Cinderwood Sanctum', x: 27.7, y: 76.7, combat: ['orc_raider'], loot: { item: 'gold', amount: 14 } },
  { id: 'whisperhollow_ruins', name: 'Whisperhollow Ruins', x: 18.4, y: 46.2, combat: ['orc_raider'], loot: { item: 'gold', amount: 12 } },
  { id: 'vulturelight_hamlet', name: 'Vulturelight Hamlet', x: 50.4, y: 9.1, combat: ['stone_troll'], loot: { item: 'gold', amount: 18 } },
  { id: 'elderhall_overlook', name: 'Elderhall Overlook', x: 85.4, y: 49.6, combat: ['marsh_wraith'] },
  { id: 'hazelfen_enclave', name: 'Hazelfen Enclave', x: 2.7, y: 5.9, combat: ['stone_troll'], loot: { item: 'troll_hide', amount: 2 } },
  { id: 'duskmoorgap_tower', name: 'Duskmoorgap Tower', x: 54.1, y: 85.6, combat: ['orc_raider'] },
  { id: 'ridgeglen_bridge', name: 'Ridgeglen Bridge', x: 67.9, y: 66, combat: ['bog_zombie'], loot: { item: 'sunpetal', amount: 1 } },
  { id: 'vulturelight_hollow', name: 'Vulturelight Hollow', x: 53.8, y: 47.1, combat: ['bandit'] },
  { id: 'tidedale_landing', name: 'Tidedale Landing', x: 76.3, y: 25.3, combat: ['wolf', 'orc_raider'] },
  { id: 'ivygate_barrow', name: 'Ivygate Barrow', x: 85.6, y: 70.9, combat: ['marsh_wraith'], loot: { item: 'silver_ore', amount: 2 } },
  { id: 'yewgap_shrine', name: 'Yewgap Shrine', x: 9.7, y: 64.4, combat: ['marsh_wraith'], loot: { item: 'wolf_fang', amount: 1 } },
  { id: 'marrowdale_village', name: 'Marrowdale Village', x: 19.3, y: 18.4, combat: ['marsh_wraith'], loot: { item: 'bog_root', amount: 2 } },
  { id: 'sunglen_hollow', name: 'Sunglen Hollow', x: 55, y: 25, combat: ['bog_zombie'], loot: { item: 'iron_ore', amount: 5 } },
  { id: 'ironhall_bridge', name: 'Ironhall Bridge', x: 80.1, y: 58.5, combat: ['wolf', 'orc_raider'], loot: { item: 'redcap_cap', amount: 3 } },
  { id: 'loamview_landing', name: 'Loamview Landing', x: 55.3, y: 66, combat: ['giant_rat', 'bandit'], loot: { item: 'gold', amount: 7 } },
  { id: 'granitespire_shire', name: 'Granitespire Shire', x: 21.3, y: 76.8, combat: ['marsh_wraith'], loot: { item: 'silver_ore', amount: 2 } },
  { id: 'loamshade_moor', name: 'Loamshade Moor', x: 2.1, y: 96.1, combat: ['orc_raider', 'marsh_wraith'], loot: { item: 'mithril_ore', amount: 3 } },
  { id: 'quietgate_keep', name: 'Quietgate Keep', x: 96.2, y: 42.8, combat: ['wolf', 'marsh_wraith'], loot: { item: 'gold', amount: 19 } },
  { id: 'kestrelwick_reach', name: 'Kestrelwick Reach', x: 44.9, y: 32.5, combat: ['forest_spider'], loot: { item: 'sunpetal', amount: 1 } },
  { id: 'bramblewoodhall_cairn', name: 'Bramblewoodhall Cairn', x: 91.1, y: 44.2, combat: ['wolf', 'marsh_wraith'] },
  { id: 'copperglade_crest', name: 'Copperglade Crest', x: 80.7, y: 76.5, combat: ['orc_raider'] },
  { id: 'wyrmvale_glen', name: 'Wyrmvale Glen', x: 68.6, y: 9.4, combat: ['wolf', 'marsh_wraith'], loot: { item: 'silver_ore', amount: 2 } },
  { id: 'quietspire_watch', name: 'Quietspire Watch', x: 25.7, y: 88.4, combat: ['stone_troll'] },
  { id: 'marrowden_hall', name: 'Marrowden Hall', x: 32.9, y: 43.6, combat: ['wolf', 'forest_spider'], loot: { item: 'gold', amount: 14 } },
  { id: 'granitecliff_spire', name: 'Granitecliff Spire', x: 10.3, y: 90.2, combat: ['stone_troll'], loot: { item: 'troll_hide', amount: 2 } },
  { id: 'yewridge_overlook', name: 'Yewridge Overlook', x: 64.3, y: 18.5, combat: ['wolf', 'orc_raider'], loot: { item: 'coal', amount: 4 } },
  { id: 'birchgap_den', name: 'Birchgap Den', x: 50.8, y: 5, combat: ['orc_raider'] },
  { id: 'ironcladvale_sanctum', name: 'Ironcladvale Sanctum', x: 71.7, y: 82, combat: ['marsh_wraith'] },
  { id: 'ashcliff_ford', name: 'Ashcliff Ford', x: 91.4, y: 87.2, combat: ['stone_troll', 'orc_raider'], loot: { item: 'mithril_ore', amount: 3 } },
  { id: 'blackbridge_keep', name: 'Blackbridge Keep', x: 72.2, y: 36.4, combat: ['bog_zombie'] },
  { id: 'ashengrove_hollow', name: 'Ashengrove Hollow', x: 28.2, y: 40.8, combat: ['wolf'], loot: { item: 'iron_ore', amount: 3 } },
  { id: 'coldstoneshade_cairn', name: 'Coldstoneshade Cairn', x: 12.4, y: 81.1, combat: ['stone_troll'] },
  { id: 'larchpoint_hall', name: 'Larchpoint Hall', x: 57.8, y: 70.1, combat: ['bog_zombie'], loot: { item: 'sunpetal', amount: 1 } },
  { id: 'kestrelgap_haven', name: 'Kestrelgap Haven', x: 47.1, y: 52.2, combat: ['bandit'], loot: { item: 'supplies', amount: 2 } },
  { id: 'ironford_shire', name: 'Ironford Shire', x: 61.6, y: 53.7, combat: ['giant_rat'], loot: { item: 'gold', amount: 8 } },
  { id: 'wickmarsh_crossing', name: 'Wickmarsh Crossing', x: 53.3, y: 74.8, combat: ['wolf'], loot: { item: 'gold', amount: 14 } },
  { id: 'pinekeep_ruins', name: 'Pinekeep Ruins', x: 48, y: 23.3, combat: ['forest_spider'] },
  { id: 'ravenmoor_watch', name: 'Ravenmoor Watch', x: 80.9, y: 17.3, combat: ['stone_troll'] },
  { id: 'yewwatch_moor', name: 'Yewwatch Moor', x: 25.3, y: 81, combat: ['orc_raider'], loot: { item: 'gold', amount: 17 } },
  { id: 'hollowglade_refuge', name: 'Hollowglade Refuge', x: 4.2, y: 89.7, combat: ['stone_troll', 'marsh_wraith'] },
  { id: 'winterholdfall_landing', name: 'Winterholdfall Landing', x: 73.5, y: 95.3, combat: ['stone_troll'] },
  { id: 'palewindcrag_cove', name: 'Palewindcrag Cove', x: 97.3, y: 65, combat: ['orc_raider'] },
  { id: 'bramblewoodgrove_outpost', name: 'Bramblewoodgrove Outpost', x: 7.7, y: 56.3, combat: ['orc_raider', 'marsh_wraith'] },
  { id: 'quillspire_glen', name: 'Quillspire Glen', x: 88.8, y: 14.4, combat: ['stone_troll', 'orc_raider'], loot: { item: 'mithril_ore', amount: 1 } },
  { id: 'ironcladwood_den', name: 'Ironcladwood Den', x: 50.2, y: 83.4, combat: ['orc_raider'], loot: { item: 'gold', amount: 14 } },
  { id: 'ochreden_camp', name: 'Ochreden Camp', x: 14.1, y: 37.9, combat: ['marsh_wraith'], loot: { item: 'redcap_cap', amount: 3 } },
  { id: 'duskmoormere_crest', name: 'Duskmoormere Crest', x: 45.6, y: 64.1, combat: ['giant_rat'] },
  { id: 'bramblereach_den', name: 'Bramblereach Den', x: 42.9, y: 93.7, combat: ['wolf', 'marsh_wraith'], loot: { item: 'wolf_fang', amount: 2 } },
  { id: 'irongrove_village', name: 'Irongrove Village', x: 21.9, y: 87.4, combat: ['orc_raider', 'marsh_wraith'], loot: { item: 'bog_root', amount: 3 } },
  { id: 'nettlehollow_cairn', name: 'Nettlehollow Cairn', x: 82.6, y: 2.5, combat: ['stone_troll'], loot: { item: 'mithril_ore', amount: 1 } },
  { id: 'redcliffhold_brook', name: 'Redcliffhold Brook', x: 4.9, y: 21, combat: ['stone_troll', 'marsh_wraith'] },
  { id: 'ironpoint_tower', name: 'Ironpoint Tower', x: 90.4, y: 48.3, combat: ['stone_troll'], loot: { item: 'bog_root', amount: 3 } },
  { id: 'bramblecrest_haven', name: 'Bramblecrest Haven', x: 4.4, y: 46.4, combat: ['stone_troll'] },
  { id: 'jadeford_cove', name: 'Jadeford Cove', x: 14.5, y: 90.3, combat: ['stone_troll', 'orc_raider'] },
  { id: 'heathershore_crossing', name: 'Heathershore Crossing', x: 74.8, y: 2.6, combat: ['stone_troll', 'orc_raider'], loot: { item: 'gold_ore', amount: 4 } },
  { id: 'farrowwood_brook', name: 'Farrowwood Brook', x: 23.2, y: 53.1, combat: ['wolf', 'forest_spider'], loot: { item: 'sunpetal', amount: 2 } },
  { id: 'vinegap_reach', name: 'Vinegap Reach', x: 46.5, y: 76.2, combat: ['wolf'], loot: { item: 'gold', amount: 12 } },
  { id: 'blackcove_port', name: 'Blackcove Port', x: 8.9, y: 4.7, combat: ['stone_troll', 'marsh_wraith'], loot: { item: 'troll_hide', amount: 1 } },
  { id: 'ashenview_moor', name: 'Ashenview Moor', x: 43.6, y: 18.8, combat: ['wolf', 'orc_raider'], loot: { item: 'moonleaf', amount: 2 } },
  { id: 'rowanshade_port', name: 'Rowanshade Port', x: 14, y: 53.9, combat: ['orc_raider'], loot: { item: 'gold', amount: 13 } },
  { id: 'redcliffridge_waystation', name: 'Redcliffridge Waystation', x: 65.3, y: 44, combat: ['giant_rat', 'bandit'] },
  { id: 'thistlemarsh_keep', name: 'Thistlemarsh Keep', x: 94.3, y: 47.5, combat: ['orc_raider'], loot: { item: 'silver_ore', amount: 4 } },
  { id: 'duskmoorcliff_hollow', name: 'Duskmoorcliff Hollow', x: 11.9, y: 57.5, combat: ['stone_troll'], loot: { item: 'silver_ore', amount: 2 } },
  { id: 'elderford_gate', name: 'Elderford Gate', x: 76, y: 29.8, combat: ['orc_raider'], loot: { item: 'redcap_cap', amount: 1 } },
  { id: 'timberfall_waystation', name: 'Timberfall Waystation', x: 67.4, y: 89.5, combat: ['wolf', 'marsh_wraith'] },
  { id: 'ivyshore_cairn', name: 'Ivyshore Cairn', x: 38.5, y: 74.5, combat: ['forest_spider'], loot: { item: 'gold', amount: 9 } },
  { id: 'larchburrow_sanctum', name: 'Larchburrow Sanctum', x: 6.7, y: 85.9, combat: ['stone_troll', 'marsh_wraith'], loot: { item: 'gold', amount: 31 } },
  { id: 'fogpoint_waystation', name: 'Fogpoint Waystation', x: 31.7, y: 87.3, combat: ['marsh_wraith'] },
  { id: 'fogshade_moor', name: 'Fogshade Moor', x: 57.7, y: 62.8, combat: ['giant_rat'], loot: { item: 'wood', amount: 6 } },
  { id: 'driftwoodshade_hollow', name: 'Driftwoodshade Hollow', x: 44.8, y: 67.8, combat: ['wolf', 'forest_spider'] },
  { id: 'palewinddale_tower', name: 'Palewinddale Tower', x: 3.5, y: 50.9, combat: ['stone_troll'] },
  { id: 'wraithridge_keep', name: 'Wraithridge Keep', x: 4.7, y: 31, combat: ['stone_troll'] },
  { id: 'umbermere_crest', name: 'Umbermere Crest', x: 28.4, y: 65.3, combat: ['wolf', 'forest_spider'], loot: { item: 'iron_ore', amount: 3 } },
  { id: 'umberrun_hamlet', name: 'Umberrun Hamlet', x: 95.7, y: 89.8, combat: ['stone_troll', 'orc_raider'], loot: { item: 'mithril_ore', amount: 1 } },
  { id: 'copperview_village', name: 'Copperview Village', x: 97.5, y: 76.4, combat: ['stone_troll', 'marsh_wraith'], loot: { item: 'mithril_ore', amount: 1 } },
  { id: 'graypoint_village', name: 'Graypoint Village', x: 30.4, y: 28.9, combat: ['wolf', 'orc_raider'] },
  { id: 'goldvale_cairn', name: 'Goldvale Cairn', x: 3.3, y: 11.5, combat: ['orc_raider', 'marsh_wraith'], loot: { item: 'gold', amount: 31 } },
  { id: 'stormdale_tower', name: 'Stormdale Tower', x: 16.6, y: 7.5, combat: ['stone_troll'] },
  { id: 'foxstead_cove', name: 'Foxstead Cove', x: 15.4, y: 75.9, combat: ['stone_troll'], loot: { item: 'silver_ore', amount: 2 } },
  { id: 'hollowcrag_enclave', name: 'Hollowcrag Enclave', x: 32.2, y: 11.6, combat: ['wolf', 'marsh_wraith'] },
  { id: 'cindermire_spire', name: 'Cindermire Spire', x: 53.3, y: 95.6, combat: ['marsh_wraith'], loot: { item: 'silver_ore', amount: 2 } },
  { id: 'hazeldale_overlook', name: 'Hazeldale Overlook', x: 37.4, y: 7.8, combat: ['stone_troll'], loot: { item: 'silver_ore', amount: 2 } },
  { id: 'stormmire_outpost', name: 'Stormmire Outpost', x: 61.1, y: 94.5, combat: ['stone_troll'], loot: { item: 'gold', amount: 20 } },
  { id: 'loamreach_brook', name: 'Loamreach Brook', x: 43.7, y: 3.6, combat: ['stone_troll'], loot: { item: 'gold', amount: 24 } },
  { id: 'thistlewoodward_landing', name: 'Thistlewoodward Landing', x: 71.1, y: 71.8, combat: ['marsh_wraith'] },
  { id: 'ironcladfen_hollow', name: 'Ironcladfen Hollow', x: 94.5, y: 62.5, combat: ['orc_raider', 'marsh_wraith'] },
  { id: 'rowancrest_moor', name: 'Rowancrest Moor', x: 59.1, y: 76.2, combat: ['wolf'], loot: { item: 'gold', amount: 9 } },
  { id: 'whithollow_moor', name: 'Whithollow Moor', x: 73.8, y: 74.1, combat: ['marsh_wraith'], loot: { item: 'gold', amount: 18 } },
  { id: 'umberkeep_shrine', name: 'Umberkeep Shrine', x: 24.5, y: 92.2, combat: ['wolf', 'marsh_wraith'], loot: { item: 'silver_ore', amount: 4 } },
  { id: 'elmlight_den', name: 'Elmlight Den', x: 21.4, y: 82.5, combat: ['stone_troll'], loot: { item: 'bog_root', amount: 1 } },
  { id: 'stormridge_gate', name: 'Stormridge Gate', x: 8.5, y: 19.1, combat: ['orc_raider', 'marsh_wraith'] },
  { id: 'ashdale_cairn', name: 'Ashdale Cairn', x: 75.2, y: 77.2, combat: ['marsh_wraith'] },
  { id: 'fernwatch_grove', name: 'Fernwatch Grove', x: 45.8, y: 82.9, combat: ['marsh_wraith'], loot: { item: 'gold', amount: 13 } },
  { id: 'quarryspire_fen', name: 'Quarryspire Fen', x: 56.8, y: 57, combat: ['giant_rat', 'bandit'] },
  { id: 'nightgap_hollow', name: 'Nightgap Hollow', x: 5.6, y: 69.4, combat: ['wolf', 'marsh_wraith'] },
  { id: 'deepmire_haven', name: 'Deepmire Haven', x: 37.5, y: 35.9, combat: ['wolf'], loot: { item: 'iron_ore', amount: 6 } },
  { id: 'duskmoorwatch_tower', name: 'Duskmoorwatch Tower', x: 25.9, y: 25.8, combat: ['wolf', 'orc_raider'] },
  { id: 'copperburrow_spire', name: 'Copperburrow Spire', x: 43.6, y: 58.6, combat: ['bandit'], loot: { item: 'supplies', amount: 3 } },
];

// --- overworld grid ---
//
// The world the player actually walks around in is a very large grid
// (WORLD_WIDTH x WORLD_HEIGHT tiles) — almost entirely empty space, with
// LOCATIONS scattered sparsely across it. Rather than hand-picking new grid
// coordinates for ~200 hand-authored locations, each one's existing percent
// x/y (0-100, the old canvas-map layout) is scaled once at startup into an
// integer grid position (gx/gy) — this preserves their relative geography
// (things that were close together in percent-space stay close together
// now) while spreading them across a world that's or ders of magnitude
// bigger than the space they used to fill, which is exactly the "sparse,
// vast, mostly-empty" feel a grid overworld should have.
const WORLD_WIDTH = 300;
const WORLD_HEIGHT = 300;

// Distance (Chebyshev, i.e. max(|dx|,|dy|) — a square "ring" outward from
// center, matching how the 4 enemy tiers were already informally described
// in ENEMIES' comments above) from the exact center of the grid, as a
// fraction of the farthest any tile can be. Buckets that fraction into 4
// tiers so "how far from the starting area" drives difficulty, same idea
// the original hand-placed LOCATIONS' combat arrays were already loosely
// following, just computed instead of eyeballed per-location.
const WORLD_CENTER = { x: (WORLD_WIDTH - 1) / 2, y: (WORLD_HEIGHT - 1) / 2 };
const WORLD_MAX_DIST = Math.max(WORLD_CENTER.x, WORLD_CENTER.y);
function tierForGridPos(gx, gy) {
  const dist = Math.max(Math.abs(gx - WORLD_CENTER.x), Math.abs(gy - WORLD_CENTER.y));
  const frac = dist / WORLD_MAX_DIST;
  if (frac < 0.25) return 1;
  if (frac < 0.5) return 2;
  if (frac < 0.75) return 3;
  return 4;
}

// One-time layout pass: derive gx/gy + tier for every location from its
// existing percent x/y, guaranteeing every location lands on a distinct
// tile (a collision — two locations' percent coordinates rounding to the
// same grid cell — is vanishingly unlikely at 300x300 resolution with ~200
// points, but nudged apart deterministically just in case rather than
// silently letting one shadow the other).
(function assignWorldGridPositions() {
  const used = new Set();
  for (const loc of LOCATIONS) {
    let gx = Math.round((loc.x / 100) * (WORLD_WIDTH - 1));
    let gy = Math.round((loc.y / 100) * (WORLD_HEIGHT - 1));
    let attempts = 0;
    while (used.has(`${gx},${gy}`) && attempts < 50) {
      gx = Math.min(WORLD_WIDTH - 1, gx + 1);
      attempts++;
    }
    used.add(`${gx},${gy}`);
    loc.gx = gx;
    loc.gy = gy;
    loc.tier = tierForGridPos(gx, gy);
  }
})();

const LOCATION_BY_GRID = new Map(LOCATIONS.map((l) => [`${l.gx},${l.gy}`, l]));
function getLocationAtGrid(gx, gy) {
  return LOCATION_BY_GRID.get(`${gx},${gy}`) || null;
}

// How far a fight's dungeon/enemy roster/bonus loot scale with the location
// tier it's fought at — this is the "dungeons, enemies, and loot are
// randomized depending on the area" system. `enemies` replaces the old
// per-location hand-picked combat arrays as the actual roll pool (LOCATIONS'
// own `combat` field is now just a boolean "a fight happens here" flag).
// `dungeonSize`/`wallChance` are ranges randomized fresh per fight (see
// generateCombatGrid()) so no two fights at the same tier look identical
// either. Reuses the 9 existing ENEMIES entries, grouped by their own
// maxHp/design intent (see the tier comments already on ENEMIES above)
// rather than inventing new creatures.
const WORLD_TIERS = {
  1: {
    enemies: ['giant_rat', 'bandit', 'wolf'],
    dungeonWidth: [7, 9],
    dungeonHeight: [5, 7],
    wallChance: [0.08, 0.12],
    bonusLoot: [{ item: 'gold', chance: 0.5, amount: [2, 5] }],
  },
  2: {
    enemies: ['forest_spider', 'forest_archer', 'bog_zombie'],
    dungeonWidth: [9, 11],
    dungeonHeight: [7, 9],
    wallChance: [0.1, 0.16],
    bonusLoot: [
      { item: 'gold', chance: 0.5, amount: [5, 10] },
      { item: 'iron_ore', chance: 0.2, amount: [1, 3] },
    ],
  },
  3: {
    enemies: ['orc_raider', 'marsh_wraith'],
    dungeonWidth: [11, 13],
    dungeonHeight: [8, 10],
    wallChance: [0.12, 0.18],
    bonusLoot: [
      { item: 'gold', chance: 0.5, amount: [10, 18] },
      { item: 'silver_ore', chance: 0.2, amount: [1, 3] },
    ],
  },
  4: {
    enemies: ['stone_troll'],
    dungeonWidth: [13, 15],
    dungeonHeight: [9, 11],
    wallChance: [0.15, 0.22],
    bonusLoot: [
      { item: 'gold', chance: 0.5, amount: [18, 30] },
      { item: 'gold_ore', chance: 0.2, amount: [1, 2] },
      { item: 'mithril_ore', chance: 0.05, amount: [1, 1] },
    ],
  },
};

// Pure flavor text + branching, no game-state mutation embedded in the tree
// itself — an NPC's associated quest (if any) is a separate object shown
// alongside the tree in the client, not a node in it. Keeps the tree a
// simple static graph instead of needing a mini scripting language for
// conditionals.
const DIALOGUE_TREES = {
  root_mira: {
    id: 'root_mira',
    text: "Welcome, traveler. The roads beyond camp aren't safe for the unprepared.",
    options: [
      { text: 'Got any advice?', next: 'mira_advice' },
      { text: 'Farewell.', next: null },
    ],
  },
  mira_advice: {
    text: 'Stock up on supplies before drawing a long route, and never pick a fight without checking your gear first.',
    options: [{ text: 'Thanks.', next: 'root_mira' }],
  },
  root_thom: {
    id: 'root_thom',
    text: "These groves don't cut themselves. Bring me good timber and I'll make it worth your while.",
    options: [
      { text: 'How do I cut wood?', next: 'thom_howto' },
      { text: 'Farewell.', next: null },
    ],
  },
  thom_howto: {
    text: "Head to the Skills tab while you're standing here and start the Woodcutting task. Simple as that.",
    options: [{ text: 'Got it.', next: 'root_thom' }],
  },
  root_fen: {
    id: 'root_fen',
    text: 'The water runs deep past this bridge. I hear there are old mine shafts west of here, if you know where to look.',
    options: [
      { text: 'Tell me more.', next: 'fen_more' },
      { text: 'Farewell.', next: null },
    ],
  },
  fen_more: {
    text: "Ironbrook Mine, they call it. Never been myself — my knees aren't what they used to be. Someone younger ought to go see.",
    options: [{ text: "I'll look into it.", next: 'root_fen' }],
  },
  root_yelena: {
    id: 'root_yelena',
    text: 'The marsh gives up its secrets slowly, and never for free. Bog root grows thick where the water is deepest.',
    options: [
      { text: 'What do you use bog root for?', next: 'yelena_bogroot' },
      { text: 'Farewell.', next: null },
    ],
  },
  yelena_bogroot: {
    text: "Cures, mostly. A witch who can't cure a poison isn't much of a witch. Bring me some, if you're willing to get your boots wet.",
    options: [{ text: "I'll see what I can find.", next: 'root_yelena' }],
  },
  root_borin: {
    id: 'root_borin',
    text: 'Copperhall was built on the vein under Wyrmwood Hold. Good, honest ore — soft enough to work, strong enough to trust.',
    options: [
      { text: 'Need any ore?', next: 'borin_ore' },
      { text: 'Farewell.', next: null },
    ],
  },
  borin_ore: {
    text: "Always. Bring me copper and I'll square you up fair — better than you'd get hawking it at the shop.",
    options: [{ text: "I'll bring some by.", next: 'root_borin' }],
  },
  root_reyna: {
    id: 'root_reyna',
    text: "Thornwatch holds the line, traveler, but bandits have been bold lately. Too bold. Someone ought to remind them why we're called that.",
    options: [
      { text: "I'll deal with them.", next: 'reyna_bandits' },
      { text: 'Farewell.', next: null },
    ],
  },
  reyna_bandits: {
    text: "Good. Don't be a hero about it — one clean fight is proof enough. Come back when it's done.",
    options: [{ text: 'Understood.', next: 'root_reyna' }],
  },
  root_aldric: {
    id: 'root_aldric',
    text: 'Vintermere Keep fell to wolves out of the north, long before your time. I stayed. Someone has to remember it fell for a reason.',
    options: [
      { text: 'What reason?', next: 'aldric_reason' },
      { text: 'Farewell.', next: null },
    ],
  },
  aldric_reason: {
    text: "Pride. We thought the walls would hold. They didn't. Thin the packs still prowling nearby and maybe I'll finally believe it's over.",
    options: [{ text: "I'll thin them out.", next: 'root_aldric' }],
  },
  root_fenwick: {
    id: 'root_fenwick',
    text: "Best hunting camp for miles, this. You'd be surprised what a patient hunter can bring down out here.",
    options: [
      { text: 'Any tips?', next: 'fenwick_tips' },
      { text: 'Farewell.', next: null },
    ],
  },
  fenwick_tips: {
    text: "Patience and a full stomach. Bring me some meat off a real hunt and I'll know you've got both.",
    options: [{ text: 'Noted.', next: 'root_fenwick' }],
  },
  root_sera: {
    id: 'root_sera',
    text: "I've walked far to reach this spire, and I mean to walk farther still — all the way to the frostbound watch at the world's edge, if my legs allow it.",
    options: [
      { text: 'Why go so far?', next: 'sera_why' },
      { text: 'Farewell.', next: null },
    ],
  },
  sera_why: {
    text: "Faith needs proof sometimes. If you reach Frostmere Watch before I do, traveler, tell me — I'd take it as a sign I'm not walking alone.",
    options: [{ text: "I'll let you know.", next: 'root_sera' }],
  },
  root_cordelia: {
    id: 'root_cordelia',
    text: "Ironvale Hall forges the finest steel this side of the mountains — when I've got the iron for it, that is.",
    options: [
      { text: 'You need iron?', next: 'cordelia_iron' },
      { text: 'Farewell.', next: null },
    ],
  },
  cordelia_iron: {
    text: "Always short on it. Ironbrook's a long haul from here. Bring me a real haul of ore and you'll see what this forge can really do.",
    options: [{ text: "I'll bring you plenty.", next: 'root_cordelia' }],
  },
  root_thistle: {
    id: 'root_thistle',
    text: 'Stonehaven has been ruins longer than anyone living remembers why. Something still moves in the deep stones, traveler. I can feel it.',
    options: [
      { text: 'What moves there?', next: 'thistle_warning' },
      { text: 'Farewell.', next: null },
    ],
  },
  thistle_warning: {
    text: "Something old, and slow, and made of the stone itself. If you're foolish enough to seek it out, at least come back and tell me it's dead.",
    options: [{ text: "I'll face it.", next: 'root_thistle' }],
  },
};

const NPCS = {
  elder_mira: { id: 'elder_mira', name: 'Elder Mira', locationId: 'wanderers_camp', dialogueTreeId: 'root_mira', questId: 'first_hunt' },
  groundskeeper_thom: { id: 'groundskeeper_thom', name: 'Groundskeeper Thom', locationId: 'gladewind_grove', dialogueTreeId: 'root_thom', questId: 'timber_delivery' },
  old_fen: { id: 'old_fen', name: 'Old Fen', locationId: 'grimwater_bridge', dialogueTreeId: 'root_fen', questId: 'scout_the_mine' },
  marsh_witch_yelena: { id: 'marsh_witch_yelena', name: 'Marsh Witch Yelena', locationId: 'duskhollow_marsh', dialogueTreeId: 'root_yelena', questId: 'bog_root_tribute' },
  blacksmith_borin: { id: 'blacksmith_borin', name: 'Blacksmith Borin', locationId: 'copperhall_village', dialogueTreeId: 'root_borin', questId: 'copper_delivery' },
  captain_reyna: { id: 'captain_reyna', name: 'Captain Reyna', locationId: 'thornwatch_hall', dialogueTreeId: 'root_reyna', questId: 'bandit_trouble' },
  sentinel_aldric: { id: 'sentinel_aldric', name: 'Sentinel Aldric', locationId: 'vintermere_keep', dialogueTreeId: 'root_aldric', questId: 'thin_the_packs' },
  hunter_fenwick: { id: 'hunter_fenwick', name: 'Hunter Fenwick', locationId: 'whisperwood_camp', dialogueTreeId: 'root_fenwick', questId: 'proof_of_the_hunt' },
  pilgrim_sera: { id: 'pilgrim_sera', name: 'Pilgrim Sera', locationId: 'sunspire_camp', dialogueTreeId: 'root_sera', questId: 'edge_of_the_world' },
  smith_cordelia: { id: 'smith_cordelia', name: 'Smith Cordelia', locationId: 'ironvale_hall', dialogueTreeId: 'root_cordelia', questId: 'ironvale_haul' },
  sage_thistle: { id: 'sage_thistle', name: 'Sage Thistle', locationId: 'stonehaven_ruins', dialogueTreeId: 'root_thistle', questId: 'the_deep_stone' },
};

// objective types: 'kill' (your all-time kill count for that enemy — so a
// quest can already be done if you've killed enough before accepting it),
// 'gather' (how many of an item you're holding, used up on turn-in), 'visit'
// (a location you've discovered).
const QUESTS = {
  first_hunt: {
    id: 'first_hunt',
    name: 'First Hunt',
    description: 'Defeat a Giant Rat to prove your mettle.',
    objective: { type: 'kill', enemyId: 'giant_rat', count: 1 },
    reward: { gold: 25, xp: { combat: 20 } },
  },
  timber_delivery: {
    id: 'timber_delivery',
    name: 'Timber Delivery',
    description: 'Bring 10 Wood to Groundskeeper Thom.',
    objective: { type: 'gather', itemId: 'wood', count: 10 },
    reward: { gold: 15, xp: { woodcutting: 25 } },
  },
  scout_the_mine: {
    id: 'scout_the_mine',
    name: 'Scout the Mine',
    description: 'Discover Ironbrook Mine.',
    objective: { type: 'visit', locationId: 'ironbrook_mine' },
    reward: { gold: 20 },
  },
  bog_root_tribute: {
    id: 'bog_root_tribute',
    name: 'Bog Root Tribute',
    description: 'Bring 3 Bog Root to Marsh Witch Yelena.',
    objective: { type: 'gather', itemId: 'bog_root', count: 3 },
    reward: { gold: 20 },
  },
  copper_delivery: {
    id: 'copper_delivery',
    name: 'Copper Delivery',
    description: 'Bring 5 Copper Ore to Blacksmith Borin.',
    objective: { type: 'gather', itemId: 'copper_ore', count: 5 },
    reward: { gold: 20 },
  },
  bandit_trouble: {
    id: 'bandit_trouble',
    name: 'Bandit Trouble',
    description: 'Defeat a Bandit for Captain Reyna.',
    objective: { type: 'kill', enemyId: 'bandit', count: 1 },
    reward: { gold: 25, xp: { combat: 15 } },
  },
  thin_the_packs: {
    id: 'thin_the_packs',
    name: 'Thin the Packs',
    description: 'Defeat 2 Wolves for Sentinel Aldric.',
    objective: { type: 'kill', enemyId: 'wolf', count: 2 },
    reward: { gold: 30, xp: { combat: 20 } },
  },
  proof_of_the_hunt: {
    id: 'proof_of_the_hunt',
    name: 'Proof of the Hunt',
    description: 'Bring 5 Raw Meat to Hunter Fenwick.',
    objective: { type: 'gather', itemId: 'raw_meat', count: 5 },
    reward: { gold: 25, xp: { hunting: 25 } },
  },
  edge_of_the_world: {
    id: 'edge_of_the_world',
    name: 'Edge of the World',
    description: 'Discover Frostmere Watch for Pilgrim Sera.',
    objective: { type: 'visit', locationId: 'frostmere_watch' },
    reward: { gold: 40 },
  },
  ironvale_haul: {
    id: 'ironvale_haul',
    name: 'Ironvale Haul',
    description: 'Bring 8 Iron Ore to Smith Cordelia.',
    objective: { type: 'gather', itemId: 'iron_ore', count: 8 },
    reward: { gold: 35 },
  },
  the_deep_stone: {
    id: 'the_deep_stone',
    name: 'The Deep Stone',
    description: 'Defeat a Stone Troll for Sage Thistle.',
    objective: { type: 'kill', enemyId: 'stone_troll', count: 1 },
    reward: { gold: 60, xp: { combat: 40 } },
  },
};

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    return { players: {}, usernames: {} };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

let db = loadDb();

// save() writes the whole save file to disk, and /api/me (which every
// player's browser calls every second or so) used to call save() every
// single time — that's a lot of slow disk writes as more players connect.
// Instead, save() just marks the file as "needs saving" and a timer
// actually writes it once per second, no matter how many times save() was
// called in that second.
const SAVE_DEBOUNCE_MS = 1000;
let saveTimer = null;
let dirty = false;

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return;
  dirty = false;
  // A packaged .exe's folder never had `data/` created by `git clone` the
  // way a normal checkout does -- make sure it exists before writing.
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function save() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

// If the server stops (Ctrl+C, restart, deploy) while a save is still
// waiting on its timer, write it now so that last second of progress isn't
// lost.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flushSave();
    process.exit(0);
  });
}

function getLocation(id) {
  return LOCATIONS.find((l) => l.id === id) || null;
}

// Short unique-enough id for a new record (player, animal, etc) — time-based
// so ids sort roughly by creation order, plus a random suffix so two
// generated in the same millisecond still can't collide.
function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// --- account security: password to log in + a token checked on every request ---
// Needed once the game was reachable over the internet instead of just on
// one computer — a player's id is visible to every other connected player
// (it's how the "nearby adventurers" list works), so without a token check
// anyone could grab that id and act as that player. New accounts get a
// password and a token; accounts made before this existed keep working
// without one (see ensurePlayerShape).
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function makePasswordRecord(password) {
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  return { passwordHash: hashPassword(password, passwordSalt), passwordSalt };
}
function verifyPassword(player, password) {
  if (!player.passwordHash) return true; // old account with no password set — still lets anyone in, same as before
  if (!password) return false;
  const candidate = Buffer.from(hashPassword(password, player.passwordSalt), 'hex');
  const actual = Buffer.from(player.passwordHash, 'hex');
  return candidate.length === actual.length && crypto.timingSafeEqual(candidate, actual);
}
// player.token === null means an old account made before tokens existed —
// it stays open, same as it always was.
function verifyToken(player, suppliedToken) {
  return player.token === null || player.token === suppliedToken;
}

// traits is always given by createCharacter() (which validates it) — the
// even spread here only kicks in as a fallback so this function never
// crashes if it's ever called without traits.
function newPlayer(username, traits, passwordRecord) {
  const startLoc = LOCATIONS.find((l) => l.startingLocation);
  const id = genId('p_');
  const player = {
    id,
    username,
    passwordHash: passwordRecord ? passwordRecord.passwordHash : null,
    passwordSalt: passwordRecord ? passwordRecord.passwordSalt : null,
    token: crypto.randomBytes(24).toString('hex'),
    createdAt: Date.now(),
    currentLocation: startLoc.id,
    worldPos: { x: startLoc.gx, y: startLoc.gy },
    revealedTiles: [],
    discoveries: [startLoc.id],
    inventory: { supplies: STARTER_SUPPLIES, gold: 20 },
    equipment: { weapon: null, armor: null },
    combat: null,
    garden: { plots: new Array(GARDEN_PLOT_COUNT).fill(null) },
    skills: {
      mining: { xp: 0, progressSeconds: 0, taskStartedAt: null, lastTick: null, activeNode: null },
      woodcutting: { xp: 0, progressSeconds: 0, taskStartedAt: null, lastTick: null, activeNode: null },
      fishing: { xp: 0, progressSeconds: 0, taskStartedAt: null, lastTick: null, activeNode: null },
      hunting: { xp: 0, progressSeconds: 0, taskStartedAt: null, lastTick: null, activeNode: null },
      scavenging: { xp: 0, progressSeconds: 0, taskStartedAt: null, lastTick: null, activeNode: null },
      harvesting: { xp: 0, progressSeconds: 0, taskStartedAt: null, lastTick: null, activeNode: null },
      combat: { xp: 0 },
    },
    farm: { animals: [] },
    buildings: {},
    quests: { started: [], completed: [] },
    killCounts: {},
    combatRecord: { wins: 0, losses: 0 },
    lastRareEvent: null,
    alchemy: { knownRecipes: [], triedCombos: [] },
    traits: traits || { strength: TRAIT_BASE, dexterity: TRAIT_BASE, luck: TRAIT_BASE, vigor: TRAIT_BASE },
    characterXp: 0,
    traitPointsAvailable: 0,
    perkPoints: 0,
    perks: [],
  };
  player.revealedTiles.push(`${startLoc.gx},${startLoc.gy}`); // the one tile the player starts standing on
  db.players[id] = player;
  db.usernames[username.toLowerCase()] = id;
  save();
  return player;
}

// A username nobody's used yet doesn't create a player right away — it
// tells the client to show the character creation screen instead. A known
// username logs in like normal.
function login(username, password) {
  const clean = String(username || '').trim().slice(0, 24);
  if (!clean) return null;
  const existingId = db.usernames[clean.toLowerCase()];
  if (existingId && db.players[existingId]) {
    const player = getPlayer(existingId);
    if (!verifyPassword(player, password)) return { existing: true, error: 'wrong_password' };
    return { existing: true, player, token: player.token };
  }
  return { existing: false, username: clean };
}

// Checks the trait point spending server-side too, even though the UI
// already enforces it — never trust the client's math alone.
const MIN_PASSWORD_LENGTH = 4;

function createCharacter(username, rawTraits, password) {
  const clean = String(username || '').trim().slice(0, 24);
  if (!clean) return { error: 'invalid_username' };
  if (db.usernames[clean.toLowerCase()]) return { error: 'username_taken' };
  if (String(password || '').length < MIN_PASSWORD_LENGTH) return { error: 'password_too_short' };

  const traits = {};
  for (const key of TRAIT_KEYS) {
    const v = Math.round(Number(rawTraits && rawTraits[key]));
    if (!Number.isFinite(v) || v < TRAIT_MIN || v > TRAIT_MAX) return { error: 'invalid_traits' };
    traits[key] = v;
  }
  const totalExtra = TRAIT_KEYS.reduce((sum, k) => sum + (traits[k] - TRAIT_BASE), 0);
  if (totalExtra !== TRAIT_EXTRA_POINTS) return { error: 'invalid_point_total' };

  const player = newPlayer(clean, traits, makePasswordRecord(password));
  return { ok: true, player: publicPlayer(player), token: player.token };
}

// Players made before a feature existed (equipment, garden, combat skill,
// gold, etc) are missing those fields in the save file. This fills in
// anything missing when a player is loaded, so the rest of the code can
// always assume every field is there.
function ensurePlayerShape(player) {
  let changed = false;
  if (player.inventory.gold === undefined) {
    player.inventory.gold = 0;
    changed = true;
  }
  if (!player.equipment) {
    player.equipment = { weapon: null, armor: null };
    changed = true;
  }
  if (player.combat === undefined) {
    player.combat = null;
    changed = true;
  }
  // Same class of migration, same tradeoff, repeated a few times now as
  // combat's shape has evolved (see login-500 and dangling-location-id
  // incidents for the original version of this bug): any account with an
  // UNRESOLVED fight open at the moment a shape change ships is stuck
  // holding an old-shape combat object, which the current engine can't
  // read. Reset it (loses that one stale fight) rather than trying to
  // migrate mid-fight state into a structurally different engine.
  if (player.combat && !Array.isArray(player.combat.enemies)) {
    player.combat = null;
    changed = true;
  }
  // The turn-based rewrite dropped the preset ability-loadout/auto-cursor
  // system — any unresolved fight still carrying the old `loadout` field is
  // from before that change and needs the same reset.
  if (player.combat && Array.isArray(player.combat.loadout)) {
    player.combat = null;
    changed = true;
  }
  // The FF-style rewrite dropped the arena distance/angle positioning system
  // entirely — any unresolved fight whose enemies still carry a `distance`
  // field predates that change and needs the same reset.
  if (player.combat && player.combat.enemies && player.combat.enemies.some((e) => 'distance' in e)) {
    player.combat = null;
    changed = true;
  }
  if (!player.garden) {
    player.garden = { plots: new Array(GARDEN_PLOT_COUNT).fill(null) };
    changed = true;
  } else if (player.garden.plots.length < GARDEN_PLOT_COUNT) {
    // plot count was increased (4 -> 24) after some accounts already existed
    while (player.garden.plots.length < GARDEN_PLOT_COUNT) player.garden.plots.push(null);
    changed = true;
  }
  for (const skillId of ['woodcutting', 'fishing', 'hunting', 'scavenging', 'harvesting']) {
    if (!player.skills[skillId]) {
      player.skills[skillId] = { xp: 0, progressSeconds: 0, taskStartedAt: null, lastTick: null, activeNode: null };
      changed = true;
    }
  }
  if (!player.skills.combat) {
    player.skills.combat = { xp: 0 };
    changed = true;
  }
  if (!player.farm) {
    player.farm = { animals: [] };
    changed = true;
  }
  if (!player.buildings) {
    player.buildings = {};
    changed = true;
  }
  if (!player.quests) {
    player.quests = { started: [], completed: [] };
    changed = true;
  }
  if (!player.killCounts) {
    player.killCounts = {};
    changed = true;
  }
  if (!player.combatRecord) {
    player.combatRecord = { wins: 0, losses: 0 };
    changed = true;
  }
  if (player.lastRareEvent === undefined) {
    player.lastRareEvent = null;
    changed = true;
  }
  if (!player.alchemy) {
    player.alchemy = { knownRecipes: [], triedCombos: [] };
    changed = true;
  }
  if (!player.traits) {
    // pre-traits accounts get an even spread rather than retroactively
    // running them through character creation
    player.traits = { strength: TRAIT_BASE, dexterity: TRAIT_BASE, luck: TRAIT_BASE, vigor: TRAIT_BASE };
    changed = true;
  }
  if (player.characterXp === undefined) {
    player.characterXp = 0;
    changed = true;
  }
  if (player.traitPointsAvailable === undefined) {
    player.traitPointsAvailable = 0;
    changed = true;
  }
  if (player.perkPoints === undefined) {
    player.perkPoints = 0;
    changed = true;
  }
  if (!player.perks) {
    player.perks = [];
    changed = true;
  }
  // Every gathering skill uses the node system now (only mining used to) —
  // older accounts might be missing activeNode on some skills.
  for (const skillId of Object.keys(RESOURCE_NODES)) {
    if (player.skills[skillId] && player.skills[skillId].activeNode === undefined) {
      player.skills[skillId].activeNode = null;
      changed = true;
    }
  }
  if (player.passwordHash === undefined) {
    player.passwordHash = null;
    player.passwordSalt = null;
    changed = true;
  }
  if (player.token === undefined) {
    player.token = null; // legacy account — auth stays open, see verifyToken()
    changed = true;
  }

  // The map's locations were completely redone at one point, so an old save
  // might point at locations that don't exist anymore. Drop those and fall
  // back to the starting location so nothing breaks.
  const validLocationIds = new Set(LOCATIONS.map((l) => l.id));
  const filteredDiscoveries = player.discoveries.filter((id) => validLocationIds.has(id));
  if (filteredDiscoveries.length !== player.discoveries.length) {
    changed = true;
  }
  if (filteredDiscoveries.length === 0) {
    filteredDiscoveries.push(LOCATIONS.find((l) => l.startingLocation).id);
  }
  player.discoveries = filteredDiscoveries;
  // currentLocation is legitimately null now (standing on an empty grid
  // tile, not on any named location) — only a truthy-but-dangling id needs
  // resetting, null itself is a normal, valid state.
  if (player.currentLocation && !validLocationIds.has(player.currentLocation)) {
    player.currentLocation = LOCATIONS.find((l) => l.startingLocation).id;
    changed = true;
  }

  // The percent-space drag-to-explore overworld was replaced by a grid
  // players actually walk around on (see moveOnWorldGrid()) — any account
  // from before that has no worldPos at all, or (same dangling-id problem
  // as currentLocation above) a currentLocation that no longer resolves to
  // a real tile. Falls back to wherever currentLocation now points (already
  // guaranteed valid by the check just above), or the starting location.
  if (!player.worldPos || !Number.isFinite(player.worldPos.x) || !Number.isFinite(player.worldPos.y)) {
    const loc = getLocation(player.currentLocation) || LOCATIONS.find((l) => l.startingLocation);
    player.worldPos = { x: loc.gx, y: loc.gy };
    changed = true;
  }
  // Persistent per-tile fog of war didn't exist when the grid overworld
  // first shipped — any account from that window has a worldPos but no
  // revealedTiles at all, which would otherwise render as standing in a
  // total fog void despite already having walked around. Backfill with
  // just the one tile they currently occupy, same as a brand new player.
  if (!Array.isArray(player.revealedTiles)) {
    player.revealedTiles = [`${player.worldPos.x},${player.worldPos.y}`];
    changed = true;
  }
  // The drag-to-explore system's in-progress-route state has no equivalent
  // in the grid system at all — stale leftover data, not a value anything
  // reads anymore, so just drop it instead of migrating it into anything.
  if (player.expedition !== undefined) {
    delete player.expedition;
    changed = true;
  }

  if (changed) save();
  return player;
}

function getPlayer(id) {
  const player = db.players[id];
  if (!player) return null;
  return ensurePlayerShape(player);
}

// Advances xp/items for any running task based on elapsed real time (works
// the same whether the player has been polling continuously or was away —
// both cases are just "elapsed seconds since lastTick"), then persists.
// Also enforces that a task only keeps running while the player is still at
// its required location — starting a task only checked location once, at
// the moment of clicking Start, so traveling away afterward let it keep
// accruing forever with nothing to stop it.
// Maps a deterministic-node skillId (RESOURCE_NODES/DETERMINISTIC_TASKS) to
// the matching getPlayerModifiers() speed-mult field (prospector/woodsman/
// angler's patience perks).
const SPEED_MULT_FIELD = { mining: 'miningSpeedMult', woodcutting: 'woodcuttingSpeedMult', fishing: 'fishingSpeedMult' };
const MIN_CYCLE_SECONDS = 0.5; // floor so a stacked speed bonus can never hit 0/negative cycle time

// --- Fishing minigame ---
// Idle fishing (the plain cycle clock every deterministic node task already
// has, via tickDeterministicNode below) is unaffected and always keeps
// producing its node's item on its own — this only ever ADDS a bonus on top
// for a player who's actually watching. Every bit of the timing/animation
// happens client-side (same fixed-anchor extrapolation idiom the mining
// clock/ability-fill/expedition sweep already use), so per-frame rendering
// costs the server nothing; the only network cost is one POST when the
// player actually clicks Catch, exactly like any other player-triggered
// action (craft/equip/buy).
const FISHING_BITE_WINDOW_MS = 600;
const FISHING_CATCH_GRACE_MS = 200; // slack for the catch request's own network trip after the client saw the window
const FISHING_BONUS_AMOUNT = 1;
const FISHING_BONUS_XP = 4;

// A random-number generator that always gives the same result for the same
// input string, unlike Math.random(). We need the bite window to come out
// the same whether we're just checking it or actually validating a catch, so
// both calls need to agree without saving anything extra.
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

// Works out when the current fishing cycle's "bite" window is: {biteAt,
// windowMs, cycleIndex}, or null if not fishing. This only reads existing
// state and the current time — it doesn't save anything — so a status check
// and a later catch attempt always agree on the same window.
function getFishingBite(player) {
  const skill = player.skills.fishing;
  if (!skill || !skill.taskStartedAt || !skill.activeNode) return null;
  const node = FISHING_NODES[skill.activeNode];
  if (!node) return null;
  const speedMult = getPlayerModifiers(player).fishingSpeedMult;
  const effectiveCycleSeconds = Math.max(MIN_CYCLE_SECONDS, node.cycleSeconds * (1 - speedMult));
  const elapsedSeconds = (Date.now() - skill.taskStartedAt) / 1000;
  const cycleIndex = Math.floor(elapsedSeconds / effectiveCycleSeconds);
  const cycleStartMs = skill.taskStartedAt + cycleIndex * effectiveCycleSeconds * 1000;
  const cycleMs = effectiveCycleSeconds * 1000;
  // Never let the bite window be bigger than a third of the cycle, in case
  // speed bonuses ever shrink the cycle enough that the normal window
  // wouldn't fit.
  const windowMs = Math.min(FISHING_BITE_WINDOW_MS, cycleMs / 3);
  // Keep the window away from the very start/end of the cycle.
  const usableMs = Math.max(0, cycleMs - windowMs * 2);
  const rand = hashSeed(`${player.id}:${skill.taskStartedAt}:${cycleIndex}`);
  const offsetMs = windowMs + rand() * usableMs;
  return { biteAt: Math.round(cycleStartMs + offsetMs), windowMs, cycleIndex };
}

// Click Catch during the bite window for a bonus catch and xp on top of what
// you'd get passively. Only one attempt counts per cycle, so mashing the
// button can't be used to cheat the timing.
function attemptFishingCatch(playerId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const skill = player.skills.fishing;
  if (!skill || !skill.taskStartedAt || !skill.activeNode) return { error: 'not_fishing' };
  const node = FISHING_NODES[skill.activeNode];
  if (!node) return { error: 'not_fishing' };

  const bite = getFishingBite(player);
  if (!bite) return { error: 'not_fishing' };
  if (skill.lastCatchCycle === bite.cycleIndex) {
    return { success: false, reason: 'already_attempted' };
  }
  skill.lastCatchCycle = bite.cycleIndex;

  const now = Date.now();
  const withinWindow = now >= bite.biteAt && now <= bite.biteAt + bite.windowMs + FISHING_CATCH_GRACE_MS;
  if (!withinWindow) {
    save();
    return { success: false, reason: 'missed' };
  }

  addItem(player, node.item, FISHING_BONUS_AMOUNT);
  skill.xp += FISHING_BONUS_XP;
  save();
  return { success: true, item: node.item, itemName: ITEMS[node.item].name, amount: FISHING_BONUS_AMOUNT, xp: FISHING_BONUS_XP };
}

// --- unified resource-node engine ---
// Drives all 6 gather-type skills (mining/woodcutting/fishing/hunting/
// scavenging/harvesting) off RESOURCE_NODES. Every node is workable from
// anywhere once its location is discovered (skill.activeNode, not
// player.currentLocation, is the source of truth) — the camp node for each
// skill is always unlocked since the starting location is always
// discovered. DETERMINISTIC_TASKS picks which of the two tick/resolve
// strategies below applies; a skill's nodes are always one kind or the
// other, never mixed.

function tickResourceTask(player, skillId) {
  const skill = player.skills[skillId];
  if (!skill || !skill.taskStartedAt || !skill.activeNode) return;
  const node = RESOURCE_NODES[skillId][skill.activeNode];
  if (!node || !player.discoveries.includes(node.locationId)) {
    skill.taskStartedAt = null;
    skill.lastTick = null;
    return;
  }
  if (DETERMINISTIC_TASKS.has(skillId)) {
    tickDeterministicNode(player, skillId, skill, node);
  } else {
    tickChanceNode(player, skillId, skill, node);
  }
}

// mining/woodcutting/fishing: one guaranteed item every cycleSeconds.
function tickDeterministicNode(player, skillId, skill, node) {
  const now = Date.now();
  const from = skill.lastTick || skill.taskStartedAt;
  const elapsedSeconds = (now - from) / 1000;
  if (elapsedSeconds <= 0) return;

  const speedField = SPEED_MULT_FIELD[skillId];
  const speedMult = speedField ? getPlayerModifiers(player)[speedField] : 0;
  const effectiveCycleSeconds = Math.max(MIN_CYCLE_SECONDS, node.cycleSeconds * (1 - speedMult));
  const totalSeconds = (skill.progressSeconds || 0) + elapsedSeconds;
  const itemsCompleted = Math.floor(totalSeconds / effectiveCycleSeconds);
  skill.progressSeconds = totalSeconds % effectiveCycleSeconds;
  if (itemsCompleted > 0) {
    addItem(player, node.item, itemsCompleted);
    skill.xp += itemsCompleted * node.xpPerItem;
  }
  skill.lastTick = now;
}

// Resolves elapsed time on a chance-based node (hunting/scavenging/
// harvesting) into whole completed cycles, then rolls each one
// independently instead of granting a guaranteed yield — see
// RARE_GATHER_EVENT_CHANCE for the shared jackpot odds. A hunting cycle can
// trigger an ambush (see resolveGatherCycleForNode/beginAmbushCombat),
// which immediately stops the task — combat is a hard block on every other
// task in this codebase, same as it is for mining/expeditions. Cycles are
// capped per tick (same idea as combat's turn-count guard) so a very long AFK
// gap can't turn into an unbounded loop; any still-unprocessed whole cycles
// just carry over as extra progressSeconds and get resolved on the next tick.
const GATHER_TICK_CAP = 500;

function tickChanceNode(player, skillId, skill, node) {
  if (player.combat && !player.combat.result) {
    // Already in a fight (maybe from an ambush this same tick) — stop gathering.
    skill.taskStartedAt = null;
    skill.lastTick = null;
    return;
  }

  const now = Date.now();
  const from = skill.lastTick || skill.taskStartedAt;
  const elapsedSeconds = Math.max(0, (now - from) / 1000);
  const totalSeconds = (skill.progressSeconds || 0) + elapsedSeconds;
  const cyclesCompleted = Math.floor(totalSeconds / node.cycleSeconds);
  if (cyclesCompleted <= 0) {
    // Save the partial progress even though no cycle finished yet, so it
    // isn't lost and counts toward the next one.
    skill.progressSeconds = totalSeconds;
    skill.lastTick = now;
    return;
  }

  let processed = 0;
  let interrupted = false;
  for (; processed < cyclesCompleted && processed < GATHER_TICK_CAP; processed++) {
    const outcome = resolveGatherCycleForNode(player, skillId, node);
    if (outcome === 'combat') {
      processed += 1;
      interrupted = true;
      break;
    }
  }

  if (interrupted) {
    skill.taskStartedAt = null;
    skill.lastTick = null;
    skill.progressSeconds = 0;
  } else {
    skill.progressSeconds = totalSeconds - processed * node.cycleSeconds;
    skill.lastTick = now;
  }
}

function resolveGatherCycleForNode(player, skillId, node) {
  // Every completed cycle gives a small flat xp, even on a "nothing found"
  // roll, so it never feels like a wasted cycle. The chance-based
  // item/loot roll is separate and unaffected.
  player.skills[skillId].xp += node.attemptXp;

  if (Math.random() < RARE_GATHER_EVENT_CHANCE) {
    resolveRareGatherEvent(player);
    return 'rare';
  }

  // Luck trait and the Treasure Hunter perk boost the success roll, but
  // never the ambush roll — an ambush isn't a "success" to boost away.
  const successBonus = getPlayerModifiers(player).gatherSuccessBonus;

  if (skillId === 'hunting') {
    const roll = Math.random();
    if (roll < node.encounterChance) {
      const enemyId = node.huntableEnemies[Math.floor(Math.random() * node.huntableEnemies.length)];
      beginAmbushCombat(player, enemyId, node.tier);
      return 'combat';
    }
    if (roll < node.encounterChance + node.successChance + successBonus) {
      addItem(player, node.resultItem, 1);
      player.skills.hunting.xp += node.xpPerSuccess;
      return 'success';
    }
    return 'nothing';
  }

  // scavenging / harvesting — flat successChance, one random item from the pool
  if (Math.random() < node.successChance + successBonus) {
    const itemId = node.resultPool[Math.floor(Math.random() * node.resultPool.length)];
    addItem(player, itemId, 1);
    player.skills[skillId].xp += node.xpPerSuccess;
    return 'success';
  }
  return 'nothing';
}

// Starts working a node the player has unlocked (its location has been
// discovered) — no need to travel there first once it's unlocked.
function startResourceTask(playerId, skillId, nodeId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const registry = RESOURCE_NODES[skillId];
  if (!registry) return { error: 'unknown_skill' };
  const node = registry[nodeId];
  if (!node) return { error: 'unknown_node' };
  if (!player.discoveries.includes(node.locationId)) return { error: 'not_unlocked' };
  if (player.combat && !player.combat.result) return { error: 'busy_fighting' };

  stopAllSkillTasks(player); // only one task at a time
  player.skills[skillId].activeNode = nodeId;
  player.skills[skillId].taskStartedAt = Date.now();
  player.skills[skillId].lastTick = Date.now();
  save();
  return { ok: true };
}

// Every node for a skill, locked or not — so players can see what's still
// out there to discover.
function publicResourceNodes(player, skillId) {
  const skill = player.skills[skillId];
  const registry = RESOURCE_NODES[skillId];
  const deterministic = DETERMINISTIC_TASKS.has(skillId);
  return Object.entries(registry).map(([id, node]) => {
    const unlocked = player.discoveries.includes(node.locationId);
    const loc = getLocation(node.locationId);
    const base = {
      id,
      name: node.name,
      tier: node.tier,
      cycleSeconds: node.cycleSeconds,
      unlocked,
      locationName: loc ? loc.name : node.locationId,
      active: unlocked && skill.activeNode === id && !!skill.taskStartedAt,
      progressSeconds: skill.activeNode === id ? skill.progressSeconds || 0 : 0,
    };
    if (deterministic) {
      return { ...base, item: node.item, itemName: ITEMS[node.item].name, xpPerItem: node.xpPerItem };
    }
    const resultItemIds = node.resultItem ? [node.resultItem] : node.resultPool;
    return {
      ...base,
      resultItemNames: resultItemIds.map((itemId) => ITEMS[itemId].name),
      attemptXp: node.attemptXp,
      xpPerSuccess: node.xpPerSuccess,
    };
  });
}

// Flood-fill from the player's start tile, respecting walls — used to
// guarantee every enemy spawn point generateCombatGrid() picks is actually
// reachable (a wall layout could otherwise seal an enemy behind a pocket
// nobody can ever fight their way into, or wall the player into a box with
// no way to approach anyone — either would softlock the fight).
function combatBfsReachable(start, width, height, wallSet) {
  const visited = new Set([`${start.x},${start.y}`]);
  const queue = [start];
  while (queue.length > 0) {
    const { x, y } = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const key = `${nx},${ny}`;
      if (visited.has(key) || wallSet.has(key)) continue;
      visited.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return visited;
}

// Builds a small dungeon room: the player starts at dead center, a scatter
// of wall tiles gives it a "room" feel, and enemyCount enemies are placed on
// reachable tiles at least COMBAT_MIN_ENEMY_DISTANCE away (an ambush instead
// places its one attacker right next to the player, since the whole point is
// being caught off guard). Regenerates (capped at 30 tries) if a random wall
// layout doesn't leave enough valid, reachable enemy tiles — cheap enough
// given how small and sparse the grid is, and far simpler than repairing a
// bad layout after the fact.
// Distance check for where an enemy is allowed to spawn: a normal encounter
// just needs to be far enough away to feel like a real approach (Chebyshev
// distance, so diagonal-ish spacing still counts as "far"); an ambush needs
// to land the single attacker exactly one Manhattan step away — the same
// 4-directional adjacency resolveEnemyTurns() checks — so its guaranteed
// free first hit (see beginCombatInstance()) actually lands as an attack
// instead of silently becoming "the enemy takes one step closer" if it
// happened to spawn a tile or two out.
function combatSpawnDistanceOk(p, playerPos, ambush) {
  if (ambush) return Math.abs(p.x - playerPos.x) + Math.abs(p.y - playerPos.y) === 1;
  return Math.max(Math.abs(p.x - playerPos.x), Math.abs(p.y - playerPos.y)) >= COMBAT_MIN_ENEMY_DISTANCE;
}

function randFloat(min, max) {
  return min + Math.random() * (max - min);
}

// Dungeon dimensions and wall density are randomized fresh per fight within
// the fight's tier range (see WORLD_TIERS) — a tier isn't one fixed
// dungeon, it's a range of possible ones, so no two fights at the same
// tier necessarily look alike, and higher tiers trend bigger/mazier.
function generateCombatGrid(enemyCount, ambush, tier) {
  const config = WORLD_TIERS[tier] || WORLD_TIERS[1];
  const width = randInt(config.dungeonWidth[0], config.dungeonWidth[1]);
  const height = randInt(config.dungeonHeight[0], config.dungeonHeight[1]);
  const wallChance = randFloat(config.wallChance[0], config.wallChance[1]);
  const playerPos = { x: Math.floor(width / 2), y: Math.floor(height / 2) };

  for (let attempt = 0; attempt < 30; attempt++) {
    const walls = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x === playerPos.x && y === playerPos.y) continue;
        if (Math.random() < wallChance) walls.push({ x, y });
      }
    }
    const wallSet = new Set(walls.map((w) => `${w.x},${w.y}`));
    const reachable = combatBfsReachable(playerPos, width, height, wallSet);
    const candidates = [...reachable]
      .map((key) => {
        const [x, y] = key.split(',').map(Number);
        return { x, y };
      })
      .filter((p) => combatSpawnDistanceOk(p, playerPos, ambush));

    if (candidates.length < enemyCount) continue;

    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return { width, height, walls, playerPos, enemyPositions: candidates.slice(0, enemyCount) };
  }

  // Fallback (astronomically unlikely given these wall-chance ranges): an
  // empty room guarantees enough reachable space no matter what.
  const openCandidates = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (combatSpawnDistanceOk({ x, y }, playerPos, ambush)) openCandidates.push({ x, y });
    }
  }
  return { width, height, walls: [], playerPos, enemyPositions: openCandidates.slice(0, enemyCount) };
}

// Shared combat-instance constructor used by both startCombat() (the player
// chose to fight) and beginAmbushCombat() (a hunting gather task triggered
// it with nobody clicking anything) — same shape either way, just an
// `ambush` flag the client uses to show a distinct toast and this function
// uses to let the ambushing enemy get the first hit in, before the player
// can react. enemyIds: an array (1-3) — see rollEncounterGroup().
function beginCombatInstance(player, enemyIds, ambush, tier) {
  const now = Date.now();
  const maxHp = playerMaxHp(player);
  const grid = generateCombatGrid(enemyIds.length, ambush, tier);
  const enemies = enemyIds.map((enemyId, i) => {
    const enemy = ENEMIES[enemyId];
    const pos = grid.enemyPositions[i];
    return {
      uid: `e${i}`,
      enemyId,
      hp: enemy.maxHp,
      maxHp: enemy.maxHp,
      dot: null,
      x: pos.x,
      y: pos.y,
    };
  });
  player.combat = {
    grid: { width: grid.width, height: grid.height, walls: grid.walls },
    playerPos: grid.playerPos,
    enemies,
    playerHp: maxHp,
    playerMaxHp: maxHp,
    dotOnPlayer: null,
    buff: null,
    lastPlayerActionText: '',
    lastPlayerHit: null,
    lastEnemyActionTexts: [],
    lastEnemyHits: [],
    turn: 0,
    startedAt: now,
    result: null,
    rewardGold: 0,
    rewardLoot: [],
    ambush,
    tier, // drives checkCombatEnd()'s bonus-loot roll — see WORLD_TIERS
  };
  if (ambush) {
    const equip = getEquippedStats(player);
    resolveEnemyTurns(player, player.combat, equip);
    tickDots(player.combat);
    checkCombatEnd(player, player.combat);
  }
}

// Single-enemy convenience wrapper — a hunting ambush is always one
// surprise attacker, not a coordinated group, so it doesn't go through
// rollEncounterGroup(). tier comes from whichever HUNTING_NODES entry
// triggered it (see resolveGatherCycleForNode) — falls back to 1 if
// somehow called without one.
function beginAmbushCombat(player, enemyId, tier) {
  beginCombatInstance(player, [enemyId], true, tier || 1);
}

// Most fights are solo; occasionally (see weights below) 1-2 companions join
// from the fight's tier-appropriate enemy pool (WORLD_TIERS[loc.tier]) —
// randomized by area rather than a fixed per-location list, so the same
// location can produce a different mix of tier-mates fight to fight.
// chosenEnemyId is always included so the player's explicit pick from the
// enemy list is honored.
function rollEncounterGroup(loc, chosenEnemyId) {
  const pool = WORLD_TIERS[loc.tier].enemies;
  const roll = Math.random();
  let size = 1;
  if (pool.length > 1) {
    if (roll < 0.15) size = 3;
    else if (roll < 0.45) size = 2;
  }
  size = Math.min(size, MAX_ENCOUNTER_GROUP_SIZE);
  const group = [chosenEnemyId];
  while (group.length < size) {
    group.push(pool[randInt(0, pool.length - 1)]);
  }
  return group;
}

// The 0.01% jackpot on a gather task: either rare armor, or a nudge toward
// a quest from any NPC in the game (not just nearby ones — "meeting
// someone" is a random encounter). Falls back to armor if there's no quest
// left to offer.
function resolveRareGatherEvent(player) {
  const questNpc = Object.values(NPCS).find(
    (n) => n.questId && !player.quests.started.includes(n.questId) && !player.quests.completed.includes(n.questId)
  );
  if (questNpc && Math.random() < 0.5) {
    player.quests.started.push(questNpc.questId);
    const quest = QUESTS[questNpc.questId];
    player.lastRareEvent = { type: 'quest', questId: quest.id, questName: quest.name, npcName: questNpc.name, at: Date.now() };
  } else {
    player.inventory.wanderers_plate = (player.inventory.wanderers_plate || 0) + 1;
    player.lastRareEvent = { type: 'armor', itemId: 'wanderers_plate', itemName: ITEMS.wanderers_plate.name, at: Date.now() };
  }
}

// Only one task can run at a time — starting a new one (a different skill,
// an expedition, or a fight) stops whatever was already running, after
// saving its progress so far.
function stopAllSkillTasks(player) {
  for (const skillId of Object.keys(RESOURCE_NODES)) {
    tickResourceTask(player, skillId);
  }
  for (const skill of Object.values(player.skills)) {
    if (skill.taskStartedAt) {
      skill.taskStartedAt = null;
      skill.lastTick = null;
    }
  }
}

// Grants a newly-discovered location + character xp for it in one place, so
// every path that can add to player.discoveries (walking within view radius
// of a location, paid shop reveal) awards xp consistently rather than
// duplicating the already-discovered check + level-up math. Returns true if
// this was a real new discovery (false if already known — moveOnWorldGrid's
// per-move reveal scan relies on this to avoid re-granting xp for a
// location the player already knows).
function discoverLocation(player, locationId) {
  if (player.discoveries.includes(locationId)) return false;
  player.discoveries.push(locationId);
  gainCharacterXp(player, DISCOVERY_XP);
  const loc = getLocation(locationId);
  if (loc && loc.loot) {
    addItem(player, loc.loot.item, loc.loot.amount);
  }
  return true;
}

// Character-level xp is a separate pool from every skill's xp, reusing the
// same xpCostForLevel()/levelFromXp() curve (defined further down, but
// function declarations are hoisted so the forward reference is fine). A
// single grant can cross more than one level (e.g. several locations
// revealed within view radius by one overworld move) — loop rather than
// assume at most one.
function gainCharacterXp(player, amount) {
  const before = levelFromXp(player.characterXp);
  player.characterXp += amount;
  const after = levelFromXp(player.characterXp);
  if (after > before) {
    const levelsGained = after - before;
    player.traitPointsAvailable += levelsGained;
    player.perkPoints += levelsGained;
  }
}

// The whole of overworld movement: stepping onto a tile you've never stood
// on before costs a supply and reveals it (and its location, if any) for
// good; stepping onto anywhere already in player.revealedTiles is free,
// forever — retracing known ground never costs anything, only genuinely new
// ground does. A blocked move (world edge) costs nothing and moves nobody,
// same "invalid input, not a real action" idea combat's own blocked-move
// handling already uses.
function isTileRevealed(player, x, y) {
  return player.revealedTiles.includes(`${x},${y}`);
}

function moveOnWorldGrid(playerId, direction) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (player.combat && !player.combat.result) return { error: 'busy_fighting' };
  const delta = COMBAT_DIRECTIONS[direction];
  if (!delta) return { error: 'invalid_direction' };

  const nx = player.worldPos.x + delta.dx;
  const ny = player.worldPos.y + delta.dy;
  if (nx < 0 || ny < 0 || nx >= WORLD_WIDTH || ny >= WORLD_HEIGHT) return { error: 'blocked' };

  const isNewGround = !isTileRevealed(player, nx, ny);
  if (isNewGround) {
    const supplies = player.inventory.supplies || 0;
    if (supplies <= 0) return { error: 'no_supplies' };
    player.inventory.supplies = supplies - WORLD_SUPPLIES_PER_MOVE;
    if (player.inventory.supplies <= 0) delete player.inventory.supplies;
  }

  player.worldPos = { x: nx, y: ny };
  const hereLoc = getLocationAtGrid(nx, ny);
  player.currentLocation = hereLoc ? hereLoc.id : null;

  if (isNewGround) {
    player.revealedTiles.push(`${nx},${ny}`);
    if (hereLoc) discoverLocation(player, hereLoc.id);
  }

  save();
  return { ok: true, player: publicPlayer(player) };
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Adds `amount` of an item to a player's inventory, creating the stack if needed.
function addItem(player, itemId, amount) {
  player.inventory[itemId] = (player.inventory[itemId] || 0) + amount;
}

// Removes `amount` of an item, deleting the stack once it hits zero so
// depleted items don't linger in the saved inventory.
function spendItem(player, itemId, amount) {
  player.inventory[itemId] -= amount;
  if (player.inventory[itemId] <= 0) delete player.inventory[itemId];
}

function hasIngredients(player, ingredients) {
  return Object.entries(ingredients).every(([itemId, amount]) => (player.inventory[itemId] || 0) >= amount);
}

function spendIngredients(player, ingredients) {
  for (const [itemId, amount] of Object.entries(ingredients)) spendItem(player, itemId, amount);
}

// Adds up all the bonuses from a player's traits and perks into one object.
// Recomputed fresh every time rather than cached, so it's never out of date.
function getPlayerModifiers(player) {
  const t = player.traits;
  const perkMods = {
    meleeDamageMult: 0,
    bonusDamageMult: 0,
    plantGrowthMult: 0,
    critChanceBonus: 0,
    armorFlat: 0,
    maxHpFlat: 0,
    miningSpeedMult: 0,
    woodcuttingSpeedMult: 0,
    fishingSpeedMult: 0,
    gatherSuccessBonus: 0,
  };
  for (const perkId of player.perks) {
    const perk = PERKS[perkId];
    if (!perk) continue;
    const { type, value } = perk.effect;
    if (type in perkMods) perkMods[type] += value;
  }
  return {
    // strength: +5% melee damage per point above TRAIT_BASE
    meleeDamageMult: 1 + (t.strength - TRAIT_BASE) * 0.05 + perkMods.meleeDamageMult,
    // dexterity: +2% damage on every attack (not melee-restricted — applies
    // to any future non-melee source too) per point above TRAIT_BASE.
    bonusDamageMult: 1 + (t.dexterity - TRAIT_BASE) * 0.02 + perkMods.bonusDamageMult,
    // dexterity: a flat chance to dodge an incoming enemy attack entirely (separate from Quick Step's evasion window)
    dodgeChance: Math.max(0, (t.dexterity - TRAIT_BASE) * 0.015),
    // luck + a sliver of dexterity: bonus crit chance
    critChanceBonus: (t.luck - TRAIT_BASE) * 0.01 + (t.dexterity - TRAIT_BASE) * 0.005 + perkMods.critChanceBonus,
    // luck: bonus chance on any %-based loot roll (enemy lootTable drops)
    lootChanceBonus: (t.luck - TRAIT_BASE) * 0.01,
    // luck + Treasure Hunter perk: bonus success chance on gather tasks
    gatherSuccessBonus: (t.luck - TRAIT_BASE) * 0.01 + perkMods.gatherSuccessBonus,
    // vigor + Vitality/Hardened perks: flat bonus max HP
    hpBonus: (t.vigor - TRAIT_BASE) * 4 + perkMods.maxHpFlat,
    armorFlat: perkMods.armorFlat,
    plantGrowthMult: perkMods.plantGrowthMult,
    miningSpeedMult: perkMods.miningSpeedMult,
    woodcuttingSpeedMult: perkMods.woodcuttingSpeedMult,
    fishingSpeedMult: perkMods.fishingSpeedMult,
  };
}

// Combat stats come from whatever's equipped — unarmed defaults if nothing
// is. Enemies use their own fixed ENEMIES entry instead (creature-based, not
// equipment-based), per the design requirement that only the player's side
// is gear-driven. Trait/perk bonuses (armor, crit) layer on top of gear.
function getEquippedStats(player) {
  const weapon = player.equipment.weapon ? ITEMS[player.equipment.weapon] : null;
  const armorItem = player.equipment.armor ? ITEMS[player.equipment.armor] : null;
  const mods = getPlayerModifiers(player);
  return {
    damage: weapon ? weapon.damage : [1, 2],
    critChance: (weapon ? weapon.critChance : 0.02) + mods.critChanceBonus,
    attackSpeed: weapon ? weapon.attackSpeed : 2.5,
    effect: weapon ? weapon.effect || null : null,
    armor: (armorItem ? armorItem.armor : 0) + mods.armorFlat,
  };
}

function playerMaxHp(player) {
  const level = levelFromXp(player.skills.combat.xp);
  const mods = getPlayerModifiers(player);
  return PLAYER_BASE_HP + (level - 1) * PLAYER_HP_PER_LEVEL + mods.hpBonus;
}

// Alchemy combat buffs (Potion of Strength/Swiftness) live as a single slot
// on the combat object, same one-effect-at-a-time pattern as dotOnEnemy/
// dotOnPlayer — checked fresh against real time on every turn rather than
// decremented, so it expires correctly whether the player is submitting
// moves quickly or comes back to a stale tab after a while.
function getActiveCombatBuff(c) {
  if (!c.buff) return null;
  if (Date.now() >= c.buff.expiresAt) {
    c.buff = null;
    return null;
  }
  return c.buff;
}

// Resolves who a potion targets: the player-chosen targetUid if it's still
// alive, otherwise the first living enemy — a defensive fallback so a
// potion never needs an explicit target picker in the UI (there's rarely
// more than one enemy, and "nearest/first living" is an obvious default).
function pickTarget(c, targetUid) {
  if (targetUid) {
    const chosen = c.enemies.find((e) => e.uid === targetUid && e.hp > 0);
    if (chosen) return chosen;
  }
  return c.enemies.find((e) => e.hp > 0) || null;
}

function isWall(grid, x, y) {
  return grid.walls.some((w) => w.x === x && w.y === y);
}

function enemyAt(c, x, y) {
  return c.enemies.find((e) => e.hp > 0 && e.x === x && e.y === y) || null;
}

// The player's whole turn: attempt one step. A wall or the grid edge blocks
// the move entirely (classic bump-into-wall — no turn consumed, nothing
// happens, so a misclick can't cost you a free enemy turn). Stepping onto a
// living enemy's tile attacks it instead of moving there.
function resolvePlayerMove(player, c, equip, direction) {
  const delta = COMBAT_DIRECTIONS[direction];
  const nx = c.playerPos.x + delta.dx;
  const ny = c.playerPos.y + delta.dy;
  if (nx < 0 || ny < 0 || nx >= c.grid.width || ny >= c.grid.height || isWall(c.grid, nx, ny)) {
    return { error: 'blocked' };
  }
  c.lastPlayerHit = null; // structured version of lastPlayerActionText, for the client's hit animation — see snapshotRound()
  const target = enemyAt(c, nx, ny);
  if (target) {
    attackEnemy(player, c, equip, target);
  } else {
    c.playerPos = { x: nx, y: ny };
    c.lastPlayerActionText = '';
  }
  return { ok: true };
}

// The player's basic attack — the only attack there is now, always using
// whatever's equipped (bare fists if nothing is), exactly like the old
// "Swing" ability. Potion damage/strength/dexterity bonuses from
// getPlayerModifiers() still apply, same math as before.
function attackEnemy(player, c, equip, target) {
  const potionBuff = getActiveCombatBuff(c);
  const potionDmgMultiplier = potionBuff && potionBuff.type === 'damage' ? potionBuff.multiplier : 1;
  const mods = getPlayerModifiers(player);
  const totalMultiplier = potionDmgMultiplier * mods.meleeDamageMult * mods.bonusDamageMult;
  let dmg = Math.round(randInt(equip.damage[0], equip.damage[1]) * totalMultiplier);
  let crit = false;
  if (Math.random() < equip.critChance) { dmg *= 2; crit = true; }
  target.hp = Math.max(0, target.hp - dmg);
  c.lastPlayerActionText = `You hit ${ENEMIES[target.enemyId].name} for ${dmg}`;
  c.lastPlayerHit = { type: 'damage', targetUid: target.uid, amount: dmg, crit };
  if (equip.effect && Math.random() < equip.effect.chance) {
    target.dot = { type: equip.effect.type, dps: equip.effect.dps, roundsLeft: equip.effect.duration };
  }
}

// One enemy's attack against the player. A dexterity-based dodgeChance applies on every incoming enemy attack.
// Pushes onto c.lastEnemyActionTexts/c.lastEnemyHits (both cleared once per
// turn by resolveEnemyTurns below) rather than overwriting a single value,
// so a multi-enemy fight's log/animation queue covers what every enemy did,
// not just the last one. lastEnemyHits is the structured twin of
// lastEnemyActionTexts, one entry per enemy in the same order, used by the
// client to animate the correct enemy attacking — see snapshotRound().
function resolveEnemyAttackOn(player, c, target, equip) {
  const enemy = ENEMIES[target.enemyId];
  const evasionBuff = getActiveCombatBuff(c);
  const evasionBonus = evasionBuff && evasionBuff.type === 'evasion' ? evasionBuff.multiplier : 0;
  if (Math.random() < getPlayerModifiers(player).dodgeChance + evasionBonus) {
    c.lastEnemyActionTexts.push(`${enemy.name} attacks — you dodge!`);
    c.lastEnemyHits.push({ uid: target.uid, type: 'dodged' });
    return;
  }
  let dmg = randInt(enemy.damage[0], enemy.damage[1]);
  let crit = false;
  if (Math.random() < enemy.critChance) { dmg *= 2; crit = true; }
  dmg = Math.max(1, dmg - equip.armor);
  c.playerHp = Math.max(0, c.playerHp - dmg);
  c.lastEnemyActionTexts.push(`${enemy.name} hits you for ${dmg}`);
  c.lastEnemyHits.push({ uid: target.uid, type: 'damage', amount: dmg, crit });
  if (enemy.effect && Math.random() < enemy.effect.chance) {
    c.dotOnPlayer = { type: enemy.effect.type, dps: enemy.effect.dps, roundsLeft: enemy.effect.duration };
  }
}

// Which tile a non-adjacent enemy tries to step into to close the distance:
// prefer the axis with the bigger gap first (a straighter approach), fall
// back to the other axis if that step turns out to be blocked.
function chooseEnemyStep(e, playerPos) {
  const dx = playerPos.x - e.x;
  const dy = playerPos.y - e.y;
  const options = [];
  const primary = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  if (primary === 'x') {
    if (dx !== 0) options.push({ x: e.x + Math.sign(dx), y: e.y });
    if (dy !== 0) options.push({ x: e.x, y: e.y + Math.sign(dy) });
  } else {
    if (dy !== 0) options.push({ x: e.x, y: e.y + Math.sign(dy) });
    if (dx !== 0) options.push({ x: e.x + Math.sign(dx), y: e.y });
  }
  return options;
}

// Every still-living enemy takes its one action: attack if it's standing
// next to the player (4-directional adjacency — no diagonal attacks, same
// as the player can only bump-attack in straight lines), otherwise take one
// step toward the player. Shared by both a fresh ambush's free first hit
// and the normal end of a player turn.
function resolveEnemyTurns(player, c, equip) {
  c.lastEnemyActionTexts = [];
  c.lastEnemyHits = [];
  for (const e of c.enemies) {
    if (e.hp <= 0 || c.playerHp <= 0) continue;
    const dx = c.playerPos.x - e.x;
    const dy = c.playerPos.y - e.y;
    if (Math.abs(dx) + Math.abs(dy) === 1) {
      resolveEnemyAttackOn(player, c, e, equip);
      continue;
    }
    for (const step of chooseEnemyStep(e, c.playerPos)) {
      if (step.x < 0 || step.y < 0 || step.x >= c.grid.width || step.y >= c.grid.height) continue;
      if (isWall(c.grid, step.x, step.y)) continue;
      if (step.x === c.playerPos.x && step.y === c.playerPos.y) continue; // never walk onto the player's own tile
      if (enemyAt(c, step.x, step.y)) continue; // another enemy is already there
      e.x = step.x;
      e.y = step.y;
      break;
    }
  }
}

// DOT resolves once per afflicted target per turn. dps/roundsLeft are
// damage-per-turn and turns-remaining, not real-time-scaled.
function tickDots(c) {
  for (const e of c.enemies) {
    if (e.hp <= 0 || !e.dot) continue;
    e.hp = Math.max(0, e.hp - e.dot.dps);
    e.dot.roundsLeft -= 1;
    if (e.dot.roundsLeft <= 0) e.dot = null;
  }
  if (c.dotOnPlayer) {
    c.playerHp = Math.max(0, c.playerHp - c.dotOnPlayer.dps);
    c.dotOnPlayer.roundsLeft -= 1;
    if (c.dotOnPlayer.roundsLeft <= 0) c.dotOnPlayer = null;
  }
}

// All enemies dead -> win (rewards summed across every enemy in the group);
// player dead -> loss. Called after every resolved turn.
function checkCombatEnd(player, c) {
  if (c.result) return;
  if (c.enemies.every((e) => e.hp <= 0)) {
    c.result = 'win';
    let totalGold = 0;
    c.rewardLoot = [];
    const lootChanceBonus = getPlayerModifiers(player).lootChanceBonus;
    for (const e of c.enemies) {
      const enemy = ENEMIES[e.enemyId];
      totalGold += randInt(enemy.goldReward[0], enemy.goldReward[1]);
      player.skills.combat.xp += enemy.xpReward;
      for (const drop of enemy.lootTable || []) {
        if (Math.random() < drop.chance + lootChanceBonus) {
          addItem(player, drop.item, 1);
          c.rewardLoot.push(drop.item);
        }
      }
      player.killCounts[e.enemyId] = (player.killCounts[e.enemyId] || 0) + 1;
    }
    // Area-tier bonus loot, on top of each individual enemy's own
    // lootTable — see WORLD_TIERS. Gold rolls fold straight into totalGold;
    // everything else adds to inventory/rewardLoot exactly like an enemy
    // drop would, so the client's "found: X, Y, Z" victory line covers both
    // sources with no special-casing.
    const tierConfig = WORLD_TIERS[c.tier];
    if (tierConfig) {
      for (const drop of tierConfig.bonusLoot) {
        if (Math.random() < drop.chance + lootChanceBonus) {
          const amount = randInt(drop.amount[0], drop.amount[1]);
          if (drop.item === 'gold') {
            totalGold += amount;
          } else {
            player.inventory[drop.item] = (player.inventory[drop.item] || 0) + amount;
            c.rewardLoot.push(drop.item);
          }
        }
      }
    }
    player.inventory.gold = (player.inventory.gold || 0) + totalGold;
    c.rewardGold = totalGold;
    player.combatRecord.wins += 1;
  } else if (c.playerHp <= 0) {
    c.result = 'loss';
    player.combatRecord.losses += 1;
  }
}

// One log entry per resolved turn: text plus structured hit data
// (playerHit/enemyHits — who got hit, how much, crit/dodge) so the client
// can drive per-event animations instead of just displaying text, plus a
// position/HP snapshot of everyone at that exact point so the grid and bars
// land on the true value — see game.js's playCombatLog().
function snapshotRound(c) {
  return {
    player: c.lastPlayerActionText,
    playerHit: c.lastPlayerHit || null,
    enemies: [...c.lastEnemyActionTexts],
    enemyHits: [...c.lastEnemyHits],
    playerHp: c.playerHp,
    playerPos: { ...c.playerPos },
    enemyPositions: c.enemies.map((e) => ({ uid: e.uid, x: e.x, y: e.y, hp: e.hp })),
  };
}

// The rest of a turn once the player's side has already been applied
// (move, attack, or item effect) — every enemy still living gets its one
// response, DOT ticks, the turn counter advances, and win/loss is checked.
// Shared by submitCombatMove()/submitCombatItemAction() since both end in
// exactly this sequence — the only difference between them is what happens
// on the player's side before this runs.
function advanceRound(player, c, equip) {
  resolveEnemyTurns(player, c, equip);
  tickDots(c);
  c.turn += 1;
  checkCombatEnd(player, c);
  return snapshotRound(c);
}

// The whole of a turn-based combat move, server-authoritative start to
// finish: the player steps in a direction (moving, or attacking whatever's
// in that tile), then every living enemy gets exactly one response — a
// strict 1-for-1 exchange, never more than one enemy action per player
// turn. Returns the full result immediately — no polling needed while the
// player decides their next move, and nothing for a client to fake, since
// the server is the only thing that ever runs this logic. A blocked move
// (wall/edge) returns an error and consumes no turn at all.
function submitCombatMove(playerId, direction) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const c = player.combat;
  if (!c) return { error: 'no_combat' };
  if (c.result) return { error: 'combat_over' };
  if (!COMBAT_DIRECTIONS[direction]) return { error: 'invalid_direction' };

  const equip = getEquippedStats(player);
  const moveResult = resolvePlayerMove(player, c, equip, direction);
  if (moveResult.error) return { error: moveResult.error };
  const round = advanceRound(player, c, equip);

  // publicPlayer() saves once at the end (after also ticking resource
  // tasks/expedition) — no separate save() here, so a single move never
  // writes db.json twice.
  return { ok: true, log: [round], player: publicPlayer(player) };
}

// How much xp it takes to go from `level` to `level+1`. Each level costs a
// bit more than the last, so leveling up gets slower over time, like most
// RPGs.
function xpCostForLevel(level) {
  return XP_PER_LEVEL + XP_LEVEL_INCREMENT * (level - 1);
}

// Walks the level curve once and returns the level plus how far into it the
// player is and how much the next level costs.
function xpProgress(xp) {
  let level = 1;
  let remaining = xp;
  while (remaining >= xpCostForLevel(level)) {
    remaining -= xpCostForLevel(level);
    level += 1;
  }
  return { level, xpIntoLevel: remaining, xpToNextLevel: xpCostForLevel(level) };
}

function levelFromXp(xp) {
  return xpProgress(xp).level;
}

function publicSkill(skillId, skill) {
  const { level, xpIntoLevel, xpToNextLevel } = xpProgress(skill.xp);
  const base = {
    xp: skill.xp,
    level,
    xpIntoLevel,
    xpToNextLevel,
  };
  if (!RESOURCE_NODES[skillId]) {
    // e.g. combat — leveled by xp like any skill, but not a node-based task
    return { ...base, active: false };
  }
  // Every resource skill (mining/woodcutting/fishing/hunting/scavenging/
  // harvesting) is node-grid based now — this entry is just level/xp/active
  // for anything reading player.skills generically (e.g. the Statistics
  // tab); the real per-node detail (which item, locked/unlocked, progress)
  // comes from player.<skillId>Nodes — see publicResourceNodes()/publicPlayer().
  return { ...base, active: !!skill.taskStartedAt };
}

function questObjectiveMet(player, quest) {
  const obj = quest.objective;
  if (obj.type === 'kill') return (player.killCounts[obj.enemyId] || 0) >= obj.count;
  if (obj.type === 'gather') return (player.inventory[obj.itemId] || 0) >= obj.count;
  if (obj.type === 'visit') return player.discoveries.includes(obj.locationId);
  return false;
}

function publicPlayer(player) {
  for (const skillId of Object.keys(RESOURCE_NODES)) {
    tickResourceTask(player, skillId);
  }
  save();
  const skills = {};
  for (const [id, skill] of Object.entries(player.skills)) {
    skills[id] = publicSkill(id, skill);
  }
  // Fishing-only bonus-catch minigame timing, merged in here (not inside
  // publicSkill()) since it needs the full player object for
  // getPlayerModifiers()/player.id, not just the one skill entry.
  if (skills.fishing && skills.fishing.active) {
    const bite = getFishingBite(player);
    if (bite) {
      skills.fishing.biteAt = bite.biteAt;
      skills.fishing.biteWindowMs = bite.windowMs;
    }
  }
  const inventory = Object.entries(player.inventory).map(([itemId, count]) => ({
    id: itemId,
    name: ITEMS[itemId].name,
    count,
  }));
  const equipStats = getEquippedStats(player);
  const equipment = {
    weapon: player.equipment.weapon ? { id: player.equipment.weapon, name: ITEMS[player.equipment.weapon].name } : null,
    armor: player.equipment.armor ? { id: player.equipment.armor, name: ITEMS[player.equipment.armor].name } : null,
    stats: equipStats,
  };

  let combat = null;
  if (player.combat) {
    const c = player.combat;
    const activeBuff = getActiveCombatBuff(c);
    combat = {
      grid: { width: c.grid.width, height: c.grid.height, walls: c.grid.walls },
      playerPos: c.playerPos,
      enemies: c.enemies.map((e) => {
        const enemy = ENEMIES[e.enemyId];
        return {
          uid: e.uid,
          enemyId: e.enemyId,
          name: enemy.name,
          hp: e.hp,
          maxHp: e.maxHp,
          alive: e.hp > 0,
          x: e.x,
          y: e.y,
          dot: e.dot ? { type: e.dot.type } : null,
        };
      }),
      playerHp: c.playerHp,
      playerMaxHp: c.playerMaxHp,
      turn: c.turn,
      result: c.result,
      rewardGold: c.rewardGold || 0,
      rewardLoot: (c.rewardLoot || []).map((itemId) => ({ id: itemId, name: ITEMS[itemId].name })),
      dotOnPlayer: c.dotOnPlayer ? { type: c.dotOnPlayer.type } : null,
      buff: activeBuff ? { type: activeBuff.type } : null,
      lastPlayerActionText: c.lastPlayerActionText || '',
      lastEnemyActionTexts: c.lastEnemyActionTexts || [],
      ambush: !!c.ambush,
    };
  }

  const plantGrowthMult = getPlayerModifiers(player).plantGrowthMult;
  const garden = {
    plots: player.garden.plots.map((plot) => {
      if (!plot) return null;
      const plant = PLANTS[plot.plantId];
      const effectiveGrowSeconds = effectivePlantGrowSeconds(plant, plantGrowthMult);
      const elapsedSeconds = (Date.now() - plot.plantedAt) / 1000;
      const progress = Math.min(1, elapsedSeconds / effectiveGrowSeconds);
      return {
        plantId: plot.plantId,
        plantName: plant.name,
        growSeconds: effectiveGrowSeconds,
        progress,
        ready: progress >= 1,
      };
    }),
  };

  const farm = {
    animals: player.farm.animals.map((a) => {
      const species = ANIMAL_SPECIES[a.species];
      const ageSeconds = (Date.now() - a.bornAt) / 1000;
      const mature = ageSeconds >= species.matureSeconds;
      const oneTime = !!species.butcherItem;
      let progress = Math.min(1, ageSeconds / species.matureSeconds);
      let ready = false;
      if (mature) {
        if (oneTime) {
          ready = true;
          progress = 1;
        } else {
          const since = a.lastCollectedAt || a.bornAt + species.matureSeconds * 1000;
          const elapsedSeconds = (Date.now() - since) / 1000;
          progress = Math.min(1, elapsedSeconds / species.produceIntervalSeconds);
          ready = elapsedSeconds >= species.produceIntervalSeconds;
        }
      }
      return {
        id: a.id,
        species: a.species,
        speciesName: species.name,
        mature,
        ready,
        progress,
        oneTime,
        producesItem: species.produceItem || species.butcherItem,
        producesItemName: ITEMS[species.produceItem || species.butcherItem].name,
      };
    }),
  };

  const buildings = {};
  for (const [type, b] of Object.entries(player.buildings)) {
    const config = BUILDINGS[type];
    const elapsedSeconds = (Date.now() - b.lastCollectedAt) / 1000;
    const pendingAmount = Math.floor(elapsedSeconds / config.produceIntervalSeconds);
    buildings[type] = {
      type,
      name: config.name,
      producesItem: config.producesItem,
      producesItemName: ITEMS[config.producesItem].name,
      produceIntervalSeconds: config.produceIntervalSeconds,
      pendingAmount,
      progress: Math.min(1, (elapsedSeconds % config.produceIntervalSeconds) / config.produceIntervalSeconds),
    };
  }

  const quests = {
    started: player.quests.started.map((id) => {
      const q = QUESTS[id];
      return { id, name: q.name, description: q.description, objectiveMet: questObjectiveMet(player, q) };
    }),
    completed: player.quests.completed,
  };

  return {
    id: player.id,
    username: player.username,
    currentLocation: player.currentLocation,
    discoveries: player.discoveries,
    inventory,
    skills,
    worldPos: player.worldPos,
    revealedTiles: player.revealedTiles,
    equipment,
    combat,
    combatMaxHp: playerMaxHp(player),
    garden,
    farm,
    buildings,
    quests,
    killCounts: player.killCounts,
    combatRecord: player.combatRecord,
    lastRareEvent: player.lastRareEvent,
    alchemy: {
      // Only recipes the player has personally discovered are ever sent —
      // the full POTION_RECIPES table stays server-only so combos can't be
      // read out of the network tab.
      knownRecipes: player.alchemy.knownRecipes.map((id) => {
        const r = POTION_RECIPES.find((rec) => rec.id === id);
        return { id: r.id, ingredients: Object.keys(r.ingredients), result: r.result, resultName: ITEMS[r.result].name };
      }),
      triedCount: player.alchemy.triedCombos.length,
    },
    traits: player.traits,
    character: xpProgress(player.characterXp), // { level, xpIntoLevel, xpToNextLevel }
    traitPointsAvailable: player.traitPointsAvailable,
    perkPoints: player.perkPoints,
    perks: Object.entries(PERKS).map(([id, perk]) => ({
      id,
      name: perk.name,
      description: perk.description,
      tier: perk.tier,
      requiresLevel: perk.requiresLevel,
      cost: perk.cost,
      unlocked: player.perks.includes(id),
      levelMet: levelFromXp(player.characterXp) >= perk.requiresLevel,
    })),
    miningNodes: publicResourceNodes(player, 'mining'),
    woodcuttingNodes: publicResourceNodes(player, 'woodcutting'),
    fishingNodes: publicResourceNodes(player, 'fishing'),
    huntingNodes: publicResourceNodes(player, 'hunting'),
    scavengingNodes: publicResourceNodes(player, 'scavenging'),
    harvestingNodes: publicResourceNodes(player, 'harvesting'),
  };
}

function stopTask(playerId, skillId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const skill = player.skills[skillId];
  if (!skill) return { error: 'unknown_skill' };
  tickResourceTask(player, skillId);
  skill.taskStartedAt = null;
  skill.lastTick = null;
  save();
  return { ok: true };
}

// --- equipment ---

// Equipping consumes 1 unit from inventory (it's "worn"); whatever was
// previously in that slot goes back to inventory. Unequip is the reverse.
function equipItem(playerId, itemId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const item = ITEMS[itemId];
  if (!item || (item.type !== 'weapon' && item.type !== 'armor')) return { error: 'not_equippable' };
  const owned = player.inventory[itemId] || 0;
  if (owned <= 0) return { error: 'not_owned' };

  const slot = item.type;
  const previous = player.equipment[slot];

  spendItem(player, itemId, 1);
  if (previous) addItem(player, previous, 1);
  player.equipment[slot] = itemId;
  save();
  return { ok: true, slot, itemId };
}

function unequipItem(playerId, slot) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (slot !== 'weapon' && slot !== 'armor') return { error: 'invalid_slot' };
  const current = player.equipment[slot];
  if (!current) return { error: 'nothing_equipped' };
  addItem(player, current, 1);
  player.equipment[slot] = null;
  save();
  return { ok: true, slot };
}

// --- combat ---

function startCombat(playerId, enemyId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (player.combat && !player.combat.result) return { error: 'combat_in_progress' };
  const loc = getLocation(player.currentLocation);
  if (!loc || !loc.combat || !WORLD_TIERS[loc.tier].enemies.includes(enemyId)) return { error: 'enemy_not_here' };
  const enemy = ENEMIES[enemyId];
  if (!enemy) return { error: 'unknown_enemy' };

  stopAllSkillTasks(player); // only one task at a time — starting a fight stops any active skill
  const group = rollEncounterGroup(loc, enemyId);
  beginCombatInstance(player, group, false, loc.tier);
  save();
  return { ok: true };
}

// Used both to flee an ongoing fight (no reward) and to acknowledge/clear a
// finished result (win or loss) so the player can fight again.
function endCombat(playerId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (!player.combat) return { error: 'no_combat' };
  player.combat = null;
  save();
  return { ok: true };
}


// --- character progression (traits + perks, see Character tab) ---

function allocateTraitPoint(playerId, traitName) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (!TRAIT_KEYS.includes(traitName)) return { error: 'invalid_trait' };
  if (player.traitPointsAvailable <= 0) return { error: 'no_points_available' };
  player.traitPointsAvailable -= 1;
  player.traits[traitName] += 1;
  save();
  return { ok: true, trait: traitName, value: player.traits[traitName] };
}

function unlockPerk(playerId, perkId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const perk = PERKS[perkId];
  if (!perk) return { error: 'unknown_perk' };
  if (player.perks.includes(perkId)) return { error: 'already_unlocked' };
  if (player.perkPoints < perk.cost) return { error: 'not_enough_points' };
  if (levelFromXp(player.characterXp) < perk.requiresLevel) return { error: 'level_too_low' };
  player.perkPoints -= perk.cost;
  player.perks.push(perkId);
  save();
  return { ok: true, perkId };
}

// --- gardening ---

function plantSeed(playerId, plotIndex, plantId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const plant = PLANTS[plantId];
  if (!plant) return { error: 'unknown_plant' };
  // Must check Number.isInteger first — a non-numeric plotIndex (e.g. a
  // string from a hostile request) fails both range comparisons below
  // (NaN < 0 and NaN >= length are both false), which used to let it slip
  // through and plant into a bogus, unreachable "plot" — wasting the seed
  // with no visible effect for the player.
  if (!Number.isInteger(plotIndex) || plotIndex < 0 || plotIndex >= player.garden.plots.length) {
    return { error: 'invalid_plot' };
  }
  if (player.garden.plots[plotIndex]) return { error: 'plot_occupied' };
  const owned = player.inventory[plant.seed] || 0;
  if (owned <= 0) return { error: 'no_seed' };

  spendItem(player, plant.seed, 1);
  player.garden.plots[plotIndex] = { plantId, plantedAt: Date.now() };
  save();
  return { ok: true };
}

// Green Thumb/Deep Roots perks shrink grow time — floored so a stacked
// bonus can never reach 0/negative. Shared by harvestPlot()'s ready-check
// and publicPlayer()'s live progress display so they can never disagree.
function effectivePlantGrowSeconds(plant, plantGrowthMult) {
  return Math.max(5, plant.growSeconds * (1 - plantGrowthMult));
}

function harvestPlot(playerId, plotIndex) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const plot = player.garden.plots[plotIndex];
  if (!plot) return { error: 'plot_empty' };
  const plant = PLANTS[plot.plantId];
  const effectiveGrowSeconds = effectivePlantGrowSeconds(plant, getPlayerModifiers(player).plantGrowthMult);
  const elapsedSeconds = (Date.now() - plot.plantedAt) / 1000;
  if (elapsedSeconds < effectiveGrowSeconds) return { error: 'not_ready' };

  addItem(player, plant.yield, 1);
  player.garden.plots[plotIndex] = null;
  save();
  return { ok: true, yield: plant.yield };
}

// --- crafting ---

function craftItem(playerId, recipeId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const recipe = RECIPES.find((r) => r.id === recipeId);
  if (!recipe) return { error: 'unknown_recipe' };
  if (!hasIngredients(player, recipe.ingredients)) return { error: 'missing_ingredients' };
  spendIngredients(player, recipe.ingredients);
  addItem(player, recipe.result, recipe.resultAmount);
  save();
  return { ok: true, result: recipe.result, resultAmount: recipe.resultAmount };
}

// --- alchemy ---

// Combine two owned ingredients to see what happens. The ingredients are
// always used up, whether it works or not — that's the cost of
// experimenting. If a combo has already been tried and failed before, it's
// remembered so trying it again doesn't waste more ingredients.
function experimentAlchemy(playerId, ingredientA, ingredientB) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (!ITEMS[ingredientA] || ITEMS[ingredientA].type !== 'ingredient') return { error: 'invalid_ingredient' };
  if (!ITEMS[ingredientB] || ITEMS[ingredientB].type !== 'ingredient') return { error: 'invalid_ingredient' };
  if (ingredientA === ingredientB) return { error: 'need_two_different_ingredients' };

  if ((player.inventory[ingredientA] || 0) < 1 || (player.inventory[ingredientB] || 0) < 1) {
    return { error: 'missing_ingredients' };
  }

  const comboKey = ingredientComboKey([ingredientA, ingredientB]);
  const recipe = POTION_RECIPES.find((r) => ingredientComboKey(Object.keys(r.ingredients)) === comboKey);

  if (!recipe && player.alchemy.triedCombos.includes(comboKey)) {
    return { ok: true, discovered: false, alreadyTried: true };
  }

  spendItem(player, ingredientA, 1);
  spendItem(player, ingredientB, 1);

  if (recipe) {
    addItem(player, recipe.result, 1);
    const newDiscovery = !player.alchemy.knownRecipes.includes(recipe.id);
    if (newDiscovery) player.alchemy.knownRecipes.push(recipe.id);
    save();
    return { ok: true, discovered: true, newDiscovery, recipeId: recipe.id, result: recipe.result, resultName: ITEMS[recipe.result].name };
  }

  if (!player.alchemy.triedCombos.includes(comboKey)) player.alchemy.triedCombos.push(comboKey);
  save();
  return { ok: true, discovered: false };
}

// Re-brew a potion whose recipe this player has already discovered — same
// idea as craftItem() but gated on player.alchemy.knownRecipes instead of
// being universally available, since the whole point of alchemy is that
// recipes start hidden.
function craftKnownPotion(playerId, recipeId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (!player.alchemy.knownRecipes.includes(recipeId)) return { error: 'not_known' };
  const recipe = POTION_RECIPES.find((r) => r.id === recipeId);
  if (!recipe) return { error: 'unknown_recipe' };
  if (!hasIngredients(player, recipe.ingredients)) return { error: 'missing_ingredients' };
  spendIngredients(player, recipe.ingredients);
  addItem(player, recipe.result, 1);
  save();
  return { ok: true, result: recipe.result, resultName: ITEMS[recipe.result].name };
}

// Potions only do something meaningful mid-fight (heal/cure/buff/poison the
// enemy) — there's no persistent HP outside combat to heal in this game, so
// usage is restricted to an active, unresolved fight rather than inventing a
// resting-HP concept that doesn't exist anywhere else in the codebase.
// Using an item IS the player's turn (same as a move/attack), not a free
// action available alongside one — same turn-resolution shape as
// submitCombatMove (apply the player-side effect, then the enemies get
// their turn, then DOT, then check for a result). A failed use (nothing to
// cure, no valid target) returns an error before anything is consumed or
// the enemies act — only a real action costs a turn.
function submitCombatItemAction(playerId, itemId, targetUid) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const item = ITEMS[itemId];
  if (!item || item.type !== 'potion') return { error: 'not_a_potion' };
  if ((player.inventory[itemId] || 0) < 1) return { error: 'not_owned' };
  const c = player.combat;
  if (!c || c.result) return { error: 'not_in_combat' };

  const effect = item.potionEffect;
  c.lastPlayerHit = null; // structured version of lastPlayerActionText, for the client's hit animation — see snapshotRound()
  if (effect.kind === 'heal') {
    const amount = Math.min(effect.amount, c.playerMaxHp - c.playerHp);
    c.playerHp = Math.min(c.playerMaxHp, c.playerHp + effect.amount);
    c.lastPlayerActionText = `Used ${item.name} — restored ${effect.amount} HP`;
    if (amount > 0) c.lastPlayerHit = { type: 'heal', amount };
  } else if (effect.kind === 'cure') {
    if (!c.dotOnPlayer) return { error: 'nothing_to_cure' };
    c.dotOnPlayer = null;
    c.lastPlayerActionText = `Used ${item.name} — cured the affliction`;
  } else if (effect.kind === 'buff_damage') {
    c.buff = { type: 'damage', multiplier: effect.multiplier, expiresAt: Date.now() + effect.durationSeconds * 1000 };
    c.lastPlayerActionText = `Used ${item.name} — damage boosted`;
  } else if (effect.kind === 'buff_speed') {
    // See ITEMS.potion_of_swiftness — this is an evasion buff now, not a
    // speed one; resolveEnemyAttackOn() reads it as a flat dodge-chance bonus.
    c.buff = { type: 'evasion', multiplier: effect.multiplier, expiresAt: Date.now() + effect.durationSeconds * 1000 };
    c.lastPlayerActionText = `Used ${item.name} — evasion boosted`;
  } else if (effect.kind === 'poison_enemy') {
    const target = pickTarget(c, targetUid);
    if (!target) return { error: 'no_target' };
    target.dot = { type: 'venom', dps: effect.dps, roundsLeft: effect.duration };
    c.lastPlayerActionText = `Used ${item.name} on ${ENEMIES[target.enemyId].name}`;
    c.lastPlayerHit = { type: 'debuff', targetUid: target.uid };
  }

  player.inventory[itemId] -= 1;
  if (player.inventory[itemId] <= 0) delete player.inventory[itemId];

  const equip = getEquippedStats(player);
  const round = advanceRound(player, c, equip);

  return { ok: true, log: [round], player: publicPlayer(player) };
}

// --- farming (animals) ---

function buyAnimal(playerId, speciesId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const species = ANIMAL_SPECIES[speciesId];
  if (!species) return { error: 'unknown_species' };
  const gold = player.inventory.gold || 0;
  if (gold < species.price) return { error: 'not_enough_gold' };

  player.inventory.gold = gold - species.price;
  const id = genId('a_');
  player.farm.animals.push({ id, species: speciesId, bornAt: Date.now(), lastCollectedAt: null });
  save();
  return { ok: true, id };
}

// Collect on a mature cow/chicken grants one unit of produce and resets its
// timer; collect on a mature pig is a one-time butcher that removes it.
function collectAnimal(playerId, animalId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const animal = player.farm.animals.find((a) => a.id === animalId);
  if (!animal) return { error: 'unknown_animal' };
  const species = ANIMAL_SPECIES[animal.species];
  const ageSeconds = (Date.now() - animal.bornAt) / 1000;
  if (ageSeconds < species.matureSeconds) return { error: 'not_mature' };

  if (species.butcherItem) {
    addItem(player, species.butcherItem, 1);
    player.farm.animals = player.farm.animals.filter((a) => a.id !== animalId);
    save();
    return { ok: true, item: species.butcherItem, removed: true };
  }

  const since = animal.lastCollectedAt || animal.bornAt + species.matureSeconds * 1000;
  const elapsedSeconds = (Date.now() - since) / 1000;
  if (elapsedSeconds < species.produceIntervalSeconds) return { error: 'not_ready' };
  addItem(player, species.produceItem, 1);
  animal.lastCollectedAt = Date.now();
  save();
  return { ok: true, item: species.produceItem, removed: false };
}

// --- buildings ---

function buildBuilding(playerId, buildingType) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const building = BUILDINGS[buildingType];
  if (!building) return { error: 'unknown_building' };
  if (player.buildings[buildingType]) return { error: 'already_built' };
  if (!hasIngredients(player, building.cost)) return { error: 'missing_resources' };
  spendIngredients(player, building.cost);
  player.buildings[buildingType] = { builtAt: Date.now(), lastCollectedAt: Date.now() };
  save();
  return { ok: true };
}

function collectBuilding(playerId, buildingType) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const built = player.buildings[buildingType];
  if (!built) return { error: 'not_built' };
  const building = BUILDINGS[buildingType];
  const elapsedSeconds = (Date.now() - built.lastCollectedAt) / 1000;
  const amount = Math.floor(elapsedSeconds / building.produceIntervalSeconds);
  if (amount <= 0) return { error: 'nothing_ready' };
  addItem(player, building.producesItem, amount);
  built.lastCollectedAt += amount * building.produceIntervalSeconds * 1000;
  save();
  return { ok: true, item: building.producesItem, amount };
}

// --- quests ---

function acceptQuest(playerId, questId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const quest = QUESTS[questId];
  if (!quest) return { error: 'unknown_quest' };
  if (player.quests.completed.includes(questId)) return { error: 'already_completed' };
  if (player.quests.started.includes(questId)) return { error: 'already_started' };
  player.quests.started.push(questId);
  save();
  return { ok: true };
}

function turnInQuest(playerId, questId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const quest = QUESTS[questId];
  if (!quest) return { error: 'unknown_quest' };
  if (!player.quests.started.includes(questId)) return { error: 'not_started' };
  if (!questObjectiveMet(player, quest)) return { error: 'objective_not_met' };

  if (quest.objective.type === 'gather') {
    spendItem(player, quest.objective.itemId, quest.objective.count);
  }
  if (quest.reward.gold) {
    addItem(player, 'gold', quest.reward.gold);
  }
  if (quest.reward.xp) {
    for (const [skillId, xp] of Object.entries(quest.reward.xp)) {
      if (player.skills[skillId]) player.skills[skillId].xp += xp;
    }
  }
  player.quests.started = player.quests.started.filter((id) => id !== questId);
  player.quests.completed.push(questId);
  save();
  return { ok: true, reward: quest.reward };
}

// --- shop ---

function buyItem(playerId, itemId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const shopEntry = SHOP_ITEMS.find((s) => s.id === itemId);
  if (!shopEntry) return { error: 'not_for_sale' };
  const gold = player.inventory.gold || 0;
  if (gold < shopEntry.price) return { error: 'not_enough_gold' };

  player.inventory.gold = gold - shopEntry.price;
  addItem(player, itemId, 1);
  save();
  return { ok: true, itemId, price: shopEntry.price, goldRemaining: player.inventory.gold };
}

// Sells any amount of any item that has a sellPrice (everything except
// 'gold' itself) — deliberately not restricted to SHOP_ITEMS, so raw
// materials/loot/potions the player has no other use for can always be
// converted to gold instead of being a dead end in the inventory.
function sellItem(playerId, itemId, amount) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const item = ITEMS[itemId];
  if (!item || !item.sellPrice) return { error: 'not_sellable' };
  const qty = Math.floor(amount) || 1;
  if (qty < 1) return { error: 'invalid_amount' };
  if ((player.inventory[itemId] || 0) < qty) return { error: 'not_enough_owned' };

  const total = item.sellPrice * qty;
  spendItem(player, itemId, qty);
  addItem(player, 'gold', total);
  save();
  return { ok: true, itemId, amount: qty, goldEarned: total, goldTotal: player.inventory.gold };
}

function buyLocationReveal(playerId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const gold = player.inventory.gold || 0;
  if (gold < LOCATION_REVEAL_PRICE) return { error: 'not_enough_gold' };
  const undiscovered = LOCATIONS.filter((l) => !player.discoveries.includes(l.id));
  if (undiscovered.length === 0) return { error: 'nothing_left' };

  const found = undiscovered[Math.floor(Math.random() * undiscovered.length)];
  player.inventory.gold = gold - LOCATION_REVEAL_PRICE;
  discoverLocation(player, found.id); // grants character xp same as walking up to it for free
  save();
  return { ok: true, location: found, goldRemaining: player.inventory.gold };
}

// --- dev/testing commands only — not gated behind auth since this is a
// solo/local prototype; remove or lock these down before any public launch. ---

function devGiveItem(playerId, itemId, amount) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (!ITEMS[itemId]) return { error: 'unknown_item' };
  player.inventory[itemId] = Math.max(0, (player.inventory[itemId] || 0) + amount);
  save();
  return { ok: true, itemId, count: player.inventory[itemId] };
}

function devDiscoverLocation(playerId, locationId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const loc = getLocation(locationId);
  if (!loc) return { error: 'unknown_location' };
  if (!player.discoveries.includes(locationId)) player.discoveries.push(locationId);
  save();
  return { ok: true, locationId };
}

function devSetSkillXp(playerId, skillId, xp) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const skill = player.skills[skillId];
  if (!skill) return { error: 'unknown_skill' };
  skill.xp = Math.max(0, xp);
  save();
  return { ok: true, skillId, xp: skill.xp };
}

// Resets the current player back to a fresh character, keeping the same
// id/username so they stay logged in. Handy for testing exploration and
// the economy over and over without editing the save file by hand.
function devResetPlayer(playerId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const startLoc = LOCATIONS.find((l) => l.startingLocation);

  player.currentLocation = startLoc.id;
  player.worldPos = { x: startLoc.gx, y: startLoc.gy };
  player.revealedTiles = [`${startLoc.gx},${startLoc.gy}`];
  player.discoveries = [startLoc.id];
  player.inventory = { supplies: STARTER_SUPPLIES, gold: 20 };
  player.equipment = { weapon: null, armor: null };
  player.combat = null;
  player.garden = { plots: new Array(GARDEN_PLOT_COUNT).fill(null) };
  for (const skillId of Object.keys(player.skills)) {
    player.skills[skillId] = RESOURCE_NODES[skillId]
      ? { xp: 0, progressSeconds: 0, taskStartedAt: null, lastTick: null, activeNode: null }
      : { xp: 0 };
  }
  player.farm = { animals: [] };
  player.buildings = {};
  player.quests = { started: [], completed: [] };
  player.killCounts = {};
  player.combatRecord = { wins: 0, losses: 0 };
  player.lastRareEvent = null;
  player.alchemy = { knownRecipes: [], triedCombos: [] };
  // Deliberately NOT reset: traits/characterXp/traitPointsAvailable/
  // perkPoints/perks. Those represent the chosen character build, not
  // explore/economy state — dev.reset() is for repeat-testing exploration
  // and the economy, not relitigating a character's build.

  save();
  return { ok: true };
}

module.exports = {
  LOCATIONS,
  WORLD_TIERS,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  ITEMS,
  ENEMIES,
  PLANTS,
  RECIPES,
  ANIMAL_SPECIES,
  BUILDINGS,
  NPCS,
  DIALOGUE_TREES,
  QUESTS,
  SHOP_ITEMS,
  LOCATION_REVEAL_PRICE,
  PERKS,
  RESOURCE_NODES,
  TRAIT_KEYS,
  TRAIT_BASE,
  TRAIT_MIN,
  TRAIT_MAX,
  TRAIT_EXTRA_POINTS,
  login,
  createCharacter,
  verifyToken,
  getPlayer,
  publicPlayer,
  moveOnWorldGrid,
  stopTask,
  attemptFishingCatch,
  startResourceTask,
  equipItem,
  unequipItem,
  startCombat,
  endCombat,
  submitCombatMove,
  submitCombatItemAction,
  plantSeed,
  harvestPlot,
  craftItem,
  experimentAlchemy,
  craftKnownPotion,
  buyAnimal,
  collectAnimal,
  buildBuilding,
  collectBuilding,
  acceptQuest,
  turnInQuest,
  buyItem,
  sellItem,
  buyLocationReveal,
  allocateTraitPoint,
  unlockPerk,
  devGiveItem,
  devDiscoverLocation,
  devSetSkillXp,
  devResetPlayer,
};

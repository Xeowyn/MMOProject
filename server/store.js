const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Can be overridden so tests can use a scratch file instead of the real
// save data.
const DB_PATH = process.env.MMO_DB_PATH || path.join(__dirname, '..', 'data', 'db.json');

const XP_PER_LEVEL = 100; // cost of the very first level-up (level 1 -> 2)
const XP_LEVEL_INCREMENT = 15; // each subsequent level costs this much more than the last

// Combat distance is a 0-100 scale, not real pixels — the frontend maps it
// onto the arena circle. 0 means adjacent/melee range, MAX_DISTANCE is as
// far back as Quick Step can push things.
const MELEE_RANGE = 30;
const MAX_DISTANCE = 100;
const QUICK_STEP_RETREAT = 50;
const EVASION_DODGE_CHANCE = 0.6;

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
  swift_strikes: { name: 'Swift Strikes', description: '+8% attack speed (abilities cast faster).', tier: 1, requiresLevel: 1, cost: 1, effect: { type: 'attackSpeedMult', value: 0.08 } },
  lucky_strikes: { name: 'Lucky Strikes', description: '+5% critical hit chance.', tier: 1, requiresLevel: 1, cost: 1, effect: { type: 'critChance', value: 0.05 } },
  iron_skin: { name: 'Iron Skin', description: '+3 armor.', tier: 1, requiresLevel: 1, cost: 1, effect: { type: 'armorFlat', value: 3 } },
  vitality: { name: 'Vitality', description: '+15 max HP.', tier: 1, requiresLevel: 1, cost: 1, effect: { type: 'maxHpFlat', value: 15 } },
  green_thumb: { name: 'Green Thumb', description: '+15% plant growth speed.', tier: 1, requiresLevel: 1, cost: 1, effect: { type: 'plantGrowthMult', value: 0.15 } },
  prospector: { name: 'Prospector', description: '+10% mining speed.', tier: 2, requiresLevel: 5, cost: 1, effect: { type: 'miningSpeedMult', value: 0.1 } },
  woodsman: { name: 'Woodsman', description: '+10% woodcutting speed.', tier: 2, requiresLevel: 5, cost: 1, effect: { type: 'woodcuttingSpeedMult', value: 0.1 } },
  anglers_patience: { name: "Angler's Patience", description: '+10% fishing speed.', tier: 2, requiresLevel: 5, cost: 1, effect: { type: 'fishingSpeedMult', value: 0.1 } },
  treasure_hunter: { name: 'Treasure Hunter', description: '+10% success chance on Hunting/Scavenging/Harvesting.', tier: 2, requiresLevel: 5, cost: 1, effect: { type: 'gatherSuccessBonus', value: 0.1 } },
  brutal_force: { name: 'Brutal Force', description: '+15% melee damage (stacks with Brute Force).', tier: 3, requiresLevel: 10, cost: 1, effect: { type: 'meleeDamageMult', value: 0.15 } },
  adrenal_focus: { name: 'Adrenal Focus', description: '+12% attack speed (stacks with Swift Strikes).', tier: 3, requiresLevel: 10, cost: 1, effect: { type: 'attackSpeedMult', value: 0.12 } },
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
  // usePotion() during combat only (see potionEffect.kind)
  healing_potion: { name: 'Healing Potion', type: 'potion', potionEffect: { kind: 'heal', amount: 30 }, sellPrice: 18 },
  antidote: { name: 'Antidote', type: 'potion', potionEffect: { kind: 'cure' }, sellPrice: 18 },
  potion_of_strength: {
    name: 'Potion of Strength',
    type: 'potion',
    potionEffect: { kind: 'buff_damage', multiplier: 1.5, durationSeconds: 15 },
    sellPrice: 22,
  },
  potion_of_swiftness: {
    name: 'Potion of Swiftness',
    type: 'potion',
    potionEffect: { kind: 'buff_speed', multiplier: 0.6, durationSeconds: 15 },
    sellPrice: 22,
  },
  venom_draught: {
    name: 'Venom Draught',
    type: 'potion',
    potionEffect: { kind: 'poison_enemy', dps: 5, duration: 6 },
    sellPrice: 22,
  },
};

// Each enemy's stats are fixed, not based on gear like the player's are.
// goldReward/xpReward are [min, max] ranges rolled on a win.
// aiType controls what an enemy does each round (see enemyTakeTurn()):
// 'melee_aggressive' closes in and attacks every chance it gets.
// 'skirmisher' closes in, attacks, then backs off before attacking again.
// 'ranged_kiter' tries to stay at its preferredRange — backing off if the
// player gets close, closing in if they're too far, only attacking while
// in that range.
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
    range: MELEE_RANGE,
    approachSpeed: 45,
    aiType: 'melee_aggressive',
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
    range: MELEE_RANGE,
    approachSpeed: 55,
    aiType: 'melee_aggressive',
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
    range: MELEE_RANGE,
    approachSpeed: 20,
    aiType: 'melee_aggressive',
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
    range: MELEE_RANGE,
    approachSpeed: 40,
    aiType: 'melee_aggressive',
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
    range: MELEE_RANGE,
    approachSpeed: 60,
    aiType: 'melee_aggressive',
  },
  // tier 2 — the first ranged enemy: holds at range and shoots rather than
  // closing to melee, backing off if the player pushes in (Quick Step, or
  // just standing near it). Demonstrates the ranged_kiter archetype.
  forest_archer: {
    name: 'Forest Archer',
    maxHp: 26,
    damage: [3, 6],
    critChance: 0.1,
    attackSpeed: 1.6,
    effect: null,
    goldReward: [5, 10],
    xpReward: 10,
    lootTable: [{ item: 'archer_quiver', chance: 0.25 }],
    range: MAX_DISTANCE, // shots always reach once in its preferred band — see aiType logic, not a melee-style range gate
    approachSpeed: 20,
    aiType: 'ranged_kiter',
    preferredRange: 55,
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
    range: MELEE_RANGE,
    approachSpeed: 35,
    aiType: 'melee_aggressive',
  },
  marsh_wraith: {
    // tier 3 — a ghostly poisoner, favors a high crit chance over raw
    // damage. skirmisher: bites then phases back out instead of standing
    // and trading, matching its existing "hard to pin down" flavor.
    name: 'Marsh Wraith',
    maxHp: 45,
    damage: [4, 8],
    critChance: 0.15,
    attackSpeed: 2.2,
    effect: { type: 'poison', chance: 0.4, dps: 3, duration: 4 },
    goldReward: [10, 16],
    xpReward: 18,
    lootTable: [{ item: 'wraith_essence', chance: 0.25 }],
    range: MELEE_RANGE,
    approachSpeed: 25,
    aiType: 'skirmisher',
    retreatDistance: 35,
  },
  stone_troll: {
    // tier 4 — the toughest fight in the game right now, a real "boss" feel
    // for the far-flung locations. Slow to approach so Quick Step/kiting
    // matters more here than anywhere else.
    name: 'Stone Troll',
    maxHp: 90,
    damage: [8, 14],
    critChance: 0.05,
    attackSpeed: 2.8,
    effect: null,
    goldReward: [20, 35],
    xpReward: 35,
    lootTable: [{ item: 'troll_hide', chance: 0.3 }],
    range: MELEE_RANGE,
    approachSpeed: 15,
    aiType: 'melee_aggressive',
  },
};

// Where each enemy stands around the player when a fight starts, in
// degrees (0 = straight up), based on how many enemies are in the group.
// Spread out so enemies never overlap each other or the player.
const COMBAT_GROUP_ANGLES = {
  1: [0],
  2: [-38, 38],
  3: [-55, 0, 55],
};
const MAX_ENCOUNTER_GROUP_SIZE = 3;
// Enemies hover just outside this distance once fully closed in — keeps them
// visually distinct from the player dot at the arena center instead of
// stacking on top of it.
const MIN_ENEMY_DISTANCE = 12;

const PLANTS = {
  wheat: { name: 'Wheat', seed: 'wheat_seed', growSeconds: 60, yield: 'wheat_crop' },
  carrot: { name: 'Carrot', seed: 'carrot_seed', growSeconds: 90, yield: 'carrot_crop' },
  potato: { name: 'Potato', seed: 'potato_seed', growSeconds: 120, yield: 'potato_crop' },
};
const GARDEN_PLOT_COUNT = 24;

// Turns garden crops into supplies (which expeditions use up), so gardening
// and exploring feed into each other. Crops that take longer to grow
// convert into more supplies, to keep them roughly balanced.
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

// Combat plays out in rounds: each round the player either finishes
// charging their current ability or uses it, then every living enemy takes
// its turn. tickIntervalSeconds is just how fast rounds play out on screen
// (see COMBAT_SPEED_PRESETS) — it doesn't change how many rounds a fight
// takes, just the pacing. Saved per player so it carries between fights.
const COMBAT_SPEED_PRESETS = { slow: 2.2, normal: 1.1, fast: 0.4 };
const DEFAULT_COMBAT_SPEED = 'normal';

// Abilities go into 6 loadout slots and play out left to right, looping
// back to the start. unlockLevel gates each one behind the player's Combat
// skill level, so new abilities unlock naturally as you fight more.
const ABILITIES = {
  swing: {
    name: 'Swing',
    tags: ['melee'],
    castSeconds: 1.6,
    unlockLevel: 1,
    description: 'A basic attack with your equipped weapon (or bare fists).',
  },
  punch: {
    name: 'Punch',
    tags: ['melee'],
    castSeconds: 0.6,
    unlockLevel: 1,
    description: 'A fast, light jab. Primes your next melee ability with bonus damage.',
  },
  quick_step: {
    name: 'Quick Step',
    tags: ['utility'],
    castSeconds: 0.7,
    unlockLevel: 1,
    description: 'Step back from your enemy, gaining distance and a chance to dodge their next attack.',
  },
  guard_up: {
    name: 'Guard Up',
    tags: ['utility'],
    castSeconds: 0.9,
    unlockLevel: 2,
    description: 'Raise your guard, temporarily reducing incoming damage.',
  },
  throw_dagger: {
    name: 'Throw Dagger',
    tags: ['ranged'],
    castSeconds: 1.3,
    unlockLevel: 3,
    description: 'Hurl a dagger at your enemy. Lands at any distance.',
  },
  adrenaline_rush: {
    name: 'Adrenaline Rush',
    tags: ['utility'],
    castSeconds: 0.7,
    unlockLevel: 4,
    description: 'A burst of speed — your next ability executes faster.',
  },
  poison_jab: {
    name: 'Poison Jab',
    tags: ['melee'],
    castSeconds: 1.0,
    unlockLevel: 5,
    description: 'A quick jab coated in poison, dealing damage over time.',
  },
  second_wind: {
    name: 'Second Wind',
    tags: ['utility'],
    castSeconds: 2.0,
    unlockLevel: 6,
    description: 'Catch your breath and recover some health.',
  },
  power_strike: {
    name: 'Power Strike',
    tags: ['melee'],
    castSeconds: 2.6,
    unlockLevel: 7,
    description: 'A heavy, slow strike with your weapon for big damage.',
  },
};

const DEFAULT_ABILITY_LOADOUT = ['punch', 'swing', 'swing', 'quick_step', 'swing', 'swing'];

// How many combat rounds an ability occupies the player's turn for before it
// resolves — a direct reinterpretation of the old continuous-time
// castSeconds as a discrete tick count (Punch ~1 round, Power Strike ~3),
// preserving the original "heavier ability = enemies get more free turns
// while you commit to it" tradeoff inside the round-based engine. See
// resolvePlayerTurn().
function baseCastRounds(abilityId) {
  return Math.max(1, Math.round(ABILITIES[abilityId].castSeconds));
}

// Given to brand new players so the expedition mechanic is testable before
// a real supplies source (shop / garden) exists.
const STARTER_SUPPLIES = 8;

// Expedition tuning — all distances are in the same 0-100 percent-space the
// location x/y coordinates use, independent of canvas pixel size.
const UNIT_LENGTH_PER_SUPPLY = 3; // how far 1 supply lets you draw
const OVERLAP_THRESHOLD = 3.5; // how close the drawn path must pass to a location to discover it
const EXPEDITION_SPEED = 1.5; // percent-units of path covered per second — slow, deliberate travel, not a blip
const MIN_EXPEDITION_DURATION = 8; // seconds — even the shortest possible trip should take a real, watchable while

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

// Just flavor text and branching choices — an NPC's quest (if it has one)
// is shown separately in the client, not part of this tree.
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
    discoveries: [startLoc.id],
    inventory: { supplies: STARTER_SUPPLIES, gold: 20 },
    expedition: null,
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
    abilityLoadout: [...DEFAULT_ABILITY_LOADOUT],
    combatSpeed: DEFAULT_COMBAT_SPEED,
    traits: traits || { strength: TRAIT_BASE, dexterity: TRAIT_BASE, luck: TRAIT_BASE, vigor: TRAIT_BASE },
    characterXp: 0,
    traitPointsAvailable: 0,
    perkPoints: 0,
    perks: [],
  };
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
  // Combat 2.0 (ability-sequencer arena) changed the shape of an in-progress
  // fight (added loadout/distance/abilityCursor/etc). If someone had a fight
  // still open when that shipped, their save has the old shape and reading
  // it would crash. Just clear that one stale fight instead of trying to
  // convert it.
  if (player.combat && !Array.isArray(player.combat.loadout)) {
    player.combat = null;
    changed = true;
  }
  // Same fix, different rewrite: fights used to track one enemy, now they
  // track a list of enemies. Clear any fight still stuck on the old shape.
  if (player.combat && !Array.isArray(player.combat.enemies)) {
    player.combat = null;
    changed = true;
  }
  if (!player.combatSpeed || !COMBAT_SPEED_PRESETS[player.combatSpeed]) {
    player.combatSpeed = DEFAULT_COMBAT_SPEED;
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
  if (!player.abilityLoadout) {
    player.abilityLoadout = [...DEFAULT_ABILITY_LOADOUT];
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
  if (!validLocationIds.has(player.currentLocation)) {
    player.currentLocation = LOCATIONS.find((l) => l.startingLocation).id;
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

// Works out how many full cycles have passed on a chance-based node
// (hunting/scavenging/harvesting) and rolls each one separately, instead of
// always giving a guaranteed item like mining does. A hunting cycle can
// trigger an ambush fight, which stops the task right away. Cycles are
// capped per call so a player who was away a very long time can't cause a
// huge loop — any leftover cycles just carry over to the next tick.
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
      beginAmbushCombat(player, enemyId);
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
  if (player.expedition) return { error: 'busy_exploring' };

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

// Sets up a fight — used both when the player picks a fight (startCombat)
// and when a hunting task triggers a surprise ambush (beginAmbushCombat).
// The `ambush` flag just tells the client to show a different message.
// Copies the player's ability loadout into the fight at the start, since
// loadout can't be edited mid-fight. enemyIds is 1-3 enemies (see
// rollEncounterGroup); each gets its own fixed angle around the player so
// they never overlap.
function beginCombatInstance(player, enemyIds, ambush) {
  const now = Date.now();
  const maxHp = playerMaxHp(player);
  const angles = COMBAT_GROUP_ANGLES[enemyIds.length] || COMBAT_GROUP_ANGLES[1];
  const enemies = enemyIds.map((enemyId, i) => {
    const enemy = ENEMIES[enemyId];
    // MIN_ENEMY_DISTANCE, not 0 — a melee enemy starts "engaged" (already in
    // range to attack) but never literally on top of the player, or every
    // melee enemy in a group would collapse onto the same point regardless
    // of angle (distance 0 means every angle maps to the same coordinate).
    const startDistance = enemy.aiType === 'ranged_kiter' ? enemy.preferredRange : MIN_ENEMY_DISTANCE;
    return {
      uid: `e${i}`,
      enemyId,
      hp: enemy.maxHp,
      maxHp: enemy.maxHp,
      distance: startDistance,
      angle: angles[i],
      dot: null,
    };
  });
  player.combat = {
    enemies,
    playerHp: maxHp,
    playerMaxHp: maxHp,
    loadout: [...player.abilityLoadout],
    abilityCursor: -1,
    castRoundsRemaining: 0,
    dotOnPlayer: null,
    buff: null,
    armorBuff: null,
    pendingMeleeComboBuff: null,
    pendingHasteBuff: null,
    evasionUntil: 0,
    lastPlayerActionText: '',
    lastEnemyActionText: '',
    tickIntervalSeconds: COMBAT_SPEED_PRESETS[player.combatSpeed] || COMBAT_SPEED_PRESETS[DEFAULT_COMBAT_SPEED],
    nextTickAt: now + (COMBAT_SPEED_PRESETS[player.combatSpeed] || COMBAT_SPEED_PRESETS[DEFAULT_COMBAT_SPEED]) * 1000,
    round: 0,
    startedAt: now,
    result: null,
    rewardGold: 0,
    rewardLoot: [],
    ambush,
  };
  advanceCursor(player.combat);
}

// Single-enemy convenience wrapper — a hunting ambush is always one
// surprise attacker, not a coordinated group, so it doesn't go through
// rollEncounterGroup().
function beginAmbushCombat(player, enemyId) {
  beginCombatInstance(player, [enemyId], true);
}

// Most fights are solo; occasionally (see weights below) 1-2 companions join
// from the same location's enemy pool, picked independently so a group can
// repeat a type (e.g. two wolves) or mix types. chosenEnemyId is always
// included so the player's explicit pick from the enemy list is honored.
function rollEncounterGroup(loc, chosenEnemyId) {
  const pool = loc.combat;
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

// Closest point on segment a-b to point p, in the same 0-100 percent-space
// as location/path coordinates. Returns the distance and how far along the
// segment (0-1) that closest point falls.
function closestPointOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return { distance: Math.hypot(p.x - cx, p.y - cy), t };
}

// Distance from a location to the nearest point anywhere along a drawn path,
// plus the arc-length (distance traveled along the path) at that point —
// used both to decide whether the path "overlaps" the location and to know
// how far into the expedition the sweeping fill has to reach to reveal it.
function closestPointOnPath(loc, path) {
  let best = { distance: Infinity, arcLength: 0 };
  let cumulative = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const { distance, t } = closestPointOnSegment(loc, a, b);
    if (distance < best.distance) {
      best = { distance, arcLength: cumulative + t * segLen };
    }
    cumulative += segLen;
  }
  return best;
}

// Marks a location discovered and grants character xp for it, in one place
// so every way of discovering a location (expedition, paid reveal) works
// the same. Returns true if it was actually new.
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

// Character-level xp is separate from every skill's own xp, but uses the
// same level curve. One grant can cross more than one level at once (e.g.
// several locations discovered in the same expedition tick).
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

// Moves an expedition's progress forward based on real time passed, and
// reveals any location the progress has reached along the way.
function tickExpedition(player) {
  const exp = player.expedition;
  if (!exp) return;
  const elapsedSeconds = (Date.now() - exp.startedAt) / 1000;
  const fraction = Math.min(1, elapsedSeconds / exp.durationSeconds);
  for (const trigger of exp.triggers) {
    if (fraction >= trigger.fraction) {
      discoverLocation(player, trigger.locationId);
    }
  }
  if (fraction >= 1) {
    player.expedition = null;
  }
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
    attackSpeedMult: 0,
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
    // dexterity: -2% ability cast time per point above TRAIT_BASE, floor at 50% of base cast time
    castSpeedMult: Math.max(0.5, 1 - (t.dexterity - TRAIT_BASE) * 0.02 - perkMods.attackSpeedMult),
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

// Combat runs in rounds, moving forward based on real time passed, the same
// way skill tasks and expeditions do. A potion buff (Strength/Swiftness) is
// checked against the real clock here rather than counted down, so it
// expires correctly even if the player comes back to a stale tab.
function getActiveCombatBuff(c) {
  if (!c.buff) return null;
  if (Date.now() >= c.buff.expiresAt) {
    c.buff = null;
    return null;
  }
  return c.buff;
}

// Same idea as getActiveCombatBuff(), for Guard Up's temporary armor bonus.
function getActiveArmorBuff(c) {
  if (!c.armorBuff) return null;
  if (Date.now() >= c.armorBuff.expiresAt) {
    c.armorBuff = null;
    return null;
  }
  return c.armorBuff;
}

// Moves to the next filled loadout slot, wrapping back to slot 0 after slot
// 5 — this is what makes abilities play out left to right, on a loop.
function advanceCursor(c) {
  for (let i = 1; i <= 6; i++) {
    const idx = (c.abilityCursor + i) % 6;
    if (c.loadout[idx]) {
      c.abilityCursor = idx;
      return;
    }
  }
  // No abilities in the loadout at all — leave the cursor where it is.
}

// The nearest living enemy — there's no manual targeting yet, so every
// attack just goes for whoever is closest.
function pickTarget(c) {
  let best = null;
  for (const e of c.enemies) {
    if (e.hp <= 0) continue;
    if (!best || e.distance < best.distance) best = e;
  }
  return best;
}

function livingEnemies(c) {
  return c.enemies.filter((e) => e.hp > 0);
}

// Plays out the player's turn for one round: either keep charging the
// ability under the cursor (a heavy ability like Power Strike takes more
// rounds to charge than a fast one like Punch — that's the tradeoff for its
// bigger hit), or once fully charged, apply its effect and move to the next
// loadout slot. A melee ability only lands if the target is close enough —
// otherwise it still uses up the charge but does nothing.
function resolvePlayerTurn(player, c, equip, now) {
  const abilityId = c.loadout[c.abilityCursor];
  if (!abilityId) return; // empty loadout slot under the cursor — nothing to do this round

  if (c.castRoundsRemaining > 0) {
    c.castRoundsRemaining -= 1;
    c.lastPlayerActionText = `Charging ${ABILITIES[abilityId].name}...`;
    return;
  }

  const ability = ABILITIES[abilityId];
  const isMelee = ability.tags.includes('melee');
  const target = pickTarget(c);
  const inRange = !!target && target.distance <= MELEE_RANGE;
  let comboMultiplier = 1;
  if (isMelee && c.pendingMeleeComboBuff) {
    comboMultiplier = c.pendingMeleeComboBuff.multiplier;
    c.pendingMeleeComboBuff = null;
  }
  const potionBuff = getActiveCombatBuff(c);
  const potionDmgMultiplier = potionBuff && potionBuff.type === 'damage' ? potionBuff.multiplier : 1;
  // strength + Brute Force/Brutal Force perks only apply to melee-tagged abilities
  const strMultiplier = isMelee ? getPlayerModifiers(player).meleeDamageMult : 1;
  const totalMultiplier = comboMultiplier * potionDmgMultiplier * strMultiplier;

  if (abilityId === 'swing') {
    if (target && inRange) {
      let dmg = Math.round(randInt(equip.damage[0], equip.damage[1]) * totalMultiplier);
      if (Math.random() < equip.critChance) dmg *= 2;
      target.hp = Math.max(0, target.hp - dmg);
      c.lastPlayerActionText = `Swing hits ${ENEMIES[target.enemyId].name} for ${dmg}`;
      if (equip.effect && Math.random() < equip.effect.chance) {
        target.dot = { type: equip.effect.type, dps: equip.effect.dps, roundsLeft: equip.effect.duration };
      }
    } else {
      c.lastPlayerActionText = 'Swing misses — too far away!';
    }
  } else if (abilityId === 'punch') {
    if (target && inRange) {
      const dmg = Math.round(randInt(2, 4) * totalMultiplier);
      target.hp = Math.max(0, target.hp - dmg);
      c.pendingMeleeComboBuff = { multiplier: 1.5 };
      c.lastPlayerActionText = `Punch hits ${ENEMIES[target.enemyId].name} for ${dmg} — next melee ability is primed`;
    } else {
      c.lastPlayerActionText = 'Punch misses — too far away!';
    }
  } else if (abilityId === 'power_strike') {
    if (target && inRange) {
      let dmg = Math.round(randInt(equip.damage[0], equip.damage[1]) * 1.8 * totalMultiplier);
      if (Math.random() < equip.critChance) dmg *= 2;
      target.hp = Math.max(0, target.hp - dmg);
      c.lastPlayerActionText = `Power Strike hits ${ENEMIES[target.enemyId].name} for ${dmg}!`;
    } else {
      c.lastPlayerActionText = 'Power Strike misses — too far away!';
    }
  } else if (abilityId === 'poison_jab') {
    if (target && inRange) {
      const dmg = Math.round(randInt(1, 3) * totalMultiplier);
      target.hp = Math.max(0, target.hp - dmg);
      target.dot = { type: 'poison', dps: 3, roundsLeft: 4 };
      c.lastPlayerActionText = `Poison Jab hits ${ENEMIES[target.enemyId].name} for ${dmg} and poisons it`;
    } else {
      c.lastPlayerActionText = 'Poison Jab misses — too far away!';
    }
  } else if (abilityId === 'throw_dagger') {
    if (target) {
      let dmg = Math.round(randInt(3, 6) * potionDmgMultiplier);
      if (Math.random() < 0.05) dmg *= 2;
      target.hp = Math.max(0, target.hp - dmg);
      c.lastPlayerActionText = `Throw Dagger hits ${ENEMIES[target.enemyId].name} for ${dmg}`;
    }
  } else if (abilityId === 'quick_step') {
    for (const e of livingEnemies(c)) e.distance = Math.min(MAX_DISTANCE, e.distance + QUICK_STEP_RETREAT);
    c.evasionUntil = now + 1200;
    c.lastPlayerActionText = 'Quick Step — you put distance between yourself and every enemy';
  } else if (abilityId === 'guard_up') {
    c.armorBuff = { amount: 5, expiresAt: now + 4000 };
    c.lastPlayerActionText = 'Guard Up — your defense is bolstered';
  } else if (abilityId === 'second_wind') {
    c.playerHp = Math.min(c.playerMaxHp, c.playerHp + 15);
    c.lastPlayerActionText = 'Second Wind — you recover some health';
  } else if (abilityId === 'adrenaline_rush') {
    c.pendingHasteBuff = { multiplier: 0.5 };
    c.lastPlayerActionText = 'Adrenaline Rush — your next ability will be faster';
  }

  advanceCursor(c);
  const nextAbilityId = c.loadout[c.abilityCursor];
  let rounds = nextAbilityId ? baseCastRounds(nextAbilityId) : 1;
  if (c.pendingHasteBuff) {
    rounds *= c.pendingHasteBuff.multiplier;
    c.pendingHasteBuff = null;
  }
  const speedBuff = getActiveCombatBuff(c);
  if (speedBuff && speedBuff.type === 'speed') rounds *= speedBuff.multiplier;
  rounds *= getPlayerModifiers(player).castSpeedMult; // dexterity + Swift Strikes/Adrenal Focus perks
  c.castRoundsRemaining = Math.max(0, Math.round(rounds) - 1);
}

// One enemy's attack on the player — used by every enemy type once it's
// decided to attack instead of moving. Quick Step's evasion window gives a
// real chance to dodge completely; dexterity's dodge chance also always
// applies on top of that.
function resolveEnemyAttackOn(player, c, target, equip, now) {
  const enemy = ENEMIES[target.enemyId];
  if (c.evasionUntil && now < c.evasionUntil && Math.random() < EVASION_DODGE_CHANCE) {
    c.lastEnemyActionText = `${enemy.name} attacks — dodged!`;
    return;
  }
  if (Math.random() < getPlayerModifiers(player).dodgeChance) {
    c.lastEnemyActionText = `${enemy.name} attacks — you dodge!`;
    return;
  }
  let dmg = randInt(enemy.damage[0], enemy.damage[1]);
  if (Math.random() < enemy.critChance) dmg *= 2;
  const armorBuff = getActiveArmorBuff(c);
  const totalArmor = equip.armor + (armorBuff ? armorBuff.amount : 0);
  dmg = Math.max(1, dmg - totalArmor);
  c.playerHp = Math.max(0, c.playerHp - dmg);
  c.lastEnemyActionText = `${enemy.name} hits you for ${dmg}`;
  if (enemy.effect && Math.random() < enemy.effect.chance) {
    c.dotOnPlayer = { type: enemy.effect.type, dps: enemy.effect.dps, roundsLeft: enemy.effect.duration };
  }
}

// One living enemy's full action for the round — move or attack, chosen by
// its aiType (see the ENEMIES comment above for what each archetype does).
function enemyTakeTurn(player, c, target, equip, now) {
  const enemy = ENEMIES[target.enemyId];
  const ai = enemy.aiType || 'melee_aggressive';

  if (ai === 'ranged_kiter') {
    const pref = enemy.preferredRange;
    if (target.distance < pref - 12) {
      target.distance = Math.min(MAX_DISTANCE, target.distance + enemy.approachSpeed);
      c.lastEnemyActionText = `${enemy.name} backs away`;
    } else if (target.distance > pref + 12) {
      target.distance = Math.max(MIN_ENEMY_DISTANCE, target.distance - enemy.approachSpeed);
      c.lastEnemyActionText = `${enemy.name} closes in`;
    } else {
      resolveEnemyAttackOn(player, c, target, equip, now);
    }
    return;
  }

  if (ai === 'skirmisher') {
    if (target.distance > enemy.range) {
      target.distance = Math.max(MIN_ENEMY_DISTANCE, target.distance - enemy.approachSpeed);
      c.lastEnemyActionText = `${enemy.name} closes in`;
    } else {
      resolveEnemyAttackOn(player, c, target, equip, now);
      target.distance = Math.min(MAX_DISTANCE, target.distance + (enemy.retreatDistance || 30));
    }
    return;
  }

  // melee_aggressive (default): close the distance, attack every turn it's in range
  if (target.distance > enemy.range) {
    target.distance = Math.max(MIN_ENEMY_DISTANCE, target.distance - enemy.approachSpeed);
    c.lastEnemyActionText = `${enemy.name} closes in`;
  } else {
    resolveEnemyAttackOn(player, c, target, equip, now);
  }
}

// One full combat round: the player acts once, then every living enemy
// acts, then poison/DOT damage applies. DOT damage is per-round, not
// per-second, so a faster combat speed just makes it play out quicker
// on-screen without actually hitting harder.
function resolveRound(player, c, equip, now) {
  resolvePlayerTurn(player, c, equip, now);

  for (const e of c.enemies) {
    if (e.hp <= 0 || c.playerHp <= 0) continue;
    enemyTakeTurn(player, c, e, equip, now);
  }

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

  c.round += 1;
}

// All enemies dead -> win (rewards summed across every enemy in the group);
// player dead -> loss. Called after every resolved round.
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
    player.inventory.gold = (player.inventory.gold || 0) + totalGold;
    c.rewardGold = totalGold;
    player.combatRecord.wins += 1;
  } else if (c.playerHp <= 0) {
    c.result = 'loss';
    player.combatRecord.losses += 1;
  }
}

// Plays out however many rounds should have happened since the last check,
// based on real time passed — same idea as the gathering skills. Capped per
// call so a player who was away a long time doesn't cause a huge loop; any
// leftover rounds just play out on the next call.
const COMBAT_ROUND_CAP = 500;

function tickCombat(player) {
  const c = player.combat;
  if (!c || c.result) return;
  const equip = getEquippedStats(player);
  const now = Date.now();

  let rounds = 0;
  while (rounds < COMBAT_ROUND_CAP && !c.result && c.nextTickAt <= now) {
    const roundNow = c.nextTickAt;
    resolveRound(player, c, equip, roundNow);
    checkCombatEnd(player, c);
    c.nextTickAt = roundNow + c.tickIntervalSeconds * 1000;
    rounds++;
  }
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
  tickExpedition(player);
  tickCombat(player);
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
  let expedition = null;
  if (player.expedition) {
    const elapsedSeconds = (Date.now() - player.expedition.startedAt) / 1000;
    expedition = {
      path: player.expedition.path,
      totalLength: player.expedition.totalLength,
      durationSeconds: player.expedition.durationSeconds,
      startedAt: player.expedition.startedAt,
      fraction: Math.min(1, elapsedSeconds / player.expedition.durationSeconds),
    };
  }

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
    const armorBuffActive = getActiveArmorBuff(c);
    combat = {
      enemies: c.enemies.map((e) => {
        const enemy = ENEMIES[e.enemyId];
        return {
          uid: e.uid,
          enemyId: e.enemyId,
          name: enemy.name,
          hp: e.hp,
          maxHp: e.maxHp,
          distance: e.distance,
          angle: e.angle,
          alive: e.hp > 0,
          dot: e.dot ? { type: e.dot.type } : null,
        };
      }),
      playerHp: c.playerHp,
      playerMaxHp: c.playerMaxHp,
      maxDistance: MAX_DISTANCE,
      meleeRange: MELEE_RANGE,
      loadout: c.loadout.map((id) => (id ? { id, name: ABILITIES[id].name } : null)),
      abilityCursor: c.abilityCursor,
      castRoundsRemaining: c.castRoundsRemaining,
      tickIntervalSeconds: c.tickIntervalSeconds,
      nextTickAt: c.nextTickAt,
      round: c.round,
      result: c.result,
      rewardGold: c.rewardGold || 0,
      rewardLoot: (c.rewardLoot || []).map((itemId) => ({ id: itemId, name: ITEMS[itemId].name })),
      dotOnPlayer: c.dotOnPlayer ? { type: c.dotOnPlayer.type } : null,
      buff: activeBuff ? { type: activeBuff.type } : null,
      armorBuffActive: !!armorBuffActive,
      comboReady: !!c.pendingMeleeComboBuff,
      hasteReady: !!c.pendingHasteBuff,
      evasionActive: Date.now() < (c.evasionUntil || 0),
      lastPlayerActionText: c.lastPlayerActionText || '',
      lastEnemyActionText: c.lastEnemyActionText || '',
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
    expedition,
    maxExplorationRange: (player.inventory.supplies || 0) * UNIT_LENGTH_PER_SUPPLY,
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
    abilityLoadout: player.abilityLoadout,
    combatSpeed: player.combatSpeed,
    abilities: Object.entries(ABILITIES).map(([id, a]) => ({
      id,
      name: a.name,
      description: a.description,
      tags: a.tags,
      castRounds: baseCastRounds(id), // rounds this ability occupies the player's turn for once queued — see resolvePlayerTurn()
      unlockLevel: a.unlockLevel,
      unlocked: a.unlockLevel <= levelFromXp(player.skills.combat.xp),
    })),
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

// path: [{x, y}, ...] in percent-space, drawn by the player starting at
// their current location. Supplies cap how far it's allowed to reach and
// are spent proportionally to the length actually drawn (not the max).
function startExpedition(playerId, path) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (player.expedition) return { error: 'expedition_in_progress' };
  if (player.combat && !player.combat.result) return { error: 'busy_fighting' };
  if (!Array.isArray(path) || path.length < 2) return { error: 'invalid_path' };

  const supplies = player.inventory.supplies || 0;
  if (supplies <= 0) return { error: 'no_supplies' };

  let totalLength = 0;
  for (let i = 1; i < path.length; i++) {
    totalLength += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  if (totalLength <= 0) return { error: 'invalid_path' };

  const maxLength = supplies * UNIT_LENGTH_PER_SUPPLY;
  if (totalLength > maxLength + 0.01) return { error: 'path_too_long' };

  const suppliesCost = Math.min(supplies, Math.max(1, Math.ceil(totalLength / UNIT_LENGTH_PER_SUPPLY)));
  player.inventory.supplies = supplies - suppliesCost;

  const triggers = [];
  for (const loc of LOCATIONS) {
    if (player.discoveries.includes(loc.id)) continue;
    const { distance, arcLength } = closestPointOnPath(loc, path);
    if (distance <= OVERLAP_THRESHOLD) {
      triggers.push({ locationId: loc.id, fraction: arcLength / totalLength });
    }
  }
  triggers.sort((a, b) => a.fraction - b.fraction);

  stopAllSkillTasks(player); // only one task at a time — starting an expedition stops any active skill

  const durationSeconds = Math.max(MIN_EXPEDITION_DURATION, totalLength / EXPEDITION_SPEED);
  player.expedition = {
    path,
    totalLength,
    durationSeconds,
    startedAt: Date.now(),
    triggers,
  };
  save();
  return {
    ok: true,
    durationSeconds,
    totalLength,
    suppliesCost,
    suppliesRemaining: player.inventory.supplies,
    locationsFound: triggers.length,
  };
}

function travel(playerId, locationId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (!player.discoveries.includes(locationId)) return { error: 'not_discovered' };
  player.currentLocation = locationId;
  save();
  return { currentLocation: locationId };
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
  if (player.expedition) return { error: 'busy_exploring' };
  const loc = getLocation(player.currentLocation);
  if (!loc || !loc.combat || !loc.combat.includes(enemyId)) return { error: 'enemy_not_here' };
  const enemy = ENEMIES[enemyId];
  if (!enemy) return { error: 'unknown_enemy' };
  if (!player.abilityLoadout.some(Boolean)) return { error: 'no_abilities_equipped' };

  stopAllSkillTasks(player); // only one task at a time — starting a fight stops any active skill
  const group = rollEncounterGroup(loc, enemyId);
  beginCombatInstance(player, group, false);
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

// Saved as a preference for future fights, and also applies right away if a
// fight is already happening.
function setCombatSpeed(playerId, speed) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (!COMBAT_SPEED_PRESETS[speed]) return { error: 'invalid_speed' };
  player.combatSpeed = speed;
  if (player.combat && !player.combat.result) {
    player.combat.tickIntervalSeconds = COMBAT_SPEED_PRESETS[speed];
    player.combat.nextTickAt = Date.now() + COMBAT_SPEED_PRESETS[speed] * 1000;
  }
  save();
  return { ok: true };
}

function unlockedAbilityIds(player) {
  const level = levelFromXp(player.skills.combat.xp);
  return Object.entries(ABILITIES)
    .filter(([, a]) => a.unlockLevel <= level)
    .map(([id]) => id);
}

// You can't edit your loadout mid-fight — the fight already has its own
// copy of it from when it started, so an edit here wouldn't affect the
// current fight anyway.
function setLoadoutSlot(playerId, slotIndex, abilityId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  if (player.combat && !player.combat.result) return { error: 'combat_in_progress' };
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 6) return { error: 'invalid_slot' };
  if (abilityId !== null) {
    if (!ABILITIES[abilityId]) return { error: 'unknown_ability' };
    if (!unlockedAbilityIds(player).includes(abilityId)) return { error: 'not_unlocked' };
  }
  player.abilityLoadout[slotIndex] = abilityId;
  save();
  return { ok: true, loadout: player.abilityLoadout };
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
  if (plotIndex < 0 || plotIndex >= player.garden.plots.length) return { error: 'invalid_plot' };
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
function usePotion(playerId, itemId) {
  const player = getPlayer(playerId);
  if (!player) return { error: 'not_found' };
  const item = ITEMS[itemId];
  if (!item || item.type !== 'potion') return { error: 'not_a_potion' };
  if ((player.inventory[itemId] || 0) < 1) return { error: 'not_owned' };
  if (!player.combat || player.combat.result) return { error: 'not_in_combat' };

  tickCombat(player); // resolve anything pending up to now before the potion lands
  const c = player.combat;
  if (!c || c.result) return { error: 'not_in_combat' };

  const effect = item.potionEffect;
  if (effect.kind === 'heal') {
    c.playerHp = Math.min(c.playerMaxHp, c.playerHp + effect.amount);
  } else if (effect.kind === 'cure') {
    if (!c.dotOnPlayer) return { error: 'nothing_to_cure' };
    c.dotOnPlayer = null;
  } else if (effect.kind === 'buff_damage') {
    c.buff = { type: 'damage', multiplier: effect.multiplier, expiresAt: Date.now() + effect.durationSeconds * 1000 };
  } else if (effect.kind === 'buff_speed') {
    c.buff = { type: 'speed', multiplier: effect.multiplier, expiresAt: Date.now() + effect.durationSeconds * 1000 };
  } else if (effect.kind === 'poison_enemy') {
    const target = pickTarget(c);
    if (!target) return { error: 'no_target' };
    target.dot = { type: 'venom', dps: effect.dps, roundsLeft: effect.duration };
  }

  spendItem(player, itemId, 1);
  save();
  return { ok: true, effect: effect.kind };
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
  discoverLocation(player, found.id); // grants character xp same as a free expedition find
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
  player.discoveries = [startLoc.id];
  player.inventory = { supplies: STARTER_SUPPLIES, gold: 20 };
  player.expedition = null;
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
  player.abilityLoadout = [...DEFAULT_ABILITY_LOADOUT];
  // Deliberately NOT reset: traits/characterXp/traitPointsAvailable/
  // perkPoints/perks. Those represent the chosen character build, not
  // explore/economy state — dev.reset() is for repeat-testing exploration
  // and the economy, not relitigating a character's build.

  save();
  return { ok: true };
}

module.exports = {
  LOCATIONS,
  ITEMS,
  ENEMIES,
  ABILITIES,
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
  startExpedition,
  travel,
  stopTask,
  attemptFishingCatch,
  startResourceTask,
  equipItem,
  unequipItem,
  startCombat,
  endCombat,
  setCombatSpeed,
  setLoadoutSlot,
  plantSeed,
  harvestPlot,
  craftItem,
  experimentAlchemy,
  craftKnownPotion,
  usePotion,
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

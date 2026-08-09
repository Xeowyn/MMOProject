'use strict';

// Unit tests for server/store.js — the game-data logic and save-file store.
//
// SAFETY: these tests must never touch the real save file (data/db.json),
// since that's the live save friends actually play on. We point MMO_DB_PATH
// at a scratch file in the OS temp folder before store.js is ever required
// (store.js reads that env var once, at module load time).

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const DB_PATH = path.join(os.tmpdir(), `mmo-test-store-${process.pid}-${Date.now()}.json`);
process.env.MMO_DB_PATH = DB_PATH;

const store = require('../server/store');

after(async () => {
  // store.js debounces writes by up to a second (see SAVE_DEBOUNCE_MS in
  // store.js) — wait for that to flush before deleting the scratch file, or
  // it just gets quietly recreated a moment later.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  fs.rmSync(DB_PATH, { force: true });
});

let counter = 0;
// Every test needs its own player, since accounts share one in-memory store
// for the whole test file. traits must add up to exactly TRAIT_EXTRA_POINTS
// on top of TRAIT_BASE for each of the 4 traits.
function makeCharacter(traits) {
  counter += 1;
  const username = `tester_${process.pid}_${counter}`;
  const result = store.createCharacter(username, traits, 'testpass123');
  assert.equal(result.error, undefined, `character creation failed: ${JSON.stringify(result)}`);
  return { id: result.player.id, token: result.token, username };
}

const EVEN_TRAITS = { strength: 8, dexterity: 8, luck: 6, vigor: 8 }; // +10 spread evenly-ish
const NO_DODGE_TRAITS = { strength: 10, dexterity: 5, luck: 10, vigor: 5 }; // dexterity stays at TRAIT_BASE -> 0 dodge chance

describe('xp / level curve', () => {
  test('level 1 at 0 xp', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);
    player.characterXp = 0;
    const pub = store.publicPlayer(player);
    assert.equal(pub.character.level, 1);
    assert.equal(pub.character.xpIntoLevel, 0);
    assert.equal(pub.character.xpToNextLevel, 100); // XP_PER_LEVEL
  });

  test('crosses to level 2 exactly at the level-1 cost', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);
    player.characterXp = 99;
    assert.equal(store.publicPlayer(player).character.level, 1);
    player.characterXp = 100;
    assert.equal(store.publicPlayer(player).character.level, 2);
  });

  test('each level costs more than the last', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);
    player.characterXp = 100; // level 2 start
    const atLevel2 = store.publicPlayer(player);
    assert.equal(atLevel2.character.xpToNextLevel, 115); // 100 + 15 increment
  });

  test('a big xp grant can cross multiple levels at once', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);
    player.characterXp = 100 + 115 + 130; // enough for level 1 -> 4
    const pub = store.publicPlayer(player);
    assert.equal(pub.character.level, 4);
  });
});

describe('item and shop lookups', () => {
  test('every SHOP_ITEMS entry points at a real item', () => {
    for (const entry of store.SHOP_ITEMS) {
      assert.ok(store.ITEMS[entry.id], `missing ITEMS entry for shop item ${entry.id}`);
      assert.ok(entry.price > 0);
    }
  });

  test('every sellable item has a positive sellPrice, gold does not', () => {
    assert.equal(store.ITEMS.gold.sellPrice, undefined);
    for (const [id, item] of Object.entries(store.ITEMS)) {
      if (id === 'gold') continue;
      if (item.sellPrice !== undefined) assert.ok(item.sellPrice > 0, `${id} has a non-positive sellPrice`);
    }
  });

  test('buyItem fails for an item not in the shop', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.buyItem(id, 'iron_ore');
    assert.equal(result.error, 'not_for_sale');
  });

  test('buyItem fails without enough gold, succeeds and deducts gold once affordable', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);
    player.inventory.gold = 3;
    let result = store.buyItem(id, 'wheat_seed'); // price 5
    assert.equal(result.error, 'not_enough_gold');

    player.inventory.gold = 10;
    result = store.buyItem(id, 'wheat_seed');
    assert.equal(result.error, undefined);
    assert.equal(result.goldRemaining, 5);
  });

  test('sellItem pays sellPrice * amount and removes the stack at zero', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'wood', 3);
    const before = store.getPlayer(id).inventory.gold;
    const result = store.sellItem(id, 'wood', 3);
    assert.equal(result.error, undefined);
    assert.equal(result.goldEarned, store.ITEMS.wood.sellPrice * 3);
    const player = store.getPlayer(id);
    assert.equal(player.inventory.gold, before + store.ITEMS.wood.sellPrice * 3);
    assert.equal(player.inventory.wood, undefined); // stack removed, not left at 0
  });

  test('sellItem fails for an item with no sellPrice (gold itself)', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.sellItem(id, 'gold', 1);
    assert.equal(result.error, 'not_sellable');
  });

  test('sellItem fails when the player owns fewer than the requested amount', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'wood', 1);
    const result = store.sellItem(id, 'wood', 5);
    assert.equal(result.error, 'not_enough_owned');
  });

  test('sellItem treats a zero/negative amount as 1, not as "sell nothing"', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'wood', 2);
    const result = store.sellItem(id, 'wood', 0);
    assert.equal(result.error, undefined);
    assert.equal(result.amount, 1);
  });
});

describe('crafting', () => {
  test('every recipe consumes its exact ingredients and produces resultAmount', () => {
    const recipe = store.RECIPES.find((r) => r.id === 'wheat_supplies');
    const { id } = makeCharacter(EVEN_TRAITS);
    const suppliesBefore = store.getPlayer(id).inventory.supplies || 0;
    store.devGiveItem(id, 'wheat_crop', 2);
    const result = store.craftItem(id, recipe.id);
    assert.equal(result.error, undefined);
    assert.equal(result.resultAmount, recipe.resultAmount);
    const player = store.getPlayer(id);
    assert.equal(player.inventory.wheat_crop, undefined);
    assert.equal(player.inventory.supplies, suppliesBefore + recipe.resultAmount);
  });

  test('craftItem fails with missing_ingredients and consumes nothing', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const before = store.getPlayer(id).inventory.supplies || 0;
    const result = store.craftItem(id, 'wheat_supplies');
    assert.equal(result.error, 'missing_ingredients');
    assert.equal(store.getPlayer(id).inventory.supplies || 0, before);
  });

  test('craftItem fails for an unknown recipe id', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.craftItem(id, 'not_a_real_recipe');
    assert.equal(result.error, 'unknown_recipe');
  });

  test('partial ingredients still fail (needs all, not any)', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'wheat_crop', 1); // recipe needs 2
    const result = store.craftItem(id, 'wheat_supplies');
    assert.equal(result.error, 'missing_ingredients');
  });
});

describe('quests', () => {
  test('gather quest: turn-in fails until the item count is met, then consumes it and pays reward', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const accept = store.acceptQuest(id, 'timber_delivery'); // needs 10 wood
    assert.equal(accept.error, undefined);

    let result = store.turnInQuest(id, 'timber_delivery');
    assert.equal(result.error, 'objective_not_met');

    store.devGiveItem(id, 'wood', 10);
    const goldBefore = store.getPlayer(id).inventory.gold || 0;
    result = store.turnInQuest(id, 'timber_delivery');
    assert.equal(result.error, undefined);
    const player = store.getPlayer(id);
    assert.equal(player.inventory.wood, undefined);
    assert.equal(player.inventory.gold, goldBefore + store.QUESTS.timber_delivery.reward.gold);
    assert.ok(player.quests.completed.includes('timber_delivery'));
  });

  test('kill quest: satisfied instantly if the kill already happened before accepting', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);
    player.killCounts.giant_rat = 1;
    store.acceptQuest(id, 'first_hunt');
    const result = store.turnInQuest(id, 'first_hunt');
    assert.equal(result.error, undefined);
  });

  test('visit quest: satisfied once the location is discovered', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.acceptQuest(id, 'scout_the_mine'); // visit ironbrook_mine
    let result = store.turnInQuest(id, 'scout_the_mine');
    assert.equal(result.error, 'objective_not_met');

    store.devDiscoverLocation(id, 'ironbrook_mine');
    result = store.turnInQuest(id, 'scout_the_mine');
    assert.equal(result.error, undefined);
  });

  test('cannot accept the same quest twice, or turn in an unaccepted quest', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.acceptQuest(id, 'first_hunt');
    const secondAccept = store.acceptQuest(id, 'first_hunt');
    assert.equal(secondAccept.error, 'already_started');

    const turnInWithoutAccepting = store.turnInQuest(id, 'timber_delivery');
    assert.equal(turnInWithoutAccepting.error, 'not_started');
  });

  test('unknown quest id is rejected on accept and turn-in', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    assert.equal(store.acceptQuest(id, 'no_such_quest').error, 'unknown_quest');
    assert.equal(store.turnInQuest(id, 'no_such_quest').error, 'unknown_quest');
  });
});

describe('equipment', () => {
  test('cannot equip an item you do not own', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.equipItem(id, 'rusty_sword');
    assert.equal(result.error, 'not_owned');
  });

  test('cannot equip a non-equippable item', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'wood', 1);
    const result = store.equipItem(id, 'wood');
    assert.equal(result.error, 'not_equippable');
  });

  test('equipping a second weapon swaps it and returns the old one to inventory', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'rusty_sword', 1);
    store.devGiveItem(id, 'hunting_bow', 1);
    store.equipItem(id, 'rusty_sword');
    const result = store.equipItem(id, 'hunting_bow');
    assert.equal(result.error, undefined);
    const player = store.getPlayer(id);
    assert.equal(player.equipment.weapon, 'hunting_bow');
    assert.equal(player.inventory.rusty_sword, 1); // swapped back into inventory
    assert.equal(player.inventory.hunting_bow, undefined); // worn, not in inventory
  });

  test('unequip returns the item and clears the slot; unequipping empty slot fails', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'leather_vest', 1);
    store.equipItem(id, 'leather_vest');
    const result = store.unequipItem(id, 'armor');
    assert.equal(result.error, undefined);
    const player = store.getPlayer(id);
    assert.equal(player.equipment.armor, null);
    assert.equal(player.inventory.leather_vest, 1);

    const secondUnequip = store.unequipItem(id, 'armor');
    assert.equal(secondUnequip.error, 'nothing_equipped');
  });

  test('unequip rejects an invalid slot name', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.unequipItem(id, 'helmet');
    assert.equal(result.error, 'invalid_slot');
  });
});

describe('gardening', () => {
  test('cannot plant without owning the seed, and cannot double-plant a plot', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    let result = store.plantSeed(id, 0, 'wheat');
    assert.equal(result.error, 'no_seed');

    store.devGiveItem(id, 'wheat_seed', 2);
    result = store.plantSeed(id, 0, 'wheat');
    assert.equal(result.error, undefined);

    result = store.plantSeed(id, 0, 'wheat');
    assert.equal(result.error, 'plot_occupied');
  });

  test('cannot harvest before the grow time has passed, can harvest right after', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'wheat_seed', 1);
    store.plantSeed(id, 1, 'wheat');

    let result = store.harvestPlot(id, 1);
    assert.equal(result.error, 'not_ready');

    const player = store.getPlayer(id);
    player.garden.plots[1].plantedAt = Date.now() - store.PLANTS.wheat.growSeconds * 1000 - 1000;
    result = store.harvestPlot(id, 1);
    assert.equal(result.error, undefined);
    assert.equal(result.yield, 'wheat_crop');
    assert.equal(store.getPlayer(id).garden.plots[1], null);
  });

  test('harvesting an empty plot fails', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.harvestPlot(id, 5);
    assert.equal(result.error, 'plot_empty');
  });

  test('planting an out-of-range plot index fails', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'wheat_seed', 1);
    const result = store.plantSeed(id, 999, 'wheat');
    assert.equal(result.error, 'invalid_plot');
  });

  // Regression test: a non-numeric plotIndex (e.g. a string from a hostile
  // request) used to fail the range check silently (NaN < 0 and NaN >= length
  // are both false) and plant into a bogus, unreachable plot — wasting the
  // seed with nothing to show for it. Fixed by requiring an integer index.
  test('planting with a non-numeric plot index is rejected and does not consume the seed', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'wheat_seed', 1);
    const result = store.plantSeed(id, 'not-a-number', 'wheat');
    assert.equal(result.error, 'invalid_plot');
    assert.equal(store.getPlayer(id).inventory.wheat_seed, 1);
  });

  test('planting with a non-integer plot index (e.g. 2.5) is rejected', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'wheat_seed', 1);
    const result = store.plantSeed(id, 2.5, 'wheat');
    assert.equal(result.error, 'invalid_plot');
  });
});

describe('farming (animals)', () => {
  test('buying an animal costs gold; not enough gold fails', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);
    player.inventory.gold = 5;
    let result = store.buyAnimal(id, 'chicken'); // price 20
    assert.equal(result.error, 'not_enough_gold');

    player.inventory.gold = 100;
    result = store.buyAnimal(id, 'chicken');
    assert.equal(result.error, undefined);
    assert.equal(store.getPlayer(id).inventory.gold, 80);
  });

  test('unknown species is rejected', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.buyAnimal(id, 'dragon');
    assert.equal(result.error, 'unknown_species');
  });

  test('collecting a repeatable producer (chicken) before maturity fails, succeeds after and resets its timer', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.getPlayer(id).inventory.gold = 100;
    const bought = store.buyAnimal(id, 'chicken');

    let result = store.collectAnimal(id, bought.id);
    assert.equal(result.error, 'not_mature');

    const player = store.getPlayer(id);
    const animal = player.farm.animals.find((a) => a.id === bought.id);
    // Being mature isn't enough on its own — collectAnimal also requires a
    // full produce interval to have passed since the animal became ready to
    // collect, so back-date far enough to clear both.
    const species = store.ANIMAL_SPECIES.chicken;
    animal.bornAt = Date.now() - (species.matureSeconds + species.produceIntervalSeconds + 5) * 1000;
    result = store.collectAnimal(id, bought.id);
    assert.equal(result.error, undefined);
    assert.equal(result.item, 'egg');
    assert.equal(result.removed, false);
  });

  test('collecting a one-time producer (pig) removes it from the farm', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.getPlayer(id).inventory.gold = 100;
    const bought = store.buyAnimal(id, 'pig');
    const player = store.getPlayer(id);
    const animal = player.farm.animals.find((a) => a.id === bought.id);
    animal.bornAt = Date.now() - store.ANIMAL_SPECIES.pig.matureSeconds * 1000 - 1000;

    const result = store.collectAnimal(id, bought.id);
    assert.equal(result.error, undefined);
    assert.equal(result.item, 'pork');
    assert.equal(result.removed, true);
    assert.equal(store.getPlayer(id).farm.animals.find((a) => a.id === bought.id), undefined);
  });

  test('collecting an unknown animal id fails', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.collectAnimal(id, 'not_a_real_animal');
    assert.equal(result.error, 'unknown_animal');
  });
});

describe('buildings', () => {
  test('building without enough resources fails; building twice fails', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    let result = store.buildBuilding(id, 'sawmill');
    assert.equal(result.error, 'missing_resources');

    const player = store.getPlayer(id);
    player.inventory.gold = 200;
    player.inventory.wood = 20;
    result = store.buildBuilding(id, 'sawmill');
    assert.equal(result.error, undefined);

    result = store.buildBuilding(id, 'sawmill');
    assert.equal(result.error, 'already_built');
  });

  test('collecting before any interval has passed says nothing_ready; collecting after N intervals gives N items', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);
    player.inventory.gold = 200;
    player.inventory.wood = 20;
    store.buildBuilding(id, 'sawmill');

    let result = store.collectBuilding(id, 'sawmill');
    assert.equal(result.error, 'nothing_ready');

    const config = store.BUILDINGS.sawmill;
    player.buildings.sawmill.lastCollectedAt = Date.now() - config.produceIntervalSeconds * 1000 * 3.5;
    result = store.collectBuilding(id, 'sawmill');
    assert.equal(result.error, undefined);
    assert.equal(result.amount, 3); // floor(3.5)
    assert.equal(result.item, config.producesItem);
  });

  test('collecting an unbuilt building fails', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.collectBuilding(id, 'granary');
    assert.equal(result.error, 'not_built');
  });
});

describe('alchemy', () => {
  test('a known combo discovers the recipe, consumes ingredients, and is remembered', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'sunpetal', 1);
    store.devGiveItem(id, 'moonleaf', 1);
    const result = store.experimentAlchemy(id, 'sunpetal', 'moonleaf');
    assert.equal(result.error, undefined);
    assert.equal(result.discovered, true);
    assert.equal(result.newDiscovery, true);
    const player = store.getPlayer(id);
    assert.equal(player.inventory.sunpetal, undefined);
    assert.equal(player.inventory.moonleaf, undefined);
    assert.equal(player.inventory.healing_potion, 1);
    assert.ok(player.alchemy.knownRecipes.includes('healing_potion'));
  });

  test('an unknown (failing) combo still consumes ingredients the first time, and is remembered as tried', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'sunpetal', 2);
    store.devGiveItem(id, 'rat_tail', 1); // sunpetal + rat_tail is not a real recipe
    const result = store.experimentAlchemy(id, 'sunpetal', 'rat_tail');
    assert.equal(result.error, undefined);
    assert.equal(result.discovered, false);
    const player = store.getPlayer(id);
    assert.equal(player.inventory.sunpetal, 1); // one consumed
    assert.equal(player.inventory.rat_tail, undefined);
  });

  test('retrying an already-tried failing combo does not waste more ingredients', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'sunpetal', 5);
    store.devGiveItem(id, 'rat_tail', 5);
    store.experimentAlchemy(id, 'sunpetal', 'rat_tail'); // first try: consumes 1 of each
    const before = store.getPlayer(id).inventory.sunpetal;
    const result = store.experimentAlchemy(id, 'sunpetal', 'rat_tail');
    assert.equal(result.alreadyTried, true);
    assert.equal(store.getPlayer(id).inventory.sunpetal, before); // nothing more spent
  });

  test('rejects a non-ingredient item and combining an ingredient with itself', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'sunpetal', 2);
    store.devGiveItem(id, 'wood', 1);
    assert.equal(store.experimentAlchemy(id, 'sunpetal', 'wood').error, 'invalid_ingredient');
    assert.equal(store.experimentAlchemy(id, 'sunpetal', 'sunpetal').error, 'need_two_different_ingredients');
  });

  test('craftKnownPotion refuses a recipe the player has not discovered yet', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.craftKnownPotion(id, 'healing_potion');
    assert.equal(result.error, 'not_known');
  });

  test('craftKnownPotion works once the recipe is known and ingredients are owned', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devGiveItem(id, 'sunpetal', 1);
    store.devGiveItem(id, 'moonleaf', 1);
    store.experimentAlchemy(id, 'sunpetal', 'moonleaf'); // learns healing_potion
    store.devGiveItem(id, 'sunpetal', 1);
    store.devGiveItem(id, 'moonleaf', 1);
    const result = store.craftKnownPotion(id, 'healing_potion');
    assert.equal(result.error, undefined);
    assert.equal(store.getPlayer(id).inventory.healing_potion, 2); // 1 from experiment + 1 from craft
  });
});

describe('traits and perks', () => {
  test('cannot allocate a trait point with none available', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.allocateTraitPoint(id, 'strength');
    assert.equal(result.error, 'no_points_available');
  });

  test('allocating a trait point spends it and raises the trait', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);
    player.traitPointsAvailable = 1;
    const before = player.traits.strength;
    const result = store.allocateTraitPoint(id, 'strength');
    assert.equal(result.error, undefined);
    assert.equal(store.getPlayer(id).traits.strength, before + 1);
    assert.equal(store.getPlayer(id).traitPointsAvailable, 0);
  });

  test('rejects an unknown trait name', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.getPlayer(id).traitPointsAvailable = 1;
    const result = store.allocateTraitPoint(id, 'charisma');
    assert.equal(result.error, 'invalid_trait');
  });

  test('unlockPerk enforces level, points, and no double-unlock', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);

    // prospector requires character level 5
    player.perkPoints = 5;
    let result = store.unlockPerk(id, 'prospector');
    assert.equal(result.error, 'level_too_low');

    player.characterXp = 1000; // comfortably level 5+
    player.perkPoints = 0;
    result = store.unlockPerk(id, 'brute_force'); // tier 1, requiresLevel 1
    assert.equal(result.error, 'not_enough_points');

    player.perkPoints = 1;
    result = store.unlockPerk(id, 'brute_force');
    assert.equal(result.error, undefined);
    assert.ok(store.getPlayer(id).perks.includes('brute_force'));

    player.perkPoints = 1;
    result = store.unlockPerk(id, 'brute_force');
    assert.equal(result.error, 'already_unlocked');
  });

  test('unlockPerk rejects an unknown perk id', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.unlockPerk(id, 'no_such_perk');
    assert.equal(result.error, 'unknown_perk');
  });
});

describe('combat', () => {
  // amberfield_vale has giant_rat + bandit in its combat pool
  function setUpFightLocation(id) {
    store.devDiscoverLocation(id, 'amberfield_vale');
    store.travel(id, 'amberfield_vale');
  }

  test('cannot start a fight against an enemy not present at the current location', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    setUpFightLocation(id);
    const result = store.startCombat(id, 'stone_troll');
    assert.equal(result.error, 'enemy_not_here');
  });

  test('cannot start a fight with an empty ability loadout', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    setUpFightLocation(id);
    for (let i = 0; i < 6; i++) store.setLoadoutSlot(id, i, null);
    const result = store.startCombat(id, 'giant_rat');
    assert.equal(result.error, 'no_abilities_equipped');
  });

  test('starting a fight builds a combat object with the right enemy and full hp', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    setUpFightLocation(id);
    const result = store.startCombat(id, 'giant_rat');
    assert.equal(result.error, undefined);
    const player = store.getPlayer(id);
    assert.ok(player.combat);
    assert.equal(player.combat.playerHp, player.combat.playerMaxHp);
    assert.ok(player.combat.enemies.some((e) => e.enemyId === 'giant_rat'));
  });

  test('cannot start a second fight while one is already in progress', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    setUpFightLocation(id);
    store.startCombat(id, 'giant_rat');
    const result = store.startCombat(id, 'giant_rat');
    assert.equal(result.error, 'combat_in_progress');
  });

  test('a fight against a weak enemy eventually resolves to a result, granting rewards on a win', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    setUpFightLocation(id);
    store.startCombat(id, 'giant_rat');
    const player = store.getPlayer(id);
    // Fast-forward the round clock far into the past so tickCombat() can
    // resolve every round of the fight in one call instead of waiting on
    // real time.
    player.combat.nextTickAt = Date.now() - 1000 * 1000;
    const goldBefore = player.inventory.gold || 0;
    const combatXpBefore = player.skills.combat.xp;

    const pub = store.publicPlayer(player);
    assert.ok(pub.combat.result === 'win' || pub.combat.result === 'loss', `expected a result, got ${pub.combat.result}`);

    if (pub.combat.result === 'win') {
      assert.equal(store.getPlayer(id).combatRecord.wins, 1);
      assert.ok(store.getPlayer(id).inventory.gold >= goldBefore);
      assert.ok(store.getPlayer(id).skills.combat.xp > combatXpBefore);
      assert.equal(store.getPlayer(id).killCounts.giant_rat, 1);
    } else {
      assert.equal(store.getPlayer(id).combatRecord.losses, 1);
    }
  });

  test('a fight where the player is nearly dead reliably ends in a loss', () => {
    // dexterity is left at TRAIT_BASE here so the dodge-chance trait bonus
    // is exactly 0 — the only way to survive a hit is Quick Step's temporary
    // evasion window, so with enough rounds this will end in a loss.
    const { id } = makeCharacter(NO_DODGE_TRAITS);
    setUpFightLocation(id);
    store.startCombat(id, 'giant_rat');
    const player = store.getPlayer(id);
    player.combat.playerHp = 1;
    player.combat.nextTickAt = Date.now() - 1000 * 1000;
    const pub = store.publicPlayer(player);
    assert.equal(pub.combat.result, 'loss');
    assert.equal(store.getPlayer(id).combatRecord.losses, 1);
  });

  test('endCombat clears an in-progress fight with no reward', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    setUpFightLocation(id);
    store.startCombat(id, 'giant_rat');
    const result = store.endCombat(id);
    assert.equal(result.error, undefined);
    assert.equal(store.getPlayer(id).combat, null);
  });

  test('endCombat fails when there is no fight to end', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.endCombat(id);
    assert.equal(result.error, 'no_combat');
  });

  test('setCombatSpeed rejects an invalid preset and accepts a valid one', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    assert.equal(store.setCombatSpeed(id, 'ludicrous').error, 'invalid_speed');
    const result = store.setCombatSpeed(id, 'fast');
    assert.equal(result.error, undefined);
    assert.equal(store.getPlayer(id).combatSpeed, 'fast');
  });

  test('setLoadoutSlot rejects an ability above the player\'s combat level', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    // guard_up requires combat level 2; a fresh character is level 1
    const result = store.setLoadoutSlot(id, 0, 'guard_up');
    assert.equal(result.error, 'not_unlocked');
  });

  test('setLoadoutSlot rejects an out-of-range slot index and an unknown ability', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    assert.equal(store.setLoadoutSlot(id, 6, 'swing').error, 'invalid_slot');
    assert.equal(store.setLoadoutSlot(id, -1, 'swing').error, 'invalid_slot');
    assert.equal(store.setLoadoutSlot(id, 0, 'fireball').error, 'unknown_ability');
  });

  test('cannot edit the loadout mid-fight', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    setUpFightLocation(id);
    store.startCombat(id, 'giant_rat');
    const result = store.setLoadoutSlot(id, 0, 'swing');
    assert.equal(result.error, 'combat_in_progress');
  });
});

describe('resource gathering tasks', () => {
  test('mining the always-unlocked camp node yields stone and xp over time', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const start = store.startResourceTask(id, 'mining', 'stone');
    assert.equal(start.error, undefined);
    const player = store.getPlayer(id);
    // back-date the task so several cycles have "elapsed"
    player.skills.mining.taskStartedAt = Date.now() - store.RESOURCE_NODES.mining.stone.cycleSeconds * 1000 * 3.5;
    player.skills.mining.lastTick = player.skills.mining.taskStartedAt;
    const pub = store.publicPlayer(player);
    assert.equal(pub.miningNodes.find((n) => n.id === 'stone').active, true);
    assert.ok(store.getPlayer(id).inventory.stone >= 3);
    assert.ok(store.getPlayer(id).skills.mining.xp > 0);
  });

  test('starting a task on an undiscovered node is rejected', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.startResourceTask(id, 'mining', 'copper'); // needs wyrmwood_hold discovered
    assert.equal(result.error, 'not_unlocked');
  });

  test('starting a task for an unknown skill or unknown node is rejected', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    assert.equal(store.startResourceTask(id, 'alchemy_skill', 'x').error, 'unknown_skill');
    assert.equal(store.startResourceTask(id, 'mining', 'diamond').error, 'unknown_node');
  });

  test('starting a new task stops whatever was already running', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.startResourceTask(id, 'mining', 'stone');
    store.startResourceTask(id, 'woodcutting', 'camp_grove');
    const player = store.getPlayer(id);
    assert.equal(player.skills.mining.taskStartedAt, null);
    assert.ok(player.skills.woodcutting.taskStartedAt);
  });

  test('stopTask banks progress and clears the active task', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.startResourceTask(id, 'mining', 'stone');
    const result = store.stopTask(id, 'mining');
    assert.equal(result.error, undefined);
    assert.equal(store.getPlayer(id).skills.mining.taskStartedAt, null);
  });

  test('a chance-based node (scavenging) grants attemptXp on a completed cycle even without a find', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.startResourceTask(id, 'scavenging', 'camp_scavenge');
    const player = store.getPlayer(id);
    player.skills.scavenging.taskStartedAt = Date.now() - store.RESOURCE_NODES.scavenging.camp_scavenge.cycleSeconds * 1000 * 10;
    player.skills.scavenging.lastTick = player.skills.scavenging.taskStartedAt;
    store.publicPlayer(player);
    // 10 cycles completed, each grants attemptXp=2 regardless of outcome
    assert.ok(store.getPlayer(id).skills.scavenging.xp >= 20);
  });
});

describe('expeditions and travel', () => {
  test('travel to an undiscovered location fails', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.travel(id, 'ironbrook_mine');
    assert.equal(result.error, 'not_discovered');
  });

  test('travel to a discovered location succeeds', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.devDiscoverLocation(id, 'ironbrook_mine');
    const result = store.travel(id, 'ironbrook_mine');
    assert.equal(result.error, undefined);
    assert.equal(store.getPlayer(id).currentLocation, 'ironbrook_mine');
  });

  test('starting an expedition with no supplies fails', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.getPlayer(id).inventory.supplies = 0;
    const result = store.startExpedition(id, [
      { x: 50, y: 50 },
      { x: 55, y: 55 },
    ]);
    assert.equal(result.error, 'no_supplies');
  });

  test('starting an expedition with a too-short path fails', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.startExpedition(id, [{ x: 50, y: 50 }]);
    assert.equal(result.error, 'invalid_path');
  });

  // Regression test: a path point with a non-numeric or missing x/y used to
  // turn the length/cost math into NaN, permanently corrupting the
  // player's supplies count instead of failing cleanly. Fixed by validating
  // every point has finite x/y before doing any math with it.
  test('starting an expedition with a non-numeric path point is rejected and spends nothing', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const suppliesBefore = store.getPlayer(id).inventory.supplies;
    const result = store.startExpedition(id, [
      { x: 'a', y: 'b' },
      { x: 1, y: 2 },
    ]);
    assert.equal(result.error, 'invalid_path');
    assert.equal(store.getPlayer(id).inventory.supplies, suppliesBefore);
    assert.ok(!Number.isNaN(store.getPlayer(id).inventory.supplies));
  });

  test('starting an expedition with a missing x/y on a path point is rejected', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const result = store.startExpedition(id, [{ x: 50 }, { x: 55, y: 55 }]);
    assert.equal(result.error, 'invalid_path');
  });

  test('starting an expedition longer than supplies allow fails', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.getPlayer(id).inventory.supplies = 1; // allows ~3 percent-units of path
    const result = store.startExpedition(id, [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ]);
    assert.equal(result.error, 'path_too_long');
  });

  test('buyLocationReveal requires gold and discovers a previously-unknown location', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    store.getPlayer(id).inventory.gold = 0;
    let result = store.buyLocationReveal(id);
    assert.equal(result.error, 'not_enough_gold');

    store.getPlayer(id).inventory.gold = store.LOCATION_REVEAL_PRICE;
    result = store.buyLocationReveal(id);
    assert.equal(result.error, undefined);
    assert.ok(store.getPlayer(id).discoveries.includes(result.location.id));
    // The revealed location's own loot (if it has any) can add gold back on
    // top of the price paid, so don't assume the balance lands at exactly 0.
    const lootGold = result.location.loot && result.location.loot.item === 'gold' ? result.location.loot.amount : 0;
    assert.equal(store.getPlayer(id).inventory.gold, lootGold);
  });
});

describe('login and account creation', () => {
  test('logging in with an unknown username reports existing: false', () => {
    const result = store.login('nobody_has_this_name_xyz', 'whatever');
    assert.equal(result.existing, false);
  });

  test('creating a character requires a valid point-buy total', () => {
    const bad = store.createCharacter(`bad_${Date.now()}`, { strength: 10, dexterity: 10, luck: 10, vigor: 10 }, 'testpass');
    assert.equal(bad.error, 'invalid_point_total');
  });

  test('creating a character requires a password of at least 4 characters', () => {
    const result = store.createCharacter(`shortpw_${Date.now()}`, EVEN_TRAITS, 'abc');
    assert.equal(result.error, 'password_too_short');
  });

  test('cannot create two characters with the same username', () => {
    const username = `dupe_${Date.now()}`;
    const first = store.createCharacter(username, EVEN_TRAITS, 'testpass1');
    assert.equal(first.error, undefined);
    const second = store.createCharacter(username, EVEN_TRAITS, 'testpass1');
    assert.equal(second.error, 'username_taken');
  });

  test('logging back in with the right password succeeds, wrong password fails', () => {
    const username = `login_${Date.now()}`;
    store.createCharacter(username, EVEN_TRAITS, 'correcthorse');
    const wrong = store.login(username, 'wrongpassword');
    assert.equal(wrong.error, 'wrong_password');
    const right = store.login(username, 'correcthorse');
    assert.equal(right.existing, true);
    assert.equal(right.error, undefined);
  });

  test('verifyToken accepts the right token and rejects a wrong one', () => {
    const { id, token } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);
    assert.equal(store.verifyToken(player, token), true);
    assert.equal(store.verifyToken(player, 'not-the-real-token'), false);
  });

  test('a legacy account (token === null) accepts any token, including none at all', () => {
    const { id } = makeCharacter(EVEN_TRAITS);
    const player = store.getPlayer(id);
    player.token = null; // simulates an account created before tokens existed
    assert.equal(store.verifyToken(player, undefined), true);
    assert.equal(store.verifyToken(player, 'anything'), true);
  });
});

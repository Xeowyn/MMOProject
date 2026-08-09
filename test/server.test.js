'use strict';

// Integration tests for server/server.js — hits the real REST endpoints
// with real HTTP requests, on a random free local port.
//
// SAFETY: points MMO_DB_PATH at a scratch file in the OS temp folder before
// server.js (and the store.js it requires) are ever loaded, so nothing here
// can touch the real save file friends actually play on.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DB_PATH = path.join(os.tmpdir(), `mmo-test-server-${process.pid}-${Date.now()}.json`);
process.env.MMO_DB_PATH = DB_PATH;
process.env.PORT = '0'; // let the OS pick a free port

const { server } = require('../server/server');

let baseUrl;
let counter = 0;

before(() => {
  return new Promise((resolve) => {
    if (server.listening) {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    } else {
      server.once('listening', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    }
  });
});

after(async () => {
  server.close();
  // store.js debounces writes by up to a second (see SAVE_DEBOUNCE_MS in
  // store.js) — wait for that to flush before deleting the scratch file, or
  // it just gets quietly recreated a moment later.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  fs.rmSync(DB_PATH, { force: true });
});

async function api(pathname, options) {
  const res = await fetch(baseUrl + pathname, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body
  }
  return { status: res.status, body };
}

function post(pathname, body, extraHeaders) {
  return api(pathname, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders),
    body: JSON.stringify(body),
  });
}

async function createTestPlayer() {
  counter += 1;
  const username = `srv_tester_${process.pid}_${counter}`;
  const traits = { strength: 8, dexterity: 8, luck: 6, vigor: 8 };
  const { status, body } = await post('/api/create-character', { username, traits, password: 'testpass123' });
  assert.equal(status, 200, `character creation failed: ${JSON.stringify(body)}`);
  return { id: body.player.id, token: body.token, username };
}

describe('static GET endpoints', () => {
  test('GET /api/locations returns the location list with expected shape', async () => {
    const { status, body } = await api('/api/locations');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0);
    assert.ok(body[0].id);
    assert.ok(typeof body[0].x === 'number');
  });

  test('GET /api/items, /api/enemies, /api/quests, /api/perks return objects', async () => {
    for (const p of ['/api/items', '/api/enemies', '/api/quests', '/api/perks']) {
      const { status, body } = await api(p);
      assert.equal(status, 200, `${p} failed`);
      assert.equal(typeof body, 'object');
    }
  });

  test('GET /api/shop returns items and a location reveal price', async () => {
    const { status, body } = await api('/api/shop');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
    assert.ok(typeof body.locationRevealPrice === 'number');
  });

  test('GET /api/trait-config returns the point-buy configuration', async () => {
    const { status, body } = await api('/api/trait-config');
    assert.equal(status, 200);
    assert.deepEqual(body.keys, ['strength', 'dexterity', 'luck', 'vigor']);
    assert.equal(body.extraPoints, 10);
  });

  test('an unknown route returns a 404', async () => {
    const { status } = await api('/api/not-a-real-endpoint');
    assert.equal(status, 404);
  });
});

describe('login and character creation', () => {
  test('logging in with a brand new username reports existing: false', async () => {
    const { status, body } = await post('/api/login', { username: `brandnew_${Date.now()}`, password: 'x' });
    assert.equal(status, 200);
    assert.equal(body.existing, false);
  });

  test('full create -> login round trip', async () => {
    const { username } = await createTestPlayer();
    const { status, body } = await post('/api/login', { username, password: 'testpass123' });
    assert.equal(status, 200);
    assert.equal(body.existing, true);
    assert.ok(body.token);
    assert.ok(body.player.id);
  });

  test('wrong password on login returns 401', async () => {
    const { username } = await createTestPlayer();
    const { status, body } = await post('/api/login', { username, password: 'totally wrong' });
    assert.equal(status, 401);
    assert.equal(body.error, 'wrong_password');
  });

  test('creating a character with an unbalanced trait spread returns 400', async () => {
    const { status, body } = await post('/api/create-character', {
      username: `badtraits_${Date.now()}`,
      traits: { strength: 10, dexterity: 10, luck: 10, vigor: 10 },
      password: 'testpass123',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_point_total');
  });

  test('creating a character with a short password returns 400', async () => {
    const { status, body } = await post('/api/create-character', {
      username: `shortpw_${Date.now()}`,
      traits: { strength: 8, dexterity: 8, luck: 6, vigor: 8 },
      password: 'ab',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'password_too_short');
  });

  test('creating a character with a taken username returns 400', async () => {
    const { username } = await createTestPlayer();
    const { status, body } = await post('/api/create-character', {
      username,
      traits: { strength: 8, dexterity: 8, luck: 6, vigor: 8 },
      password: 'testpass123',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'username_taken');
  });
});

describe('token authentication', () => {
  test('GET /api/me without a token fails with 401 once a player exists', async () => {
    const { id } = await createTestPlayer();
    const { status, body } = await api(`/api/me?playerId=${id}`);
    assert.equal(status, 401);
    assert.equal(body.error, 'invalid_token');
  });

  test('GET /api/me with the wrong token fails with 401', async () => {
    const { id } = await createTestPlayer();
    const { status, body } = await api(`/api/me?playerId=${id}`, { headers: { 'X-Player-Token': 'not-the-real-token' } });
    assert.equal(status, 401);
    assert.equal(body.error, 'invalid_token');
  });

  test('GET /api/me with the correct token succeeds', async () => {
    const { id, token } = await createTestPlayer();
    const { status, body } = await api(`/api/me?playerId=${id}`, { headers: { 'X-Player-Token': token } });
    assert.equal(status, 200);
    assert.equal(body.id, id);
  });

  test('GET /api/me for a nonexistent player id returns 404 (no playerId auth needed to find that out)', async () => {
    const { status, body } = await api('/api/me?playerId=p_does_not_exist');
    assert.equal(status, 404);
    assert.equal(body.error, 'not_found');
  });

  test('a POST action without a token is rejected the same way', async () => {
    const { id } = await createTestPlayer();
    const { status, body } = await post('/api/travel', { playerId: id, locationId: 'wanderers_camp' });
    assert.equal(status, 401);
    assert.equal(body.error, 'invalid_token');
  });
});

describe('gameplay endpoints via HTTP', () => {
  test('dev/give -> craft round trip over real HTTP', async () => {
    const { id, token } = await createTestPlayer();
    const headers = { 'X-Player-Token': token };

    let res = await post('/api/dev/give', { playerId: id, itemId: 'wheat_crop', amount: 2 }, headers);
    assert.equal(res.status, 200);

    res = await post('/api/craft', { playerId: id, recipeId: 'wheat_supplies' }, headers);
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'supplies');
  });

  test('craft with missing ingredients returns 400 missing_ingredients', async () => {
    const { id, token } = await createTestPlayer();
    const res = await post('/api/craft', { playerId: id, recipeId: 'wheat_supplies' }, { 'X-Player-Token': token });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'missing_ingredients');
  });

  test('shop buy and sell round trip', async () => {
    const { id, token } = await createTestPlayer();
    const headers = { 'X-Player-Token': token };
    await post('/api/dev/give', { playerId: id, itemId: 'gold', amount: 100 }, headers);

    const buy = await post('/api/shop/buy', { playerId: id, itemId: 'rusty_sword' }, headers);
    assert.equal(buy.status, 200);

    const equip = await post('/api/equip', { playerId: id, itemId: 'rusty_sword' }, headers);
    assert.equal(equip.status, 200);
    assert.equal(equip.body.slot, 'weapon');
  });

  test('task start/stop over HTTP updates /api/me', async () => {
    const { id, token } = await createTestPlayer();
    const headers = { 'X-Player-Token': token };

    const start = await post('/api/task/start', { playerId: id, skillId: 'mining', nodeId: 'stone' }, headers);
    assert.equal(start.status, 200);

    const me = await api(`/api/me?playerId=${id}`, { headers });
    assert.equal(me.body.miningNodes.find((n) => n.id === 'stone').active, true);

    const stop = await post('/api/task/stop', { playerId: id, skillId: 'mining' }, headers);
    assert.equal(stop.status, 200);
  });

  test('quest accept then turn-in without meeting the objective is a 400', async () => {
    const { id, token } = await createTestPlayer();
    const headers = { 'X-Player-Token': token };
    await post('/api/quest/accept', { playerId: id, questId: 'timber_delivery' }, headers);
    const turnIn = await post('/api/quest/turn-in', { playerId: id, questId: 'timber_delivery' }, headers);
    assert.equal(turnIn.status, 400);
    assert.equal(turnIn.body.error, 'objective_not_met');
  });

  test('fishing/catch outside of fishing returns 400 not_fishing (not a 200 with success:false)', async () => {
    const { id, token } = await createTestPlayer();
    const res = await post('/api/fishing/catch', { playerId: id }, { 'X-Player-Token': token });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'not_fishing');
  });
});

describe('input edge cases', () => {
  test('a POST with no body at all does not crash the server', async () => {
    const res = await fetch(baseUrl + '/api/travel', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.ok(res.status >= 400 && res.status < 500);
    // the server must still be answering after this
    const stillAlive = await api('/api/locations');
    assert.equal(stillAlive.status, 200);
  });

  test('malformed JSON body does not crash the server', async () => {
    const res = await fetch(baseUrl + '/api/travel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    assert.ok(res.status >= 400 && res.status < 500);
    const stillAlive = await api('/api/locations');
    assert.equal(stillAlive.status, 200);
  });

  test('craft with a completely missing recipeId is a clean 400, not a crash', async () => {
    const { id, token } = await createTestPlayer();
    const res = await post('/api/craft', { playerId: id }, { 'X-Player-Token': token });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'unknown_recipe');
  });

  test('equip with an unknown itemId is a clean 400', async () => {
    const { id, token } = await createTestPlayer();
    const res = await post('/api/equip', { playerId: id, itemId: 'not_a_real_item' }, { 'X-Player-Token': token });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'not_equippable');
  });

  test('sellItem with a negative amount is rejected, not treated as free items', async () => {
    const { id, token } = await createTestPlayer();
    const headers = { 'X-Player-Token': token };
    await post('/api/dev/give', { playerId: id, itemId: 'wood', amount: 5 }, headers);
    const res = await post('/api/shop/sell', { playerId: id, itemId: 'wood', amount: -3 }, headers);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_amount');
  });
});

describe('rate limiting', () => {
  test('hammering the API eventually gets a 429', async () => {
    const { id, token } = await createTestPlayer();
    let sawRateLimit = false;
    for (let i = 0; i < 400 && !sawRateLimit; i++) {
      const res = await fetch(`${baseUrl}/api/me?playerId=${id}`, { headers: { 'X-Player-Token': token } });
      if (res.status === 429) sawRateLimit = true;
    }
    assert.ok(sawRateLimit, 'expected to eventually see a 429 rate_limited response');
  });
});

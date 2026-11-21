// Unit tests for the message validation helpers (lib/server-input.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame, cleanName, cleanCode, cleanIds, battleOrders, campaignOrder, numberOption } from '../lib/server-input.js';

const frame = v => parseFrame(Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)), false);

test('parseFrame: only objects with a string t', () => {
  assert.deepEqual(frame({ t: 'ready' }), { t: 'ready' });
  for (const raw of ['', 'x', 'null', '1', '"s"', '[]', '[{"t":"x"}]', '{}', '{"t":1}', '{"t":null}', '{"t":["a"]}']) {
    assert.equal(frame(raw), null, raw);
  }
  assert.equal(parseFrame(Buffer.from('{"t":"ready"}'), true), null, 'binary frames are not messages');
  assert.equal(frame('{"__proto__":{"t":"ready"}}'), null, 'a t smuggled in through __proto__ does not count');
});

test('cleanName and cleanCode', () => {
  assert.equal(cleanName('Gaius_Julius-Caesar the 1st'), 'Gaius_Julius-Cae');
  assert.equal(cleanName('a<b>&"c;d'), 'abcd');
  assert.equal(cleanName('   '), 'Commander');
  assert.equal(cleanName('x'.repeat(100000)), 'x'.repeat(16));
  for (const v of [undefined, null, 5, {}, [], true]) assert.equal(cleanName(v), 'Commander');
  assert.equal(cleanCode('ab1z'), 'AB1Z');
  assert.equal(cleanCode(' AB1Z\n'), 'AB1Z');
  for (const v of ['', 'ABC', 'ABCDE', 'AB-Z', '__proto__', 'ÀBCD']) assert.equal(cleanCode(v), '', v);
  for (const v of [undefined, null, 1234, ['ABCD'], {}]) assert.equal(cleanCode(v), null);
});

test('cleanIds: an array of at most 20 integers, nothing else', () => {
  assert.deepEqual(cleanIds([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(cleanIds([]), []);
  assert.equal(cleanIds(Array(21).fill(1)), null);
  for (const v of [undefined, null, '1', 1, {}, [1.5], ['1'], [null], [NaN], [Infinity], [[1]], { length: 1, 0: 1 }]) assert.equal(cleanIds(v), null);
});

test('battleOrders: typed, clamped orders or null', () => {
  const W = 1600, H = 900, PI = Math.PI;
  assert.deepEqual(battleOrders({ t: 'stop', ids: [1] }, W, H), [{ ids: [1], order: { t: 'stop' } }]);
  assert.deepEqual(battleOrders({ t: 'attack', ids: [1, 2], target: 9 }, W, H), [{ ids: [1, 2], order: { t: 'attack', target: 9 } }]);
  assert.deepEqual(battleOrders({ t: 'move', ids: [1], x: 5, y: 6 }, W, H), [{ ids: [1], order: { t: 'move', x: 5, y: 6 } }]);
  assert.deepEqual(battleOrders({ t: 'move', ids: [1], x: 5, y: 6, face: null }, W, H), [{ ids: [1], order: { t: 'move', x: 5, y: 6 } }]);
  assert.deepEqual(battleOrders({ t: 'move', ids: [1], x: -1e308, y: 1e308 }, W, H), [{ ids: [1], order: { t: 'move', x: 0, y: 900 } }]);
  const faced = battleOrders({ t: 'move', ids: [1], x: 5, y: 6, face: 3 * PI }, W, H)[0].order.face;
  assert.ok(Math.abs(Math.abs(faced) - PI) < 1e-9, 'face is normalised');
  assert.ok(Number.isFinite(battleOrders({ t: 'move', ids: [1], x: 5, y: 6, face: 1e308 }, W, H)[0].order.face));
  assert.deepEqual(battleOrders({ t: 'moves', list: [[1, 10, 20], [2, 30, 40, 1]] }, W, H),
    [{ ids: [1], order: { t: 'move', x: 10, y: 20 } }, { ids: [2], order: { t: 'move', x: 30, y: 40, face: 1 } }]);
  assert.deepEqual(battleOrders({ t: 'moves', list: [] }, W, H), []);
  const bad = [
    { t: 'move', ids: [1], x: '5', y: 6 }, { t: 'move', ids: [1], x: 5 }, { t: 'move', ids: [1], x: NaN, y: 6 },
    { t: 'move', ids: [1], x: 5, y: Infinity }, { t: 'move', ids: [1], x: 5, y: 6, face: '1' }, { t: 'move', ids: [1], x: 5, y: 6, face: Infinity },
    { t: 'move', ids: '1', x: 5, y: 6 }, { t: 'attack', ids: [1], target: '9' }, { t: 'attack', ids: [1], target: 9.5 }, { t: 'attack', ids: [1] },
    { t: 'stop' }, { t: 'moves' }, { t: 'moves', list: [[1, 2]] }, { t: 'moves', list: [[1, 2, 3, 4, 5]] }, { t: 'moves', list: [[1.5, 2, 3]] },
    { t: 'moves', list: [[1, 2, 3], [1, 2, '3']] }, { t: 'moves', list: Array(21).fill([1, 2, 3]) }, { t: 'moves', list: [{ 0: 1, 1: 2, 2: 3, length: 3 }] },
    { t: 'dance', ids: [1] }, { t: 'constructor', ids: [1] },
  ];
  for (const m of bad) assert.equal(battleOrders(m, W, H), null, JSON.stringify(m));
});

test('campaignOrder: integers and strings only, never coerced', () => {
  assert.deepEqual(campaignOrder({ t: 'endturn', junk: 1 }), { t: 'endturn' });
  assert.deepEqual(campaignOrder({ t: 'recruit', prov: 0, type: 'sword' }), { t: 'recruit', prov: 0, type: 'sword' });
  assert.deepEqual(campaignOrder({ t: 'cmove', army: 1, to: 2 }), { t: 'cmove', army: 1, to: 2 });
  assert.deepEqual(campaignOrder({ t: 'cmove', army: 1, to: null }), { t: 'cmove', army: 1, to: null });
  const bad = [
    { t: 'recruit', prov: '0', type: 'sword' }, { t: 'recruit', prov: 0.5, type: 'sword' }, { t: 'recruit', prov: null, type: 'sword' },
    { t: 'recruit', prov: 0, type: 1 }, { t: 'recruit', prov: 0 }, { t: 'cmove', army: '1', to: 2 }, { t: 'cmove', army: 1, to: '2' },
    { t: 'cmove', army: 1 }, { t: 'cmove', army: 1, to: 1.5 }, { t: 'cmove', army: {}, to: 2 }, { t: 'cmove', army: 1, to: false }, { t: 'other' },
  ];
  for (const m of bad) assert.equal(campaignOrder(m), null, JSON.stringify(m));
});

test('numberOption: finite and at least min, else the default', () => {
  assert.equal(numberOption(5, 9), 5);
  assert.equal(numberOption(0, 9), 0);
  assert.equal(numberOption(0, 9, 1), 9);
  for (const v of [undefined, null, '5', NaN, Infinity, -1, {}]) assert.equal(numberOption(v, 9), 9);
});

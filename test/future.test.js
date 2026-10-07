const test = require('node:test');
const assert = require('node:assert/strict');
const Future = require('../index');
const fluture = require('fluture');

test('constructor stays lazy until execution', async () => {
  let calls = 0;
  const future = new Future(resolve => {
    calls += 1;
    resolve(2);
  });
  assert.equal(calls, 0);
  assert.deepEqual(await future.toPromise(), { value: 2 });
  assert.equal(calls, 1);
});

test('constructor accepts a Fluture containing a payload', async () => {
  const future = new Future(fluture.resolve({ value: 3 }));
  assert.deepEqual(await future.toPromise(), { value: 3 });
});

test('then handles values and nested Futures', async () => {
  const result = await Future.resolve(2)
    .then(value => value + 1)
    .then(value => Future.resolve(value * 2))
    .toPromise();
  assert.deepEqual(result, { value: 6 });
});

test('catch recovers from rejection', async () => {
  const result = await Future.reject('failed').catch(error => `handled ${error}`).toPromise();
  assert.deepEqual(result, { value: 'handled failed' });
});

test('exceptions in the constructor become rejections', async () => {
  const error = new Error('constructor failed');
  await assert.rejects(new Future(() => { throw error; }).toPromise(), payload => payload.error === error);
});

test('exceptions in then and catch become rejections', async () => {
  const error = new Error('handler failed');
  await assert.rejects(Future.resolve(1).then(() => { throw error; }).toPromise(), payload => payload.error === error);
  await assert.rejects(Future.reject(1).catch(() => { throw error; }).toPromise(), payload => payload.error === error);
});

test('tags propagate through nested Futures in order', async () => {
  const result = await Future.resolve(1).tag('request', 123)
    .then(value => Future.resolve(value + 1).tag('step', 456)).toPromise();
  assert.deepEqual(result, {
    value: 2,
    context: { tags: [{ name: 'request', data: 123 }, { name: 'step', data: 456 }] },
  });
});

test('context survives rejection and recovery', async () => {
  const future = Future.tag('request', 123).then(() => Future.reject('failed'));
  await assert.rejects(future.toPromise(), payload => {
    assert.deepEqual(payload, { error: 'failed', context: { tags: [{ name: 'request', data: 123 }] } });
    return true;
  });
  assert.deepEqual(await future.catch(() => 2).toPromise(), {
    value: 2, context: { tags: [{ name: 'request', data: 123 }] },
  });
});

test('after resolves and rejectAfter rejects', async () => {
  assert.deepEqual(await Future.after(1, 9).toPromise(), { value: 9 });
  await assert.rejects(Future.rejectAfter(1, 'failed').toPromise(), payload => payload.error === 'failed');
});

test('fork delivers the success payload', async () => {
  const payload = await new Promise((resolve, reject) => Future.resolve(7).fork(resolve, reject));
  assert.deepEqual(payload, { value: 7 });
});

test('fork delivers the rejection payload', async () => {
  const payload = await new Promise(resolve => Future.reject('failed').fork(() => assert.fail('Unexpected success'), resolve));
  assert.deepEqual(payload, { error: 'failed' });
});

test('fork cancellation prevents a delayed result', async () => {
  let called = false;
  const cancel = Future.after(5, 1).fork(() => { called = true; });
  assert.equal(typeof cancel, 'function');
  cancel();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(called, false);
});

test('encaseF wraps synchronous results and errors', async () => {
  assert.deepEqual(await Future.encaseF(value => value * 2)(3).toPromise(), { value: 6 });
  const error = new Error('sync failed');
  await assert.rejects(Future.encaseF(() => { throw error; })().toPromise(), payload => payload.error === error);
});

test('encaseP wraps Promise results and errors', async () => {
  assert.deepEqual(await Future.encaseP(async value => value * 2)(4).toPromise(), { value: 8 });
  const error = new Error('promise failed');
  await assert.rejects(Future.encaseP(async () => { throw error; })().toPromise(), payload => payload.error === error);
  await assert.rejects(Future.encaseP(() => { throw error; })().toPromise(), payload => payload.error === error);
});

test('encaseC wraps asynchronous callback results and errors', async () => {
  assert.deepEqual(await Future.encaseC((value, done) => setTimeout(() => done(null, value * 2), 1))(5).toPromise(), { value: 10 });
  const error = new Error('callback failed');
  await assert.rejects(Future.encaseC(done => setTimeout(() => done(error), 1))().toPromise(), payload => payload.error === error);
  await assert.rejects(Future.encaseC(() => { throw error; })().toPromise(), payload => payload.error === error);
});

test('all preserves input order and accepts plain values', async () => {
  const result = await Future.all([Future.after(5, 1), Future.resolve(2), 3]).toPromise();
  assert.deepEqual(result, { value: [1, 2, 3], context: undefined });
});

test('all honors its concurrency limit', async () => {
  let active = 0;
  let maxActive = 0;
  const futures = [1, 2, 3, 4].map(value => new Future(resolve => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => { active -= 1; resolve(value); }, 5);
  }));
  assert.deepEqual((await Future.all(futures, { limit: 2 }).toPromise()).value, [1, 2, 3, 4]);
  assert.equal(maxActive, 2);
});

test('all rejects when one input rejects', async () => {
  await assert.rejects(Future.all([Future.resolve(1), Future.reject('failed')]).toPromise(), payload => payload.error === 'failed');
});

test('all can retain errors as values', async () => {
  assert.deepEqual((await Future.all([Future.reject('failed'), Future.resolve(2)], { ignoreError: true }).toPromise()).value, ['failed', 2]);
});

test('all handles empty input', async () => {
  assert.deepEqual(await Future.all([]).toPromise(), { value: [], context: undefined });
});

test('all uses the first context by default and merges all contexts when requested', async () => {
  const futures = [Future.resolve(1).tag('a', 1), Future.resolve(2).tag('b', 2)];
  assert.deepEqual((await Future.all(futures).toPromise()).context, { tags: [{ name: 'a', data: 1 }] });
  assert.deepEqual((await Future.all(futures, { saveAllContexts: true }).toPromise()).context, { tags: [{ name: 'a', data: 1 }, { name: 'b', data: 2 }] });
});

test('static then composes a transformation', async () => {
  assert.deepEqual(await Future.then(value => value + 1)(Future.resolve(3)).toPromise(), { value: 4 });
});

test('invalid constructor and handler arguments are rejected', () => {
  assert.throws(() => new Future(1), TypeError);
  assert.throws(() => Future.resolve().then(null), TypeError);
  assert.throws(() => Future.resolve().catch(null), TypeError);
  for (const wrap of [Future.encaseF, Future.encaseP, Future.encaseC]) {
    assert.throws(() => wrap(null), TypeError);
  }
});

test('invalid all options are rejected', () => {
  assert.throws(() => Future.all(null), TypeError);
  for (const limit of [0, -1, 1.5, '2', NaN]) {
    assert.throws(() => Future.all([], { limit }), TypeError);
  }
  assert.throws(() => Future.all([], { ignoreError: 'yes' }), TypeError);
  assert.throws(() => Future.all([], { saveAllContexts: 1 }), TypeError);
});

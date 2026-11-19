import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { SessionManager } from '../src/sessions.js';

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('timed-out startup holds capacity until its late worker is actually cleaned up', async () => {
  const startup = gate();
  let closed = 0;
  const manager = new SessionManager({
    maxSessions: 1, startupTimeoutMs: 15, cleanupTimeoutMs: 10,
    upstreamFactory: () => startup.promise,
  });
  try {
    const opening = assert.rejects(manager.open(), { code: 'STARTUP_TIMEOUT' });
    await delay(40);
    await opening;
    await assert.rejects(manager.open(), { code: 'CAPACITY' });
    startup.resolve({ close: async () => { closed++; } });
    await delay(5);
    assert.equal(closed, 1);
    assert.equal(manager.sessions.size, 0);
  } finally { startup.resolve({ close: async () => {} }); await manager.close(); }
});

test('idle expiry never interrupts active work and disposes an idle session', async () => {
  let now = 0;
  let closed = 0;
  const work = gate();
  const manager = new SessionManager({
    now: () => now, idleTtlMs: 1000,
    upstreamFactory: async () => ({ close: async () => { closed++; } }),
  });
  try {
    const { sessionId } = await manager.open();
    const active = manager.run(sessionId, () => work.promise);
    await Promise.resolve();
    now = 50_000;
    assert.equal(manager.getInfo(sessionId).active, true);
    work.resolve('finished');
    assert.equal(await active, 'finished');
    now += 1001;
    assert.throws(() => manager.getInfo(sessionId), { code: 'SESSION_EXPIRED' });
    await delay(1);
    assert.equal(closed, 1);
  } finally { work.resolve(); await manager.close(); }
});

test('cancelling a queued call prevents its side effect without retiring a healthy worker', async () => {
  const work = gate();
  const manager = new SessionManager({ upstreamFactory: async () => ({ close: async () => {} }) });
  try {
    const { sessionId } = await manager.open();
    const first = manager.run(sessionId, () => work.promise);
    const controller = new AbortController();
    let sideEffects = 0;
    const second = manager.run(sessionId, () => { sideEffects++; }, { signal: controller.signal });
    const rejected = assert.rejects(second, { code: 'CANCELLED' });
    controller.abort();
    work.resolve();
    await first;
    await rejected;
    assert.equal(sideEffects, 0);
    assert.equal(await manager.run(sessionId, () => 'still healthy'), 'still healthy');
  } finally { work.resolve(); await manager.close(); }
});

test('CAPACITY reports idle slots, the soonest expiry, and the remedy without evicting anyone', async () => {
  let now = 0;
  const work = gate();
  const closed = [];
  const manager = new SessionManager({
    now: () => now, maxSessions: 3, idleTtlMs: 60_000,
    upstreamFactory: async ({ label }) => ({ close: async () => { closed.push(label); } }),
  });
  try {
    const a = await manager.open({ label: 'a' });
    const b = await manager.open({ label: 'b' });
    const c = await manager.open({ label: 'c' });
    const busy = manager.run(c.sessionId, () => work.promise);
    now = 10_000;
    manager.getInfo(b.sessionId); // b was used more recently than a
    now = 23_000;
    const full = await manager.open({ label: 'd' }).catch(error => error);
    assert.equal(full.code, 'CAPACITY');
    assert.match(full.message, /All 3 session slots are in use: 1 busy, 2 idle, 0 closing\./);
    assert.match(full.message, /soonest idle session expires in 37s/);
    assert.match(full.message, /chrome_session action "close"/);
    assert.match(full.message, /--max-sessions/);
    for (const { sessionId } of [a, b, c]) assert.doesNotMatch(full.message, new RegExp(sessionId));
    assert.deepEqual(closed, [], 'a capacity error never closes another session');

    now = 59_999;
    assert.match((await manager.open({ label: 'd' }).catch(error => error)).message, /expires in 1s\./);
    now = 60_000; // retrying at the advertised expiry succeeds: open frees a's slot instead of waiting for the sweep
    await manager.open({ label: 'd' });
    assert.deepEqual(closed, ['a']);
    work.resolve();
    await busy;
  } finally { work.resolve(); await manager.close(); }
});

test('open at capacity waits for a slot that is already closing instead of reporting CAPACITY', async () => {
  let now = 0;
  const exiting = gate();
  const manager = new SessionManager({
    now: () => now, maxSessions: 1, idleTtlMs: 1000,
    upstreamFactory: async ({ label }) => ({ close: () => (label === 'slow' ? exiting.promise : undefined) }),
  });
  try {
    await manager.open({ label: 'slow' });
    now = 1000;
    manager.expireIdle(); // the sweeper got there first; the worker is still exiting
    const opening = manager.open({ label: 'next' });
    await delay(5);
    exiting.resolve();
    assert.equal((await opening).label, 'next');
  } finally { exiting.resolve(); await manager.close(); }
});

test('a throwing lifecycle log never breaks open, close or shutdown, and a failed worker close still frees its slot', async (t) => {
  const warnings = [];
  const onWarning = warning => warnings.push(warning.message);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  const events = [];
  const manager = new SessionManager({
    maxSessions: 1,
    log: (event, fields) => { events.push({ event, ...fields }); throw new Error('log sink is down'); },
    upstreamFactory: async ({ label }) => ({ close: async () => { if (label === 'leaky') throw new Error('EBUSY: temp dir in use'); } }),
  });
  const { sessionId } = await manager.open({ label: 'leaky' });
  await manager.closeSession(sessionId);
  assert.equal(manager.sessions.size, 0, 'the slot is free although close failed and every log call threw');
  await manager.open({ label: 'last' });
  await manager.close();
  assert.equal(manager.sessions.size, 0);
  assert.deepEqual(events.map(({ event, label }) => [event, label]), [
    ['session opened', 'leaky'], ['session closed', 'leaky'], ['worker close failed', 'leaky'],
    ['session opened', 'last'], ['session closed', 'last'],
  ]);
  assert.equal(events[2].message, 'EBUSY: temp dir in use');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warnings.length, 5);
  assert.match(warnings[0], /log sink is down/);
});

test('lifecycle log carries label, short ID, and reason, never call arguments or results', async () => {
  let now = 0;
  const entries = [];
  const marker = 'private-page-content-marker';
  const manager = new SessionManager({
    now: () => now, idleTtlMs: 1000, callTimeoutMs: 20,
    log: (event, fields) => entries.push({ event, ...fields }),
    upstreamFactory: async ({ label }) => {
      if (label === 'broken') throw Object.assign(new Error('Cannot start'), { code: 'UPSTREAM_START_FAILED', stderr: 'Invalid viewport.' });
      return { close: async () => {} };
    },
  });
  try {
    const timed = await manager.open({ label: 'timed' });
    assert.equal(await manager.run(timed.sessionId, () => `${marker}-result`), `${marker}-result`);
    await assert.rejects(manager.run(timed.sessionId, () => new Promise(() => {})), { code: 'CALL_TIMEOUT' });
    const closer = await manager.open({ label: 'closer' });
    await manager.closeSession(closer.sessionId);
    const idle = await manager.open({ label: 'idle' });
    now += 1000;
    assert.throws(() => manager.getInfo(idle.sessionId), { code: 'SESSION_EXPIRED' });
    await assert.rejects(manager.open({ label: 'broken' }), { code: 'UPSTREAM_START_FAILED' });
    const last = await manager.open({ label: 'last' });
    await manager.close();
    const short = ({ sessionId }) => sessionId.slice(0, 6);
    assert.deepEqual(entries.map(({ event, label, reason }) => [event, label, reason]), [
      ['session opened', 'timed', undefined],
      ['call timed out', 'timed', undefined],
      ['session retired', 'timed', 'CALL_TIMEOUT'],
      ['session opened', 'closer', undefined],
      ['session closed', 'closer', 'client'],
      ['session opened', 'idle', undefined],
      ['session expired', 'idle', undefined],
      ['worker start failed', 'broken', undefined],
      ['session opened', 'last', undefined],
      ['session closed', 'last', 'shutdown'],
    ]);
    assert.equal(entries[0].id, short(timed));
    assert.equal(entries.at(-1).id, short(last));
    const { error, message, stderr } = entries.find(entry => entry.event === 'worker start failed');
    assert.deepEqual({ error, message, stderr }, { error: 'UPSTREAM_START_FAILED', message: 'Cannot start', stderr: 'Invalid viewport.' });
    const logged = JSON.stringify(entries);
    assert.doesNotMatch(logged, new RegExp(marker));
    for (const { sessionId } of [timed, closer, idle, last]) assert.doesNotMatch(logged, new RegExp(sessionId));
  } finally { await manager.close(); }
});

test('the default call timeout fires before the MCP SDK client\'s default request timeout, so the client sees CALL_TIMEOUT', async () => {
  const manager = new SessionManager({ upstreamFactory: async () => ({ close: async () => {} }) });
  try {
    assert.equal(manager.callTimeoutMs, 55_000);
    assert.ok(DEFAULT_REQUEST_TIMEOUT_MSEC - manager.callTimeoutMs >= 5000, 'its answer has seconds to arrive before the client gives up');
  } finally { await manager.close(); }
});

test('a closed session\'s ID says why it closed, for idleTtlMs and the last 256 sessions, and never reopens it', async () => {
  let now = 0;
  const manager = new SessionManager({
    now: () => now, idleTtlMs: 10_000, callTimeoutMs: 20, maxSessions: 1,
    upstreamFactory: async () => ({ close: async () => {} }),
  });
  const why = async (sessionId) => {
    const error = await manager.run(sessionId, () => 'must not run').catch(failure => failure);
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    assert.deepEqual([() => manager.getInfo(sessionId), () => manager.record(sessionId)].map(read => { try { read(); } catch (failure) { return failure.message; } return 'reopened'; }),
      [error.message, error.message], 'every lookup gives the same answer; the session stays closed');
    assert.equal((await manager.closeSession(sessionId).catch(failure => failure)).code, 'SESSION_NOT_FOUND');
    return error.message;
  };
  try {
    const timedOut = await manager.open();
    await assert.rejects(manager.run(timedOut.sessionId, () => new Promise(() => {})), { code: 'CALL_TIMEOUT' });
    assert.match(await why(timedOut.sessionId), /^Session closed: a call timed out, so the session was retired\. Its outcome may be unknown; do not automatically retry a side effect\. Open a new session\.$/);

    const cancelled = await manager.open();
    const controller = new AbortController();
    const started = gate();
    const running = manager.run(cancelled.sessionId, () => { started.resolve(); return new Promise(() => {}); }, { signal: controller.signal });
    await started.promise; // a queued call's cancellation retires nothing; a running one's does
    controller.abort();
    await assert.rejects(running, { code: 'CANCELLED' });
    assert.match(await why(cancelled.sessionId), /^Session closed: a running call was cancelled \(its client cancelled the request or disconnected\).*do not automatically retry/);

    const crashed = await manager.open();
    await assert.rejects(manager.run(crashed.sessionId, () => { throw Object.assign(new Error('gone'), { code: 'UPSTREAM_DISCONNECTED' }); }), { code: 'UPSTREAM_DISCONNECTED' });
    assert.match(await why(crashed.sessionId), /^Session closed: its Chrome DevTools worker crashed or disconnected\./);

    const closed = await manager.open();
    await manager.closeSession(closed.sessionId);
    assert.match(await why(closed.sessionId), /^Session closed: it was closed with chrome_session action "close"\. Open a new session\.$/);

    const idle = await manager.open();
    now += 10_000;
    assert.throws(() => manager.getInfo(idle.sessionId), { code: 'SESSION_EXPIRED' });
    await delay(1);
    assert.match(await why(idle.sessionId), /^Session closed: it expired after idleTtlMs without calls\. Open a new session\.$/);

    const generic = 'Session is closed, expired, or unknown. Open a new session.';
    assert.equal(await why('never-issued'), generic, 'an unknown ID learns nothing');
    now += 9_999;
    assert.match(await why(idle.sessionId), /expired after idleTtlMs/);
    now += 1;
    assert.equal(await why(idle.sessionId), generic, 'the reason is kept for idleTtlMs only');

    const first = await manager.open();
    await manager.closeSession(first.sessionId);
    for (let i = 0; i < 255; i++) await manager.closeSession((await manager.open()).sessionId);
    assert.match(await why(first.sessionId), /closed with chrome_session/, '256 remembered');
    await manager.closeSession((await manager.open()).sessionId);
    assert.equal(await why(first.sessionId), generic, 'the oldest is forgotten beyond 256');
    assert.equal(manager.retired.size, 256);
  } finally { await manager.close(); }
});

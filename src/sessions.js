import { randomBytes } from 'node:crypto';
import { BrokerError } from './errors.js';

const unknownOutcome = 'Its outcome may be unknown; do not automatically retry a side effect.';
/** Why a session closed, keyed by its dispose event or reason; told to a caller that presents the closed session's ID. */
const closedBecause = {
  'session expired': 'it expired after idleTtlMs without calls.',
  CALL_TIMEOUT: `a call timed out, so the session was retired. ${unknownOutcome}`,
  CANCELLED: `a running call was cancelled (its client cancelled the request or disconnected), so the session was retired to prevent overlapping browser actions. ${unknownOutcome}`,
  UPSTREAM_DISCONNECTED: `its Chrome DevTools worker crashed or disconnected. ${unknownOutcome}`,
  client: 'it was closed with chrome_session action "close".',
};
const retiredMemory = 256; // closed session IDs whose reason is kept, each for at most idleTtlMs

/** The operator-tunable defaults; the CLI's --help reads them from here. */
export const sessionDefaults = Object.freeze({
  maxSessions: 4,
  maxQueue: 8,
  idleTtlMs: 600_000,
  // Below the MCP SDK client's default 60 s request timeout, so a default client gets CALL_TIMEOUT before it gives up.
  callTimeoutMs: 55_000,
});

/** One queue and one upstream process per session; no global tool-call lock. */
export class SessionManager {
  constructor({
    upstreamFactory,
    maxSessions = sessionDefaults.maxSessions,
    maxQueue = sessionDefaults.maxQueue,
    idleTtlMs = sessionDefaults.idleTtlMs,
    callTimeoutMs = sessionDefaults.callTimeoutMs,
    startupTimeoutMs = 30_000,
    cleanupTimeoutMs = 5000,
    onClose = () => {},
    log = () => {},
    now = Date.now,
  } = {}) {
    if (typeof upstreamFactory !== 'function') throw new TypeError('upstreamFactory is required');
    if (typeof log !== 'function') throw new TypeError('log must be a function');
    for (const [key, value] of Object.entries({ maxSessions, maxQueue, idleTtlMs, callTimeoutMs, startupTimeoutMs, cleanupTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value < (key === 'maxQueue' ? 0 : 1)) {
        throw new TypeError(`${key} must be a positive integer`);
      }
    }
    Object.assign(this, { upstreamFactory, maxSessions, maxQueue, idleTtlMs, callTimeoutMs, startupTimeoutMs, cleanupTimeoutMs, onClose, log, now });
    this.sessions = new Map();
    // Closed session ID -> { why, at }, oldest first. Only the holder of an ID can ask, and it learns only why that one closed.
    this.retired = new Map();
    this.stopped = false;
    this.sweeper = setInterval(() => this.expireIdle(), Math.min(idleTtlMs, 30_000));
    this.sweeper.unref();
  }

  expired(record) {
    return record.state === 'ready' && record.pending === 0 && this.now() - record.lastUsed >= this.idleTtlMs;
  }

  expireIdle() {
    for (const record of this.sessions.values()) {
      if (this.expired(record)) void this.dispose(record, 'session expired').catch(() => {});
    }
  }

  /** Lifecycle metadata for the operator's log only: label and a short ID prefix, never arguments or results. */
  logEvent(event, record, details = {}) {
    // A broken custom log must never break session lifecycle (opening, timers, disposal, shutdown).
    try { this.log(event, { id: record.sessionId.slice(0, 6), label: record.label, ...details }); }
    catch (error) { process.emitWarning(`Session lifecycle log failed: ${error?.message ?? error}`); }
  }

  /** Session IDs are capabilities, so the caller gets slot counts and timing, never other sessions' IDs. */
  capacityError() {
    let busy = 0;
    let closing = 0;
    const idleMs = [];
    for (const record of this.sessions.values()) {
      if (record.state === 'closing') closing++;
      else if (record.state === 'ready' && record.pending === 0) idleMs.push(record.lastUsed + this.idleTtlMs - this.now());
      else busy++;
    }
    const parts = [`All ${this.maxSessions} session slots are in use: ${busy} busy, ${idleMs.length} idle, ${closing} closing.`];
    if (closing) parts.push('Closing slots free up within seconds.');
    if (idleMs.length) parts.push(`The soonest idle session expires in ${Math.max(1, Math.ceil(Math.min(...idleMs) / 1000))}s.`);
    parts.push(`${closing || idleMs.length ? 'Retry then' : 'Retry later'}, close any session you opened and no longer need (chrome_session action "close"), or ask the operator to raise --max-sessions or lower --idle-ttl-ms.`);
    return new BrokerError('CAPACITY', parts.join(' '));
  }

  async open({ label = 'agent' } = {}) {
    if (this.stopped) throw new BrokerError('SERVER_CLOSED', 'The broker is shutting down.');
    if (this.sessions.size >= this.maxSessions) {
      // Keep CAPACITY's advertised retry time true: an idle session past its TTL, or one already closing,
      // frees its slot now (each wait bounded by cleanupTimeoutMs) instead of at the next sweep.
      const freeing = [...this.sessions.values()].filter(record => record.state === 'closing' || this.expired(record));
      await Promise.all(freeing.map(record => this.dispose(record, 'session expired')));
      if (this.stopped) throw new BrokerError('SERVER_CLOSED', 'The broker is shutting down.');
    }
    if (this.sessions.size >= this.maxSessions) throw this.capacityError();
    const sessionId = randomBytes(24).toString('base64url');
    const record = {
      sessionId, label, state: 'starting', worker: null, pending: 0,
      active: false, tail: Promise.resolve(), lastUsed: this.now(),
      controller: new AbortController(), closePromise: null,
    };
    // Reserve capacity before the first await, including concurrent opens.
    this.sessions.set(sessionId, record);
    let timer;
    const creation = Promise.resolve().then(() => this.upstreamFactory({ sessionId, label, signal: record.controller.signal }));
    record.creation = creation;
    try {
      const worker = await Promise.race([
        creation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new BrokerError('STARTUP_TIMEOUT', 'Chrome worker initialization timed out.')), this.startupTimeoutMs);
          timer.unref();
        }),
      ]);
      if (record.state === 'closing' || this.stopped) {
        throw new BrokerError('SESSION_CLOSED', 'The session closed during initialization.');
      }
      record.worker = worker;
      record.state = 'ready';
      record.lastUsed = this.now();
      this.logEvent('session opened', record, { sessions: this.sessions.size, maxSessions: this.maxSessions });
      return { sessionId, label, idleTtlMs: this.idleTtlMs };
    } catch (error) {
      await this.dispose(record, 'worker start failed', {
        error: error?.code ?? 'ERROR', message: String(error?.message ?? error), ...(error?.stderr ? { stderr: error.stderr } : {}),
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** SESSION_NOT_FOUND, saying why the session closed if it closed recently; `unknown` is the message otherwise. */
  notFound(sessionId, unknown) {
    const entry = this.retired.get(sessionId);
    const why = entry && this.now() - entry.at < this.idleTtlMs ? closedBecause[entry.why] : undefined;
    return new BrokerError('SESSION_NOT_FOUND', why ? `Session closed: ${why} Open a new session.` : unknown);
  }

  record(sessionId, { touch = true } = {}) {
    const record = this.sessions.get(sessionId);
    if (!record || record.state !== 'ready') {
      throw this.notFound(sessionId, 'Session is closed, expired, or unknown. Open a new session.');
    }
    if (this.expired(record)) {
      void this.dispose(record, 'session expired').catch(() => {});
      throw new BrokerError('SESSION_EXPIRED', 'Session expired. Open a new session.');
    }
    if (touch) record.lastUsed = this.now();
    return record;
  }

  getInfo(sessionId) {
    const record = this.record(sessionId);
    return {
      sessionId, label: record.label, active: record.active,
      queued: Math.max(0, record.pending - Number(record.active)),
      idleTtlMs: this.idleTtlMs,
    };
  }

  async run(sessionId, operation, { signal } = {}) {
    if (signal?.aborted) throw new BrokerError('CANCELLED', 'Request was cancelled before it started.');
    const record = this.record(sessionId);
    if (record.pending >= this.maxQueue + 1) {
      throw new BrokerError('QUEUE_FULL', 'This session queue is full. Other sessions remain available.');
    }
    record.pending++;
    const task = record.tail.then(async () => {
      if (record.state !== 'ready') throw new BrokerError('SESSION_CLOSED', 'Session closed before the queued call started.');
      if (signal?.aborted) throw new BrokerError('CANCELLED', 'Queued request was cancelled.');
      record.active = true;
      const controller = new AbortController();
      let timer;
      const cancel = () => controller.abort(new BrokerError('CANCELLED', 'Active request cancelled; this session has been closed to prevent overlapping browser actions.'));
      const close = () => controller.abort(new BrokerError('SESSION_CLOSED', 'Session closed during the request.'));
      signal?.addEventListener('abort', cancel, { once: true });
      record.controller.signal.addEventListener('abort', close, { once: true });
      let onAbort;
      try {
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        timer = setTimeout(() => {
          this.logEvent('call timed out', record, { callTimeoutMs: this.callTimeoutMs });
          controller.abort(new BrokerError('CALL_TIMEOUT', 'Upstream call timed out. Its outcome may be unknown; the session was closed. Do not automatically retry a side effect.'));
        }, this.callTimeoutMs);
        timer.unref();
        // A timed-out/cancelled operation never releases its live worker to the next call.
        return await Promise.race([
          Promise.resolve().then(() => operation(record.worker, { signal: controller.signal, timeoutMs: this.callTimeoutMs })),
          aborted,
        ]);
      } catch (error) {
        if (controller.signal.aborted || error?.code === 'UPSTREAM_DISCONNECTED') {
          await this.dispose(record, 'session retired', { reason: controller.signal.reason?.code ?? error.code });
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        record.controller.signal.removeEventListener('abort', close);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        record.active = false;
      }
    });
    const settled = task.finally(() => {
      record.pending--;
      record.lastUsed = this.now();
    });
    record.tail = settled.catch(() => {});
    return settled;
  }

  async closeSession(sessionId) {
    const record = this.sessions.get(sessionId);
    if (!record) throw this.notFound(sessionId, 'Session is already closed, expired, or unknown.');
    await this.dispose(record, 'session closed', { reason: 'client' });
    return { closed: true };
  }

  /** Idempotent; only the first call's event is logged, so each session ends with one reason. */
  dispose(record, event, details) {
    if (record.closePromise) return record.closePromise;
    const why = details?.reason ?? event;
    if (record.state === 'ready' && closedBecause[why]) {
      this.retired.set(record.sessionId, { why, at: this.now() });
      if (this.retired.size > retiredMemory) this.retired.delete(this.retired.keys().next().value);
    }
    record.state = 'closing';
    this.logEvent(event, record, details);
    record.controller.abort();
    this.onClose(record.sessionId);
    const cleanup = (async () => {
      // Keep capacity reserved while a cancelled startup is still reaping its
      // subprocess. Late successful startups are closed before releasing it.
      const worker = record.worker ?? await record.creation?.catch(() => null);
      // A failed close (e.g. its temp dir could not be removed) is logged; the slot is still released,
      // since nothing more will run for this worker.
      try { if (worker) await worker.close(); }
      catch (error) { this.logEvent('worker close failed', record, { error: error?.code ?? 'ERROR', message: String(error?.message ?? error) }); }
      this.sessions.delete(record.sessionId);
    })();
    // A broken custom factory must not hang a caller forever. Its closing slot
    // stays reserved until actual cleanup completes (including after this wait).
    record.closePromise = (async () => {
      let timer;
      try {
        await Promise.race([cleanup, new Promise(resolve => {
          timer = setTimeout(resolve, this.cleanupTimeoutMs);
          timer.unref();
        })]);
      } finally { clearTimeout(timer); }
    })();
    return record.closePromise;
  }

  async close() {
    this.stopped = true;
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.sessions.values()].map(record => this.dispose(record, 'session closed', { reason: 'shutdown' })));
  }
}

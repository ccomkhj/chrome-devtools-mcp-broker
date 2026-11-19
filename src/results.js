import { randomBytes } from 'node:crypto';

/** A small, deliberately coded error safe to present through an MCP tool. */
export class ResultError extends Error {
  constructor(code, message) {
    super(message.slice(0, 300));
    this.name = 'ResultError';
    this.code = code;
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ResultError('INVALID_RESULT_CONFIG', `${label} must be a positive integer.`);
  }
}

/**
 * Stores immutable snapshots of upstream results, scoped to a browser session.
 * Byte limits count serialized UTF-8 bytes, not total V8 heap consumption;
 * maxEntries independently bounds per-entry metadata overhead. TTL is absolute
 * from insertion; a successful get refreshes LRU order, not expiry.
 */
export class ResultStore {
  #entries = new Map();
  #bytes = 0;
  #maxBytes;
  #maxEntryBytes;
  #maxEntries;
  #ttlMs;
  #now;

  constructor({
    maxBytes = 64 * 1024 * 1024,
    maxEntryBytes = 16 * 1024 * 1024,
    maxEntries = 1024,
    ttlMs = 600_000,
    now = Date.now,
  } = {}) {
    positiveInteger(maxBytes, 'maxBytes');
    positiveInteger(maxEntryBytes, 'maxEntryBytes');
    positiveInteger(maxEntries, 'maxEntries');
    positiveInteger(ttlMs, 'ttlMs');
    if (typeof now !== 'function') {
      throw new ResultError('INVALID_RESULT_CONFIG', 'now must be a function.');
    }
    this.#maxBytes = maxBytes;
    this.#maxEntryBytes = maxEntryBytes;
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  #remove(resultId) {
    const entry = this.#entries.get(resultId);
    if (!entry) return;
    this.#bytes -= entry.bytes;
    this.#entries.delete(resultId);
  }

  #prune() {
    const now = this.#now();
    for (const [resultId, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#remove(resultId);
    }
  }

  put(sessionId, upstreamResult) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) {
      throw new ResultError('INVALID_SESSION', 'A valid session ID is required.');
    }
    let serialized;
    try {
      serialized = JSON.stringify(upstreamResult);
    } catch {
      throw new ResultError('INVALID_RESULT', 'Upstream result must be JSON serializable.');
    }
    if (serialized === undefined) {
      throw new ResultError('INVALID_RESULT', 'Upstream result must be JSON serializable.');
    }
    const bytes = Buffer.byteLength(serialized, 'utf8');
    this.#prune();
    if (bytes > this.#maxEntryBytes || bytes > this.#maxBytes) {
      return { stored: false, reason: 'result_too_large' };
    }
    while (this.#bytes + bytes > this.#maxBytes || this.#entries.size >= this.#maxEntries) {
      this.#remove(this.#entries.keys().next().value);
    }
    const resultId = `r_${randomBytes(16).toString('base64url')}`;
    this.#entries.set(resultId, {
      sessionId,
      serialized,
      bytes,
      expiresAt: this.#now() + this.#ttlMs,
    });
    this.#bytes += bytes;
    return { resultId, stored: true };
  }

  get(sessionId, resultId) {
    this.#prune();
    const entry = this.#entries.get(resultId);
    // Foreign and missing IDs intentionally have the same response.
    if (!entry || entry.sessionId !== sessionId) {
      throw new ResultError('RESULT_NOT_FOUND', 'Result is unavailable, expired, or belongs to another session.');
    }
    this.#entries.delete(resultId);
    this.#entries.set(resultId, entry);
    return JSON.parse(entry.serialized);
  }

  deleteSession(sessionId) {
    let deleted = 0;
    for (const [resultId, entry] of this.#entries) {
      if (entry.sessionId === sessionId) {
        this.#remove(resultId);
        deleted += 1;
      }
    }
    return deleted;
  }

  clear() {
    this.#entries.clear();
    this.#bytes = 0;
  }

  stats() {
    this.#prune();
    return {
      entries: this.#entries.size,
      bytes: this.#bytes,
      maxBytes: this.#maxBytes,
      maxEntryBytes: this.#maxEntryBytes,
      maxEntries: this.#maxEntries,
      ttlMs: this.#ttlMs,
    };
  }
}

function jsonPointer(value, pointer) {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 2048) {
    throw new ResultError('INVALID_SELECTION', 'select must be an RFC 6901 JSON pointer, such as /structuredContent/items.');
  }
  for (const encoded of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/u.test(encoded)) {
      throw new ResultError('INVALID_SELECTION', 'JSON pointer escapes must be ~0 or ~1.');
    }
    const key = encoded.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new ResultError('INVALID_SELECTION', 'Prototype-related paths are not supported.');
    }
    if (value === null || typeof value !== 'object'
      || (Array.isArray(value) && !/^(0|[1-9]\d*)$/u.test(key))
      || !Object.hasOwn(value, key)) {
      throw new ResultError('INVALID_SELECTION', 'The selected path does not exist in this result.');
    }
    value = value[key];
  }
  return value;
}

function approximateDecodedBytes(data) {
  if (typeof data !== 'string') return undefined;
  return Math.max(0, Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0));
}

// Only MCP binary blocks are redacted: page text and selected JSON fields are
// otherwise preserved. Explicit selection of a binary scalar is an opt-in read.
function jsonWithoutMedia(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && (item.type === 'image' || item.type === 'audio')) {
      if (typeof item.data === 'string') {
        return { type: item.type, mimeType: item.mimeType, dataOmitted: true, bytes: approximateDecodedBytes(item.data) };
      }
    }
    if (item && typeof item === 'object' && typeof item.blob === 'string'
      && typeof item.uri === 'string') {
      return { uri: item.uri, mimeType: item.mimeType, blobOmitted: true, bytes: approximateDecodedBytes(item.blob) };
    }
    return item;
  });
}

function bodyOf(rawResult, select) {
  if (select !== undefined) {
    const value = jsonPointer(rawResult, select);
    return typeof value === 'string' ? value : jsonWithoutMedia(value) ?? '';
  }
  const textBlocks = rawResult.content?.filter(block => block?.type === 'text' && typeof block.text === 'string') ?? [];
  if (textBlocks.length) return textBlocks.map(block => block.text).join('\n');
  if (rawResult.structuredContent !== undefined) return jsonWithoutMedia(rawResult.structuredContent) ?? '';
  return jsonWithoutMedia(rawResult.content ?? []) ?? '';
}

function filteredBody(text, filter) {
  const lines = text.split('\n');
  const needle = filter.toLowerCase();
  const selected = new Set();
  let matchedLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].toLowerCase().includes(needle)) continue;
    matchedLines += 1;
    for (let neighbor = Math.max(0, index - 1); neighbor <= Math.min(lines.length - 1, index + 1); neighbor += 1) {
      selected.add(neighbor);
    }
  }
  return {
    text: [...selected].sort((a, b) => a - b).map(index => lines[index]).join('\n'),
    matchedLines,
  };
}

function splitsSurrogatePair(text, index) {
  if (index <= 0 || index >= text.length) return false;
  const previous = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF;
}

/**
 * Returns one compact JSON text block, plus at most one explicitly requested
 * image. maxChars bounds the serialized text block (UTF-16 code units), including
 * metadata and JSON escaping. Image bytes and the outer MCP envelope are outside
 * this text budget. Follow nextOffset with the same select/filter to page safely.
 */
export function renderResult(rawResult, options = {}) {
  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)
    || (rawResult.content !== undefined && !Array.isArray(rawResult.content))) {
    throw new ResultError('INVALID_RESULT', 'Upstream result must be an MCP result object.');
  }
  const { maxChars = 6000, offset = 0, select, filter, includeImages = false } = options;
  if (!Number.isSafeInteger(maxChars) || maxChars < 512 || maxChars > 32_000) {
    throw new ResultError('BAD_OUTPUT_OPTION', 'maxChars must be an integer from 512 to 32000.');
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ResultError('BAD_OUTPUT_OPTION', 'offset must be a non-negative integer.');
  }
  if (typeof includeImages !== 'boolean') {
    throw new ResultError('BAD_OUTPUT_OPTION', 'includeImages must be a boolean.');
  }
  if (filter !== undefined && (typeof filter !== 'string' || filter.length === 0 || filter.length > 256)) {
    throw new ResultError('BAD_OUTPUT_OPTION', 'filter must contain 1 to 256 characters.');
  }
  if (options.resultId !== undefined && (typeof options.resultId !== 'string' || options.resultId.length > 128)) {
    throw new ResultError('BAD_OUTPUT_OPTION', 'resultId must be a string of at most 128 characters.');
  }
  let body = bodyOf(rawResult, select);
  const metadata = { ok: rawResult.isError !== true };
  if (options.resultId !== undefined) metadata.resultId = options.resultId;
  if (options.stored !== undefined) metadata.stored = Boolean(options.stored);
  if (options.stored === false && typeof options.reason === 'string') metadata.reason = options.reason.slice(0, 80);
  if (filter !== undefined) {
    const filtered = filteredBody(body, filter);
    body = filtered.text;
    metadata.filtered = true;
    metadata.matchedLines = filtered.matchedLines;
  }
  if (offset > body.length || splitsSurrogatePair(body, offset)) {
    throw new ResultError('BAD_OUTPUT_OPTION', 'offset is outside this view or splits a Unicode character.');
  }
  const images = (rawResult.content ?? []).filter(block => block?.type === 'image');
  const image = includeImages ? images.find(block => typeof block.data === 'string' && typeof block.mimeType === 'string') : undefined;
  if (images.length) metadata.imagesOmitted = images.length - (image ? 1 : 0);
  if (metadata.imagesOmitted && !includeImages && options.stored !== false) {
    metadata.hint = 'Use chrome_read with includeImages:true to get the image.';
  }

  const encode = end => JSON.stringify({
    ...metadata,
    data: body.slice(offset, end),
    totalChars: body.length,
    offset,
    ...(end < body.length ? { nextOffset: end } : {}),
    truncated: end < body.length,
  });

  let end = Math.min(body.length, offset + maxChars);
  if (splitsSurrogatePair(body, end)) end -= 1;
  let serialized = encode(end);
  if (serialized.length > maxChars) {
    let low = offset;
    let high = end;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encode(middle).length <= maxChars) low = middle;
      else high = middle - 1;
    }
    end = low;
    if (splitsSurrogatePair(body, end)) end -= 1;
    serialized = encode(end);
  }
  if (serialized.length > maxChars || (end === offset && end < body.length)) {
    throw new ResultError('BAD_OUTPUT_OPTION', 'The response metadata exceeds maxChars; increase the budget.');
  }
  const content = [{ type: 'text', text: serialized }];
  if (image) content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
  return { content, isError: rawResult.isError === true };
}

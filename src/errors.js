export class BrokerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
  }
}

export function errorResult(error, { maxChars = 2048, extras = {} } = {}) {
  const code = typeof error?.code === 'string' ? error.code.slice(0, 80) : 'UPSTREAM_ERROR';
  const message = String(error?.message ?? error).slice(0, 1600);
  const encode = end => JSON.stringify({ ok: false, ...extras, error: { code, message: message.slice(0, end) } });
  let low = 0;
  let high = message.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encode(mid).length <= maxChars) low = mid;
    else high = mid - 1;
  }
  return {
    isError: true,
    content: [{ type: 'text', text: encode(low) }],
  };
}

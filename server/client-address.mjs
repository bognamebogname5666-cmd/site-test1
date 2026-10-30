import { isIP } from 'node:net';

/** Canonical IP literals only: no host names, ports, CIDRs, or IPv6 zone IDs. */
function normalizeAddress(value) {
  if (typeof value !== 'string' || value.includes('%') || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(address);
  if (!mapped) return address;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Build once at startup. TRUSTED_PROXIES is an exact IP allowlist, comma-separated
 * in the environment or an array in createApp(). Empty means trust no proxies.
 * Every trusted proxy must append the actual peer IP or overwrite X-Forwarded-For.
 * Walk from the socket towards the client, stopping at the first untrusted hop;
 * attacker-controlled entries further left never determine the rate-limit key.
 * Invalid or excessive chains fail closed to the socket address.
 * @param {string | string[]} configuration
 * @returns {(request: import('node:http').IncomingMessage) => string}
 */
export function createClientAddressResolver(configuration = '') {
  const entries = typeof configuration === 'string' ? configuration.split(',').map(value => value.trim()).filter(Boolean) : configuration;
  if (!Array.isArray(entries)) throw new TypeError('TRUSTED_PROXIES / trustedProxies must contain exact IP addresses.');
  const trusted = new Set(entries.map(value => {
    const normalized = normalizeAddress(value);
    if (!normalized) throw new TypeError('TRUSTED_PROXIES / trustedProxies must contain exact IP addresses.');
    return normalized;
  }));
  return request => {
    const socket = normalizeAddress(request.socket.remoteAddress) || 'unknown';
    const header = request.headers['x-forwarded-for'];
    if (!trusted.has(socket) || typeof header !== 'string' || header.length > 4096) return socket;
    const chain = header.split(',').map(value => normalizeAddress(value.trim()));
    if (chain.length > 32 || chain.some(value => value === null)) return socket;
    let address = socket;
    for (let index = chain.length - 1; index >= 0 && trusted.has(address); index--) address = chain[index];
    return address;
  };
}

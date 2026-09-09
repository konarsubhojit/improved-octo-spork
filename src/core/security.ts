import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export function generateHeartbeatCredential(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashHeartbeatToken(token) };
}

export function hashHeartbeatToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashHeartbeatToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validateProbeUrl(raw: string, deniedHosts: readonly string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RangeError('Malformed target URL');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    url.protocol !== 'https:' ||
    url.port && url.port !== '443' ||
    url.username ||
    url.password ||
    url.pathname !== '/' && url.pathname !== '' ||
    url.search ||
    url.hash
  ) {
    throw new RangeError('Targets must be exact-host HTTPS URLs on port 443 without credentials, query, or fragment');
  }
  if (!hostname.includes('.') || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new RangeError('Internal and single-label hostnames are denied');
  }
  if (isIP(hostname)) throw new RangeError('Targets must use an authorized hostname, not an IP literal');
  if (deniedHosts.some((value) => hostname === value || hostname.endsWith(`.${value}`))) {
    throw new RangeError('Configured deployment and internal destinations are denied');
  }
  return url;
}

function publicIpv4(address: string): boolean {
  const values = address.split('.').map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a = 0, b = 0, c = 0] = values;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function assertPublicAddresses(addresses: readonly string[]): void {
  if (addresses.length === 0) throw new RangeError('Target hostname did not resolve');
  for (const address of addresses) {
    const version = isIP(address);
    const normalized = address.toLowerCase();
    if (version === 4 && publicIpv4(address)) continue;
    if (
      version === 6 &&
      /^(2|3)[0-9a-f]{3}:/.test(normalized) &&
      !normalized.includes('::ffff:') &&
      normalized !== '2001:db8::1'
    ) continue;
    throw new RangeError('Every resolved address must be public global unicast');
  }
}

export interface HeartbeatReceipt {
  receivedAt: number;
  eventId?: string;
}

export class HeartbeatLedger {
  #events = new Map<string, HeartbeatReceipt>();
  lastReceipt?: HeartbeatReceipt;

  receive(receivedAt: number, eventId?: string): { duplicate: boolean; receipt: HeartbeatReceipt } {
    if (eventId && (eventId.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(eventId))) throw new RangeError('Invalid event ID');
    const duplicate = eventId ? this.#events.get(eventId) : undefined;
    if (duplicate) return { duplicate: true, receipt: duplicate };
    const receipt: HeartbeatReceipt = eventId === undefined ? { receivedAt } : { receivedAt, eventId };
    if (eventId) this.#events.set(eventId, receipt);
    this.lastReceipt = receipt;
    return { duplicate: false, receipt };
  }
}

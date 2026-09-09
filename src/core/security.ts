import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

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

export function assertPublicAddresses(addresses: readonly string[]): void {
  if (addresses.length === 0) throw new RangeError('Target hostname did not resolve');
  for (const address of addresses) {
    if (!ipaddr.isValid(address)) throw new RangeError('Every resolved address must be a valid IP address');
    const parsed = ipaddr.parse(address);
    if (parsed.range() === 'unicast') continue;
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

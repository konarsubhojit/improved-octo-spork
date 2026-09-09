import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();
const token = () => randomBytes(32).toString('base64url');

export interface Invite {
  workspaceId: string;
  email: string;
  tokenHash: Buffer;
  expiresAt: number;
  usedAt?: number;
}

export interface Session {
  userId: string;
  workspaceId: string;
  tokenHash: Buffer;
  csrfHash: Buffer;
  expiresAt: number;
  revokedAt?: number;
}

export function issueInvite(workspaceId: string, email: string, expiresAt: number): { invite: Invite; token: string } {
  const raw = token();
  return {
    token: raw,
    invite: { workspaceId, email: normalizeEmail(email), tokenHash: digest(raw), expiresAt }
  };
}

export function consumeInvite(invite: Invite, raw: string, now: number): Invite {
  if (invite.usedAt !== undefined || invite.expiresAt <= now || !safeEqual(digest(raw), invite.tokenHash)) {
    throw new Error('Invite is invalid or expired');
  }
  return { ...invite, usedAt: now };
}

export function issueSession(
  userId: string,
  workspaceId: string,
  expiresAt: number
): { session: Session; sessionToken: string; csrfToken: string } {
  const sessionToken = token();
  const csrfToken = token();
  return {
    sessionToken,
    csrfToken,
    session: {
      userId,
      workspaceId,
      tokenHash: digest(sessionToken),
      csrfHash: digest(csrfToken),
      expiresAt
    }
  };
}

export function authenticate(
  session: Session,
  sessionToken: string,
  now: number,
  csrfToken?: string,
  mutating = false
): Pick<Session, 'userId' | 'workspaceId'> {
  if (session.revokedAt !== undefined || session.expiresAt <= now || !safeEqual(digest(sessionToken), session.tokenHash)) {
    throw new Error('Unauthenticated');
  }
  if (mutating && (!csrfToken || !safeEqual(digest(csrfToken), session.csrfHash))) throw new Error('Invalid CSRF token');
  return { userId: session.userId, workspaceId: session.workspaceId };
}

export function assertTenant(contextWorkspaceId: string, entityWorkspaceId: string): void {
  if (contextWorkspaceId !== entityWorkspaceId) throw new Error('Not found');
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,253}$/.test(email) || email.length > 254) throw new RangeError('Invalid email address');
  return email;
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

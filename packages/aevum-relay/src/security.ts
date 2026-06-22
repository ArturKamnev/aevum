import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type AccessTokenClaims = {
  version: 1;
  devicePublicId: string;
  clientId: string;
  grantId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
};

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function safeHashEqual(value: string, expectedHash: string, secret: string) {
  const actual = Buffer.from(hashSecret(value, secret));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function signAccessToken(claims: AccessTokenClaims, signingSecret: string) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", signingSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyAccessToken(token: string, signingSecret: string, now = Date.now()): AccessTokenClaims | undefined {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return undefined;
  const expected = createHmac("sha256", signingSecret).update(payload).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessTokenClaims;
    if (claims.version !== 1 || !Array.isArray(claims.scopes) || claims.expiresAt <= now) return undefined;
    if (!claims.devicePublicId || !claims.clientId || !claims.grantId) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

export function verifyPkceS256(verifier: string, challenge: string) {
  const actual = createHash("sha256").update(verifier).digest("base64url");
  const left = Buffer.from(actual);
  const right = Buffer.from(challenge);
  return left.length === right.length && timingSafeEqual(left, right);
}

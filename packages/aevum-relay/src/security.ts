import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type AccessTokenClaims = {
  version: 1;
  devicePublicId: string;
  clientId: string;
  grantId: string;
  grantVersion?: number;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  issuer?: string;
  audience?: string;
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

export type AccessTokenVerification = { ok: true; claims: AccessTokenClaims } | { ok: false; reason: "malformed" | "invalid_signature" | "invalid_claims" | "expired" | "issuer_mismatch" | "audience_mismatch" };

export function verifyAccessTokenDetailed(token: string, signingSecret: string, now = Date.now(), expectedClaims?: { issuer: string; audience: string }): AccessTokenVerification {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", signingSecret).update(payload).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, reason: "invalid_signature" };
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessTokenClaims;
    if (claims.version !== 1 || !Array.isArray(claims.scopes) || (claims.grantVersion !== undefined && (!Number.isInteger(claims.grantVersion) || claims.grantVersion < 1))) return { ok: false, reason: "invalid_claims" };
    if (!claims.devicePublicId || !claims.clientId || !claims.grantId || !Number.isFinite(claims.issuedAt) || !Number.isFinite(claims.expiresAt)) return { ok: false, reason: "invalid_claims" };
    if (claims.expiresAt <= now) return { ok: false, reason: "expired" };
    if (expectedClaims && claims.issuer !== expectedClaims.issuer) return { ok: false, reason: "issuer_mismatch" };
    if (expectedClaims && claims.audience !== expectedClaims.audience) return { ok: false, reason: "audience_mismatch" };
    return { ok: true, claims: { ...claims, grantVersion: claims.grantVersion ?? 1 } };
  } catch {
    return { ok: false, reason: "invalid_claims" };
  }
}

export function verifyAccessToken(token: string, signingSecret: string, now = Date.now(), expectedClaims?: { issuer: string; audience: string }): AccessTokenClaims | undefined {
  const result = verifyAccessTokenDetailed(token, signingSecret, now, expectedClaims);
  return result.ok ? result.claims : undefined;
}

export function verifyPkceS256(verifier: string, challenge: string) {
  const actual = createHash("sha256").update(verifier).digest("base64url");
  const left = Buffer.from(actual);
  const right = Buffer.from(challenge);
  return left.length === right.length && timingSafeEqual(left, right);
}

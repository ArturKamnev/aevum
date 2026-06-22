import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  AEVUM_RELAY_PUBLIC_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  AEVUM_RELAY_SIGNING_SECRET: z.string().min(32),
  AEVUM_RELAY_TOKEN_SECRET: z.string().min(32),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type RelayConfig = ReturnType<typeof readRelayConfig>;

export function readRelayConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const origin = new URL(parsed.AEVUM_RELAY_PUBLIC_ORIGIN);
  if (origin.protocol !== "https:" && parsed.NODE_ENV === "production") throw new Error("AEVUM_RELAY_PUBLIC_ORIGIN must use HTTPS in production.");
  if ((origin.pathname !== "/" && origin.pathname !== "") || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("AEVUM_RELAY_PUBLIC_ORIGIN must be an origin without a path.");
  }
  return {
    port: parsed.PORT,
    publicOrigin: origin.origin,
    databaseUrl: parsed.DATABASE_URL,
    signingSecret: parsed.AEVUM_RELAY_SIGNING_SECRET,
    tokenSecret: parsed.AEVUM_RELAY_TOKEN_SECRET,
    nodeEnv: parsed.NODE_ENV,
  };
}

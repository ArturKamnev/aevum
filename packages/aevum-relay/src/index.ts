import { readRelayConfig } from "./config.js";
import { createDatabase, migrateDatabase } from "./database.js";
import { createRelayServer } from "./server.js";

const config = readRelayConfig();
const database = createDatabase(config);
await migrateDatabase(database);
const relay = createRelayServer(config, database);

relay.server.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: "info", event: "relay_ready", port: config.port })}\n`);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: "info", event: "relay_shutdown", signal })}\n`);
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();
  await relay.shutdown();
  clearTimeout(forced);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: "error", event: "uncaught_exception", error: error.name })}\n`);
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", () => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: "error", event: "unhandled_rejection" })}\n`);
});

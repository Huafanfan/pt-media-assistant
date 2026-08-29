import { PairingService } from "./auth.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function startServer(): Promise<{ close: () => Promise<void> }> {
  const config = loadConfig();
  const pairing = new PairingService({ pairingCode: config.pairingCode || undefined });
  const app = await createApp({ config, pairing });
  await app.listen({ host: config.host, port: config.port });

  if (!config.trustLan) {
    // Pairing remains available as an opt-out fallback for deployments that
    // explicitly disable trusted-LAN auto sessions.
    process.stdout.write(`PT Media Assistant pairing code: ${pairing.pairingCode}\n`);
  } else {
    process.stdout.write("PT Media Assistant trusted-LAN access enabled\n");
  }
  process.stdout.write(`PT Media Assistant listening on ${config.host}:${config.port}\n`);

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  const onSignal = (): void => {
    void close().finally(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startServer().catch(() => {
    // Keep boot failures generic: configuration may contain provider URLs or
    // other sensitive details that should never be emitted to stdout/stderr.
    process.stderr.write("PT Media Assistant failed to start\n");
    process.exitCode = 1;
  });
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverProwlarrApiKey, loadConfig } from "../../src/server/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("container configuration", () => {
  it("selects the IVAN URL and key as a pair without cross-gateway fallback", () => {
    const legacy = { TRANS_STATION_BASE_URL: 'https://legacy.example/v1', TRANS_STATION_API_KEY: 'legacy-test-key' };
    expect(loadConfig({ ...legacy, IVAN_ONLINE_API_URL: 'https://preferred.example/v1/chat/completions', IVAN_ONLINE_API_KEY: 'preferred-test-key' }))
      .toMatchObject({ aiBaseUrl: 'https://preferred.example/v1/chat/completions', aiApiKey: 'preferred-test-key' });
    expect(loadConfig({ ...legacy, IVAN_ONLINE_API_URL: 'https://preferred.example/v1' }).aiApiKey).toBeUndefined();
    expect(loadConfig({ ...legacy, IVAN_ONLINE_API_KEY: 'preferred-test-key' }).aiBaseUrl).toBeUndefined();
    expect(loadConfig(legacy)).toMatchObject({ aiBaseUrl: legacy.TRANS_STATION_BASE_URL, aiApiKey: legacy.TRANS_STATION_API_KEY });
  });

  it("reads a mounted IVAN secret without using a legacy key", async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ivan-secret-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'key');
    await writeFile(file, 'preferred-file-key\n', { mode: 0o600 });
    expect(loadConfig({ IVAN_ONLINE_API_URL: 'https://preferred.example/v1', IVAN_ONLINE_API_KEY_FILE: file, TRANS_STATION_API_KEY: 'legacy-test-key' }).aiApiKey).toBe('preferred-file-key');
  });
  it("reads the Prowlarr API key from a mounted secret file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pt-media-config-"));
    temporaryDirectories.push(directory);
    const secretPath = join(directory, "prowlarr_api_key");
    await writeFile(secretPath, "test-only-secret\n", { mode: 0o600 });

    expect(discoverProwlarrApiKey({ PROWLARR_API_KEY_FILE: secretPath }, "/missing/config.xml"))
      .toBe("test-only-secret");

    const proxyTokenPath = join(directory, "prowlarr_proxy_token");
    await writeFile(proxyTokenPath, "test-only-proxy-token\n", { mode: 0o600 });
    expect(loadConfig({ PROWLARR_PROXY_TOKEN_FILE: proxyTokenPath }).prowlarrProxyToken)
      .toBe("test-only-proxy-token");
  });

  it("configures sentinel mode with a validated hidden marker", () => {
    const config = loadConfig({
      PT_MEDIA_NAS_PATH: "/Volumes/YourNAS/pt",
      PT_MEDIA_NAS_CHECK_MODE: "sentinel",
      PT_MEDIA_NAS_SENTINEL: ".container-mounted",
      PT_MEDIA_NAS_SENTINEL_PATH: "/run/pt-media-nas-sentinel",
      PT_MEDIA_NAS_STATUS_PATH: "/run/pt-media-nas-status",
    });

    expect(config).toMatchObject({
      nasCheckMode: "sentinel",
      nasSentinelName: ".container-mounted",
      nasSentinelPath: "/run/pt-media-nas-sentinel",
      nasStatusPath: "/run/pt-media-nas-status",
    });
  });

  it("rejects unsafe sentinel names and unknown check modes", () => {
    expect(() => loadConfig({ PT_MEDIA_NAS_SENTINEL: "../escape" })).toThrow();
    expect(() => loadConfig({ PT_MEDIA_NAS_SENTINEL_PATH: "relative/sentinel" })).toThrow();
    expect(() => loadConfig({ PT_MEDIA_NAS_STATUS_PATH: "relative/status" })).toThrow();
    expect(() => loadConfig({ PT_MEDIA_NAS_CHECK_MODE: "directory-only" })).toThrow();
  });
});

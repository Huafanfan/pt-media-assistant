import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverProwlarrApiKey, loadConfig } from "../../src/server/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("container configuration", () => {
  it("selects the DeepSeek URL and token as a pair before either legacy gateway", () => {
    const legacy = {
      TRANS_STATION_BASE_URL: "https://legacy.example/v1",
      TRANS_STATION_API_KEY: "legacy-test-key",
      IVAN_ONLINE_API_URL: "https://ivan.example/v1",
      IVAN_ONLINE_API_KEY: "ivan-test-key",
    };
    expect(
      loadConfig({
        ...legacy,
        DS_BASE_URL: "https://api.deepseek.example/v1",
        DS_AUTH_TOKEN: "deepseek-test-token",
      }),
    ).toMatchObject({
      aiBaseUrl: "https://api.deepseek.example/v1",
      aiApiKey: "deepseek-test-token",
      aiModel: "deepseek-flash",
    });
    const missingToken = loadConfig({
      ...legacy,
      DS_BASE_URL: "https://api.deepseek.example/v1",
    });
    expect(missingToken.aiBaseUrl).toBe("https://api.deepseek.example/v1");
    expect(missingToken.aiApiKey).toBeUndefined();
    const missingUrl = loadConfig({
      ...legacy,
      DS_AUTH_TOKEN: "deepseek-test-token",
    });
    expect(missingUrl.aiBaseUrl).toBeUndefined();
    expect(missingUrl.aiApiKey).toBe("deepseek-test-token");
  });

  it("selects the IVAN URL and key as a pair without cross-gateway fallback", () => {
    const legacy = {
      TRANS_STATION_BASE_URL: "https://legacy.example/v1",
      TRANS_STATION_API_KEY: "legacy-test-key",
    };
    expect(
      loadConfig({
        ...legacy,
        IVAN_ONLINE_API_URL: "https://preferred.example/v1/chat/completions",
        IVAN_ONLINE_API_KEY: "preferred-test-key",
      }),
    ).toMatchObject({
      aiBaseUrl: "https://preferred.example/v1/chat/completions",
      aiApiKey: "preferred-test-key",
    });
    expect(
      loadConfig({
        ...legacy,
        IVAN_ONLINE_API_URL: "https://preferred.example/v1",
      }).aiApiKey,
    ).toBeUndefined();
    expect(
      loadConfig({ ...legacy, IVAN_ONLINE_API_KEY: "preferred-test-key" })
        .aiBaseUrl,
    ).toBeUndefined();
    expect(loadConfig(legacy)).toMatchObject({
      aiBaseUrl: legacy.TRANS_STATION_BASE_URL,
      aiApiKey: legacy.TRANS_STATION_API_KEY,
    });
  });

  it("reads a mounted IVAN secret without using a legacy key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ivan-secret-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "key");
    await writeFile(file, "preferred-file-key\n", { mode: 0o600 });
    expect(
      loadConfig({
        IVAN_ONLINE_API_URL: "https://preferred.example/v1",
        IVAN_ONLINE_API_KEY_FILE: file,
        TRANS_STATION_API_KEY: "legacy-test-key",
      }).aiApiKey,
    ).toBe("preferred-file-key");
  });

  it("reads a mounted DeepSeek token without using either legacy key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepseek-secret-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "token");
    await writeFile(file, "deepseek-file-token\n", { mode: 0o600 });
    expect(
      loadConfig({
        DS_BASE_URL: "https://api.deepseek.example/v1",
        DS_AUTH_TOKEN_FILE: file,
        IVAN_ONLINE_API_KEY: "ivan-test-key",
        TRANS_STATION_API_KEY: "legacy-test-key",
      }).aiApiKey,
    ).toBe("deepseek-file-token");
  });
  it("reads the Prowlarr API key from a mounted secret file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pt-media-config-"));
    temporaryDirectories.push(directory);
    const secretPath = join(directory, "prowlarr_api_key");
    await writeFile(secretPath, "test-only-secret\n", { mode: 0o600 });

    expect(
      discoverProwlarrApiKey(
        { PROWLARR_API_KEY_FILE: secretPath },
        "/missing/config.xml",
      ),
    ).toBe("test-only-secret");

    const proxyTokenPath = join(directory, "prowlarr_proxy_token");
    await writeFile(proxyTokenPath, "test-only-proxy-token\n", { mode: 0o600 });
    expect(
      loadConfig({ PROWLARR_PROXY_TOKEN_FILE: proxyTokenPath })
        .prowlarrProxyToken,
    ).toBe("test-only-proxy-token");
  });

  it("only enables durable state when a data directory is configured", () => {
    expect(loadConfig({}).dataDir).toBeUndefined();
    expect(loadConfig({ PT_MEDIA_DATA_DIR: "/data" }).dataDir).toBe("/data");
    expect(() => loadConfig({ PT_MEDIA_DATA_DIR: "relative/path" })).toThrow();
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
    expect(() =>
      loadConfig({ PT_MEDIA_NAS_SENTINEL_PATH: "relative/sentinel" }),
    ).toThrow();
    expect(() =>
      loadConfig({ PT_MEDIA_NAS_STATUS_PATH: "relative/status" }),
    ).toThrow();
    expect(() =>
      loadConfig({ PT_MEDIA_NAS_CHECK_MODE: "directory-only" }),
    ).toThrow();
  });
});

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

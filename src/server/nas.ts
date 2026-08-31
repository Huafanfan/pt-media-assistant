import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";

import type { NasStorageSummary } from "../shared/contracts.js";
import {
  DEFAULT_NAS_PATH,
  DEFAULT_NAS_SENTINEL_NAME,
  type NasCheckMode,
} from "./config.js";

const execFile = promisify(nodeExecFile);

export type MountEntry = {
  source: string;
  mountPoint: string;
  fileSystem: string;
  options: string[];
};

export type NasPreflight = {
  path: string;
  mounted: boolean;
  directoryExists: boolean;
  ready: boolean;
  mountPoint?: string;
  reason?: "mount-not-found" | "directory-not-found" | "mount-command-failed" | "sentinel-not-found" | "status-unavailable";
};

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number; shell: false },
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

type StatFsValue = number | bigint;

export type StatFsLike = {
  bsize: StatFsValue;
  blocks: StatFsValue;
  bfree?: StatFsValue;
  bavail?: StatFsValue;
};

export type StatFsFunction = (path: string) => Promise<StatFsLike>;

export type NasStatusSnapshot = {
  ready: boolean;
  updatedAt: number;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
};

export function parseNasStatusSnapshot(
  value: string,
  now = Date.now(),
  maxAgeMs = 30_000,
): NasStatusSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const updatedAt = Number(record.updatedAt);
  const totalBytes = Number(record.totalBytes);
  const usedBytes = Number(record.usedBytes);
  const freeBytes = Number(record.freeBytes);
  if (
    typeof record.ready !== "boolean"
    || !Number.isSafeInteger(updatedAt)
    || updatedAt < now - maxAgeMs
    || updatedAt > now + 5_000
    || ![totalBytes, usedBytes, freeBytes].every((item) => Number.isSafeInteger(item) && item >= 0)
    || usedBytes > totalBytes
    || freeBytes > totalBytes
  ) return undefined;
  return { ready: record.ready, updatedAt, totalBytes, usedBytes, freeBytes };
}

function unescapeMountPath(value: string): string {
  return value.replace(/\\040/gu, " ").replace(/\\011/gu, "\t").replace(/\\134/gu, "\\");
}

/** Parse Darwin mount output without invoking a shell or interpreting input. */
export function parseMountOutput(output: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const rawLine of output.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(.+?)\s+on\s+(.+?)\s+\(([^)]*)\)\s*$/u.exec(line);
    if (!match) continue;
    const options = match[3].split(",").map((option) => option.trim()).filter(Boolean);
    entries.push({
      source: unescapeMountPath(match[1]),
      mountPoint: unescapeMountPath(match[2]),
      fileSystem: options[0] ?? "",
      options,
    });
  }
  return entries;
}

function isAncestor(mountPoint: string, targetPath: string): boolean {
  const normalizedMount = mountPoint === "/" ? "/" : mountPoint.replace(/\/+$/u, "");
  const normalizedTarget = targetPath === "/" ? "/" : targetPath.replace(/\/+$/u, "");
  return normalizedTarget === normalizedMount || normalizedTarget.startsWith(`${normalizedMount}/`);
}

/** Return the longest active smbfs mount which contains the fixed target path. */
export function findSmbfsAncestor(entries: MountEntry[], targetPath: string): MountEntry | undefined {
  return entries
    .filter((entry) => entry.fileSystem.toLowerCase() === "smbfs" && isAncestor(entry.mountPoint, targetPath))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
}

export function isPathOnSmbfsMount(output: string, targetPath: string): boolean {
  return Boolean(findSmbfsAncestor(parseMountOutput(output), resolve(targetPath)));
}

export type NasGuardOptions = {
  checkMode?: NasCheckMode;
  execFile?: ExecFileLike;
  sentinelName?: string;
  sentinelPath?: string;
  statusFilePath?: string;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
  stat?: (path: string) => Promise<{ isDirectory(): boolean; isFile?(): boolean }>;
  statfs?: StatFsFunction;
  targetPath?: string;
};

export class NasGuard {
  public readonly targetPath: string;
  private readonly checkMode: NasCheckMode;
  private readonly runExecFile: ExecFileLike;
  private readonly sentinelName: string;
  private readonly sentinelPath: string;
  private readonly statusFilePath?: string;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly now: () => number;
  private readonly stat: (path: string) => Promise<{ isDirectory(): boolean; isFile?(): boolean }>;
  private readonly statfs: StatFsFunction;

  public constructor(options: NasGuardOptions = {}) {
    this.targetPath = resolve(options.targetPath ?? DEFAULT_NAS_PATH);
    this.checkMode = options.checkMode ?? "smbfs";
    this.runExecFile = options.execFile ?? (execFile as unknown as ExecFileLike);
    this.sentinelName = options.sentinelName ?? DEFAULT_NAS_SENTINEL_NAME;
    this.sentinelPath = options.sentinelPath
      ? resolve(options.sentinelPath)
      : resolve(this.targetPath, this.sentinelName);
    this.statusFilePath = options.statusFilePath ? resolve(options.statusFilePath) : undefined;
    this.readFile = options.readFile ?? (async (path: string) => fs.readFile(path, "utf8"));
    this.now = options.now ?? Date.now;
    this.stat = options.stat ?? (async (path: string) => fs.stat(path));
    this.statfs = options.statfs ?? (async (path: string) => fs.statfs(path, { bigint: true }));
  }

  private async statusSnapshot(): Promise<NasStatusSnapshot | undefined> {
    if (!this.statusFilePath) return undefined;
    try {
      return parseNasStatusSnapshot(await this.readFile(this.statusFilePath), this.now());
    } catch {
      return undefined;
    }
  }

  public async preflight(): Promise<NasPreflight> {
    if (this.checkMode === "sentinel") {
      let sentinelExists = false;
      try {
        sentinelExists = (await this.stat(this.sentinelPath)).isFile?.() ?? false;
      } catch {
        sentinelExists = false;
      }
      if (!sentinelExists) {
        return {
          path: this.targetPath,
          mounted: false,
          directoryExists: false,
          ready: false,
          reason: "sentinel-not-found",
        };
      }
      if (this.statusFilePath) {
        const status = await this.statusSnapshot();
        if (!status?.ready) {
          return {
            path: this.targetPath,
            mounted: false,
            directoryExists: false,
            ready: false,
            reason: "status-unavailable",
          };
        }
      }
      return {
        path: this.targetPath,
        mounted: true,
        directoryExists: true,
        ready: true,
        mountPoint: this.targetPath,
      };
    }

    let mountOutput: string;
    try {
      const result = await this.runExecFile("/sbin/mount", [], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        shell: false,
      });
      mountOutput = String(result.stdout);
    } catch {
      return {
        path: this.targetPath,
        mounted: false,
        directoryExists: false,
        ready: false,
        reason: "mount-command-failed",
      };
    }

    const mount = findSmbfsAncestor(parseMountOutput(mountOutput), this.targetPath);
    let directoryExists = false;
    try {
      directoryExists = (await this.stat(this.targetPath)).isDirectory();
    } catch {
      directoryExists = false;
    }

    if (!mount) {
      return {
        path: this.targetPath,
        mounted: false,
        directoryExists,
        ready: false,
        reason: "mount-not-found",
      };
    }
    if (!directoryExists) {
      return {
        path: this.targetPath,
        mounted: true,
        directoryExists: false,
        ready: false,
        mountPoint: mount.mountPoint,
        reason: "directory-not-found",
      };
    }
    return {
      path: this.targetPath,
      mounted: true,
      directoryExists: true,
      ready: true,
      mountPoint: mount.mountPoint,
    };
  }

  /**
   * Return capacity for the configured target only after the smbfs preflight
   * has established that the target is on a live mount and is a directory.
   * Capacity values are deliberately reduced to JSON-safe numbers here so a
   * BigInt statfs result can never escape into a response serializer.
   */
  public async storage(): Promise<NasStorageSummary> {
    const preflight = await this.preflight();
    const summary: NasStorageSummary = {
      mounted: preflight.mounted,
      ready: preflight.ready,
      path: this.targetPath,
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
    };

    if (!preflight.ready) return summary;

    if (this.statusFilePath) {
      const status = await this.statusSnapshot();
      if (!status?.ready) return { ...summary, mounted: false, ready: false };
      return {
        ...summary,
        totalBytes: status.totalBytes,
        usedBytes: status.usedBytes,
        freeBytes: status.freeBytes,
      };
    }

    let stats: StatFsLike;
    try {
      stats = await this.statfs(this.checkMode === "sentinel" ? this.sentinelPath : this.targetPath);
    } catch {
      // The mount can disappear between the preflight and statfs calls. Keep
      // the mount result for diagnostics but mark the storage as not ready.
      return { ...summary, ready: false };
    }

    const blockSize = toNonNegativeBigInt(stats.bsize);
    const total = blockSize * toNonNegativeBigInt(stats.blocks);
    // bavail is the capacity available to the app's (non-root) user. Older
    // injected statfs implementations may only expose bfree, so retain it as
    // a safe fallback for tests and alternate runtimes.
    const freeBlocks = stats.bavail ?? stats.bfree ?? 0;
    const free = blockSize * toNonNegativeBigInt(freeBlocks);
    const used = total > free ? total - free : 0n;

    return {
      ...summary,
      totalBytes: toJsonSafeNumber(total),
      usedBytes: toJsonSafeNumber(used),
      freeBytes: toJsonSafeNumber(free),
    };
  }
}

function toNonNegativeBigInt(value: StatFsValue): bigint {
  if (typeof value === "bigint") return value > 0n ? value : 0n;
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.floor(value));
}

function toJsonSafeNumber(value: bigint): number {
  const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > maxSafeInteger ? maxSafeInteger : value);
}

export const checkNasPreflight = (options: NasGuardOptions = {}): Promise<NasPreflight> =>
  new NasGuard(options).preflight();

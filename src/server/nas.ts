import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";

import type { NasStorageSummary } from "../shared/contracts.js";
import { DEFAULT_NAS_PATH } from "./config.js";

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
  reason?: "mount-not-found" | "directory-not-found" | "mount-command-failed";
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
  execFile?: ExecFileLike;
  stat?: (path: string) => Promise<{ isDirectory(): boolean }>;
  statfs?: StatFsFunction;
  targetPath?: string;
};

export class NasGuard {
  public readonly targetPath: string;
  private readonly runExecFile: ExecFileLike;
  private readonly stat: (path: string) => Promise<{ isDirectory(): boolean }>;
  private readonly statfs: StatFsFunction;

  public constructor(options: NasGuardOptions = {}) {
    this.targetPath = resolve(options.targetPath ?? DEFAULT_NAS_PATH);
    this.runExecFile = options.execFile ?? (execFile as unknown as ExecFileLike);
    this.stat = options.stat ?? (async (path: string) => fs.stat(path));
    this.statfs = options.statfs ?? (async (path: string) => fs.statfs(path, { bigint: true }));
  }

  public async preflight(): Promise<NasPreflight> {
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

    let stats: StatFsLike;
    try {
      stats = await this.statfs(this.targetPath);
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

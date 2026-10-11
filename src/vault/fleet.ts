import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { maskToken } from "./format";
import { createVaultRepository, dataDirectory, type VaultRepository } from "./store";
import { VAULT_LIMITS, type VaultData } from "./types";

const BOT_ID = /^\d{6,16}$/;

export type FleetEntry = {
  id: string;
  active: boolean;
  packCount: number;
  enabled: boolean;
  shareLinks: boolean;
  username?: string;
  name?: string;
  lastError?: string;
  tokenHint?: string;
  channelTitle?: string;
};

type FleetFile = { bots: FleetEntry[] };

export type Fleet = {
  dir: string;
  prepare(): Promise<void>;
  entries(): Promise<FleetEntry[]>;
  activeCount(): Promise<number>;
  repo(botId: string): VaultRepository;
  note(botId: string, data: VaultData): Promise<void>;
  markInactive(botId: string): Promise<void>;
};

export function isBotId(value: string) {
  return BOT_ID.test(value);
}

export function botIdFromToken(token: string) {
  const id = token.split(":")[0] ?? "";
  return isBotId(id) ? id : null;
}

export function summaryFrom(data: VaultData): Omit<FleetEntry, "id"> {
  return {
    active: Boolean(data.token),
    packCount: data.packs.filter((pack) => pack.status === "ready" && pack.code).length,
    enabled: Boolean(data.enabled),
    shareLinks: data.shareLinks !== false,
    username: data.botUsername,
    name: data.botName,
    lastError: data.lastError,
    tokenHint: data.token ? maskToken(data.token) : undefined,
    channelTitle: data.channelTitle,
  };
}

export function openFileLimit() {
  try {
    const text = readFileSync("/proc/self/limits", "utf8");
    const line = text.split("\n").find((item) => item.toLowerCase().includes("max open files"));
    const soft = line?.match(/(\d+)/);
    return soft ? Number(soft[1]) : null;
  } catch {
    return null;
  }
}

export function createFleet(dir: string): Fleet {
  const indexPath = path.join(dir, "fleet.json");
  const botsDir = path.join(dir, "bots");
  let queue: Promise<void> = Promise.resolve();
  const repos = new Map<string, VaultRepository>();

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function readIndex(): Promise<FleetFile> {
    try {
      const parsed = JSON.parse(await readFile(indexPath, "utf8")) as { bots?: unknown };
      const bots = Array.isArray(parsed.bots) ? parsed.bots.flatMap((item) => normalizeEntry(item) ?? []) : [];
      return { bots: dedupe(bots) };
    } catch {
      return { bots: [] };
    }
  }

  async function writeIndex(file: FleetFile) {
    await mkdir(dir, { recursive: true });
    const temporary = `${indexPath}.tmp`;
    await writeFile(temporary, JSON.stringify({ bots: file.bots }));
    await rename(temporary, indexPath);
  }

  return {
    dir,
    prepare() {
      return enqueue(() => syncIndex(dir, botsDir, readIndex, writeIndex));
    },
    entries() {
      return enqueue(async () => (await readIndex()).bots);
    },
    activeCount() {
      return enqueue(async () => (await readIndex()).bots.filter((bot) => bot.active).length);
    },
    repo(botId) {
      if (!isBotId(botId)) throw new Error("机器人编号不正确");
      const found = repos.get(botId);
      if (found) return found;
      const repo = createVaultRepository(path.join(botsDir, botId));
      repos.set(botId, repo);
      return repo;
    },
    note(botId, data) {
      return enqueue(async () => {
        const index = await readIndex();
        const summary = summaryFrom(data);
        const current = index.bots.find((bot) => bot.id === botId);
        if (current) Object.assign(current, summary);
        else index.bots.push({ id: botId, ...summary });
        await writeIndex(index);
      });
    },
    markInactive(botId) {
      return enqueue(async () => {
        const index = await readIndex();
        const current = index.bots.find((bot) => bot.id === botId);
        if (!current) return;
        current.active = false;
        current.enabled = false;
        current.tokenHint = undefined;
        current.lastError = undefined;
        await writeIndex(index);
      });
    },
  };
}

function normalizeEntry(item: unknown): FleetEntry | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Partial<FleetEntry>;
  if (typeof row.id !== "string" || !isBotId(row.id)) return null;
  return {
    id: row.id,
    active: row.active !== false,
    packCount: typeof row.packCount === "number" ? row.packCount : 0,
    enabled: Boolean(row.enabled),
    shareLinks: row.shareLinks !== false,
    username: typeof row.username === "string" ? row.username : undefined,
    name: typeof row.name === "string" ? row.name : undefined,
    lastError: typeof row.lastError === "string" ? row.lastError : undefined,
    tokenHint: typeof row.tokenHint === "string" ? row.tokenHint : undefined,
    channelTitle: typeof row.channelTitle === "string" ? row.channelTitle : undefined,
  };
}

function dedupe(bots: FleetEntry[]) {
  const seen = new Set<string>();
  const unique: FleetEntry[] = [];
  for (const bot of bots) {
    if (seen.has(bot.id)) continue;
    seen.add(bot.id);
    unique.push(bot);
  }
  return unique;
}

async function syncIndex(
  dir: string,
  botsDir: string,
  readIndex: () => Promise<FleetFile>,
  writeIndex: (file: FleetFile) => Promise<void>,
) {
  await mkdir(botsDir, { recursive: true });
  const index = await readIndex();
  const known = new Set(index.bots.map((bot) => bot.id));
  let names: string[] = [];
  try {
    names = await readdir(botsDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!isBotId(name) || known.has(name)) continue;
    index.bots.push({ id: name, active: true, packCount: 0, enabled: false, shareLinks: true });
    known.add(name);
  }
  await adoptLegacy(dir, botsDir, index);
  await writeIndex(index);
}

async function adoptLegacy(dir: string, botsDir: string, index: FleetFile) {
  let parsed: Partial<VaultData> | null = null;
  try {
    parsed = JSON.parse(await readFile(path.join(dir, "vault.json"), "utf8")) as Partial<VaultData>;
  } catch {
    return;
  }
  const token = typeof parsed.token === "string" ? parsed.token : "";
  const id = botIdFromToken(token);
  if (!id) return;
  const target = path.join(botsDir, id, "vault.json");
  try {
    await readFile(target, "utf8");
  } catch {
    await mkdir(path.join(botsDir, id), { recursive: true });
    await writeFile(target, JSON.stringify(parsed, null, 2));
  }
  if (!index.bots.some((bot) => bot.id === id)) {
    index.bots.push({
      id,
      active: true,
      packCount: Array.isArray(parsed.packs) ? parsed.packs.filter((pack) => pack.status === "ready" && pack.code).length : 0,
      enabled: Boolean(parsed.enabled),
      shareLinks: parsed.shareLinks !== false,
      username: parsed.botUsername,
      name: parsed.botName,
      lastError: parsed.lastError,
      tokenHint: maskToken(token),
      channelTitle: parsed.channelTitle,
    });
  }
}

let cached: { dir: string; fleet: Fleet } | null = null;

export function fleetStore() {
  const dir = dataDirectory();
  if (!cached || cached.dir !== dir) cached = { dir, fleet: createFleet(dir) };
  return cached.fleet;
}

export const MAX_BOTS = VAULT_LIMITS.maxBots;

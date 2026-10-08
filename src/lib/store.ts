import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Job } from "./types";

const directory = path.join(process.cwd(), "data");

export type StoredAccount = {
  id: string;
  phone: string;
  name: string;
  username?: string;
  session: string;
  addedAt: string;
};

export type StoredConfig = {
  apiId?: number;
  apiHash?: string;
  demo?: boolean;
};

let queue: Promise<void> = Promise.resolve();

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path.join(directory, file), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function update<T>(file: string, fallback: T, change: (current: T) => T): Promise<T> {
  const run = queue.then(async () => {
    await mkdir(directory, { recursive: true });
    const current = await readJson(file, fallback);
    const next = change(current);
    const target = path.join(directory, file);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2));
    await rename(temporary, target);
    return next;
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function getConfig(): Promise<StoredConfig> {
  return readJson<StoredConfig>("config.json", {});
}

export function saveConfig(partial: StoredConfig): Promise<StoredConfig> {
  return update("config.json", {} as StoredConfig, (current) => ({ ...current, ...partial }));
}

export function listStoredAccounts(): Promise<StoredAccount[]> {
  return readJson<StoredAccount[]>("accounts.json", []);
}

export function upsertAccount(account: StoredAccount): Promise<StoredAccount[]> {
  return update("accounts.json", [] as StoredAccount[], (current) => {
    const rest = current.filter((item) => item.id !== account.id);
    return [...rest, account];
  });
}

export function deleteStoredAccount(id: string): Promise<StoredAccount[]> {
  return update("accounts.json", [] as StoredAccount[], (current) =>
    current.filter((item) => item.id !== id),
  );
}

export function readJobs(): Promise<Job[]> {
  return readJson<Job[]>("jobs.json", []);
}

export function writeJobs(jobs: Job[]): Promise<Job[]> {
  return update("jobs.json", [] as Job[], () => jobs.slice(0, 20));
}

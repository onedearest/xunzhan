import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyVault, type ExpiringNotice, type UserPrompt, type VaultData } from "./types";

export type VaultRepository = {
  load(): Promise<VaultData>;
  update(change: (current: VaultData) => VaultData): Promise<VaultData>;
};

export function dataDirectory() {
  return process.env.XUNZHAN_DATA
    ? path.resolve(process.env.XUNZHAN_DATA)
    : path.join(process.cwd(), "data");
}

export function createVaultRepository(dir: string): VaultRepository {
  const file = path.join(dir, "vault.json");
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<VaultData> {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = JSON.parse(raw) as Partial<VaultData>;
      return {
        ...emptyVault(),
        token: typeof parsed.token === "string" ? parsed.token : "",
        enabled: Boolean(parsed.enabled),
        botId: parsed.botId,
        botName: parsed.botName,
        botUsername: parsed.botUsername,
        channelId: parsed.channelId,
        channelTitle: parsed.channelTitle,
        shareLinks: parsed.shareLinks !== false,
        offset: typeof parsed.offset === "number" ? parsed.offset : 0,
        packs: Array.isArray(parsed.packs) ? parsed.packs : [],
        seenChannels: Array.isArray(parsed.seenChannels) ? parsed.seenChannels : [],
        prompts: readPrompts(parsed.prompts),
        expiring: readExpiring(parsed.expiring),
        lastError: parsed.lastError,
        connectedAt: parsed.connectedAt,
      };
    } catch {
      return emptyVault();
    }
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    load() {
      return enqueue(read);
    },
    update(change) {
      return enqueue(async () => {
        await mkdir(dir, { recursive: true });
        const next = change(await read());
        const temporary = `${file}.tmp`;
        await writeFile(temporary, JSON.stringify(next, null, 2));
        await rename(temporary, file);
        return next;
      });
    },
  };
}

function readExpiring(value: unknown): ExpiringNotice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const notice = item as { chatId?: unknown; messageId?: unknown; deleteAt?: unknown };
    if (typeof notice.chatId !== "string" || typeof notice.messageId !== "number" || typeof notice.deleteAt !== "string") {
      return [];
    }
    return [{ chatId: notice.chatId, messageId: notice.messageId, deleteAt: notice.deleteAt }];
  });
}

function readPrompts(value: unknown): UserPrompt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const prompt = item as { ownerId?: unknown; kind?: unknown };
    if (prompt.kind === "search" && typeof prompt.ownerId === "string") {
      return [{ ownerId: prompt.ownerId, kind: "search" as const }];
    }
    return [];
  });
}

let cached: { dir: string; repo: VaultRepository } | null = null;

export function vaultRepository() {
  const dir = dataDirectory();
  if (!cached || cached.dir !== dir) cached = { dir, repo: createVaultRepository(dir) };
  return cached.repo;
}

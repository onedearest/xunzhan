import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isVaultCode } from "./format";
import { emptyVault, type DeliveryDay, type ExpiringNotice, type SeenUser, type UserPrompt, type VaultData } from "./types";

export type VaultRepository = {
  load(): Promise<VaultData>;
  update(change: (current: VaultData) => VaultData): Promise<VaultData>;
};

export function dataDirectory() {
  const dir = process.env.STORAGE_BOT_DATA || process.env.XUNZHAN_DATA;
  return dir ? path.resolve(dir) : path.join(process.cwd(), "data");
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
        readsAllGroupMessages: typeof parsed.readsAllGroupMessages === "boolean" ? parsed.readsAllGroupMessages : undefined,
        channelId: parsed.channelId,
        channelTitle: parsed.channelTitle,
        shareLinks: parsed.shareLinks !== false,
        ownerId: readUserId(parsed.ownerId),
        adminIds: readAdminIds(parsed.adminIds),
        guestHome: readGuestHome(parsed.guestHome),
        deliverAd: readGuestHome(parsed.deliverAd),
        followChannel: readFollow(parsed.followChannel),
        support: readGuestHome(parsed.support)?.slice(0, 80),
        protectContent: parsed.protectContent === true,
        channelPush: parsed.channelPush === true,
        expireHours: parsed.expireHours === 24 || parsed.expireHours === 168 ? parsed.expireHours : undefined,
        openedAt: typeof parsed.openedAt === "string" ? parsed.openedAt : undefined,
        seenUsers: readSeenUsers(parsed.seenUsers),
        deliveries: typeof parsed.deliveries === "number" && parsed.deliveries > 0 ? Math.floor(parsed.deliveries) : 0,
        deliveryDays: readDeliveryDays(parsed.deliveryDays),
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

function readUserId(value: unknown) {
  return typeof value === "string" && /^\d{1,16}$/.test(value) ? value : undefined;
}

function readAdminIds(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((item) => typeof item === "string" && /^\d{1,16}$/.test(item)))];
}

function readFollow(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.startsWith("@") && text.length > 1 && text.length <= 40) return text;
  if (/^-\d{6,20}$/.test(text)) return text;
  return undefined;
}

function readGuestHome(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, 500);
  return text || undefined;
}

function readSeenUsers(value: unknown): SeenUser[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const user = item as { id?: unknown; firstSeen?: unknown; lastSeen?: unknown; prevSeen?: unknown };
    if (typeof user.id !== "string" || !/^\d{1,16}$/.test(user.id)) return [];
    if (typeof user.firstSeen !== "string" || typeof user.lastSeen !== "string") return [];
    return [{ id: user.id, firstSeen: user.firstSeen, lastSeen: user.lastSeen, prevSeen: typeof user.prevSeen === "string" ? user.prevSeen : undefined }];
  });
}

function readDeliveryDays(value: unknown): DeliveryDay[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const day = item as { day?: unknown; count?: unknown };
    if (typeof day.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.day)) return [];
    if (typeof day.count !== "number" || day.count < 0) return [];
    return [{ day: day.day, count: Math.floor(day.count) }];
  });
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
    const prompt = item as { ownerId?: unknown; kind?: unknown; code?: unknown };
    if (prompt.kind === "search" && typeof prompt.ownerId === "string") {
      return [{ ownerId: prompt.ownerId, kind: "search" as const }];
    }
    if (prompt.kind === "rename" && typeof prompt.ownerId === "string" && typeof prompt.code === "string" && isVaultCode(prompt.code)) {
      return [{ ownerId: prompt.ownerId, kind: "rename" as const, code: prompt.code }];
    }
    if (
      (prompt.kind === "guest-home" ||
        prompt.kind === "deliver-ad" ||
        prompt.kind === "follow" ||
        prompt.kind === "support" ||
        prompt.kind === "broadcast" ||
        prompt.kind === "admin-add") &&
      typeof prompt.ownerId === "string"
    ) {
      return [{ ownerId: prompt.ownerId, kind: prompt.kind }];
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

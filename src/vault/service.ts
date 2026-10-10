import { parseBotToken } from "../bot-token";
import { HttpError } from "../http";
import { applyVaultUpdate, ioFromClient } from "./apply";
import { BotApiError, BotClient, canPostInChannel, explainBot } from "./bot-client";
import { maskToken, normalizeChannel, queryItems } from "./format";
import { vaultRepository, type VaultRepository } from "./store";
import {
  VAULT_LIMITS,
  type VaultData,
  type VaultPack,
  type VaultPackPublic,
  type VaultStatus,
} from "./types";

export type VaultView = {
  status: VaultStatus;
  items: VaultPackPublic[];
  page: number;
  pages: number;
  total: number;
};

type Runtime = {
  generation: number;
  looping: boolean;
  running: boolean;
  lastError?: string;
  controller?: AbortController;
};

function runtime(): Runtime {
  const root = globalThis as { __storageBot?: Runtime };
  if (!root.__storageBot) {
    root.__storageBot = { generation: 0, looping: false, running: false };
  }
  return root.__storageBot;
}

export function toPublic(pack: VaultPack, username?: string): VaultPackPublic {
  return {
    code: pack.code || "",
    name: pack.name || "未命名",
    ownerId: pack.ownerId,
    ownerName: pack.ownerName,
    ownerUsername: pack.ownerUsername,
    fileCount: pack.files.length,
    files: pack.files.map((file) => ({ name: file.name, kind: file.kind, size: file.size })),
    createdAt: pack.readyAt || pack.createdAt,
    link: username && pack.code ? `https://t.me/${username}?start=${pack.code}` : undefined,
  };
}

export function toStatus(data: VaultData, running: boolean): VaultStatus {
  return {
    connected: Boolean(data.token),
    running: Boolean(data.token) && data.enabled && running,
    botId: data.botId,
    botName: data.botName,
    botUsername: data.botUsername,
    tokenHint: data.token ? maskToken(data.token) : undefined,
    channelId: data.channelId,
    channelTitle: data.channelTitle,
    shareLinks: data.shareLinks,
    packCount: data.packs.filter((pack) => pack.status === "ready").length,
    lastError: runtime().lastError || data.lastError,
    seenChannels: data.seenChannels,
    connectedAt: data.connectedAt,
  };
}

function viewFrom(data: VaultData, query: string, page: number): VaultView {
  const ready = data.packs.filter((pack) => pack.status === "ready" && pack.code);
  const listed = queryItems(
    ready.map((pack) => ({
      ...pack,
      name: pack.name || "",
      code: pack.code || "",
      text: pack.files.map((file) => file.name).join("\n"),
      createdAt: pack.readyAt || pack.createdAt,
    })),
    query,
    page,
    VAULT_LIMITS.adminPageSize,
  );
  return {
    status: toStatus(data, runtime().running),
    items: listed.items.map((pack) => toPublic(pack, data.botUsername)),
    page: listed.page,
    pages: listed.pages,
    total: listed.total,
  };
}

export async function vaultView(query = "", page = 1, repo: VaultRepository = vaultRepository()) {
  await resumeVault(repo);
  return viewFrom(await repo.load(), query, page);
}

export async function connectVault(
  input: { token?: unknown; channelId?: unknown; shareLinks?: unknown },
  repo: VaultRepository = vaultRepository(),
  clientFor: (token: string) => BotClient = (token) => new BotClient(token),
) {
  const current = await repo.load();
  const pasted = typeof input.token === "string" ? input.token.trim() : "";
  const token = pasted ? parseBotToken(pasted) : current.token;
  if (pasted && !token) {
    throw new HttpError(400, "令牌格式不正确。请粘贴 @BotFather 发来的整段，类似 123456789:ABC…");
  }
  if (!token) throw new HttpError(400, "请填写机器人令牌");
  const client = clientFor(token);
  let me;
  try {
    me = await client.getMe();
  } catch (error) {
    const message = explainBot(error) || "机器人令牌不正确";
    throw new HttpError(message.includes("令牌") ? 400 : 502, message);
  }
  if (!me.is_bot) throw new HttpError(400, "这不是一个机器人令牌");

  let channelId = current.channelId;
  let channelTitle = current.channelTitle;
  if (typeof input.channelId === "string") {
    let normalized = "";
    try {
      normalized = normalizeChannel(input.channelId);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "频道编号不正确");
    }
    if (!normalized) {
      channelId = undefined;
      channelTitle = undefined;
    } else {
      let chat;
      try {
        chat = await client.getChat(normalized);
      } catch (error) {
        throw new HttpError(400, explainBot(error) || "找不到这个频道");
      }
      if (chat.type !== "channel") throw new HttpError(400, "仓库要一个频道，不是群。");
      let member;
      try {
        member = await client.getChatMember(String(chat.id), String(me.id));
      } catch (error) {
        throw new HttpError(400, explainBot(error) || "机器人还不在这个频道里");
      }
      if (!canPostInChannel(member)) {
        throw new HttpError(400, "请把机器人设为这个频道的管理员，并允许发布消息。");
      }
      channelId = String(chat.id);
      channelTitle = chat.title || channelId;
    }
  }

  await client.deleteWebhook().catch(() => undefined);
  await client.setCommands().catch(() => undefined);

  const sameBot = current.botId === String(me.id);
  const saved = await repo.update((data) => ({
    ...data,
    token,
    enabled: true,
    botId: String(me.id),
    botName: me.first_name || me.username || "存储机器人",
    botUsername: me.username,
    channelId,
    channelTitle,
    shareLinks: typeof input.shareLinks === "boolean" ? input.shareLinks : data.shareLinks,
    offset: sameBot ? data.offset : 0,
    lastError: undefined,
    connectedAt: new Date().toISOString(),
  }));
  runtime().lastError = undefined;
  startLoop(repo, clientFor);
  return viewFrom(saved, "", 1);
}

export async function pauseVault(repo: VaultRepository = vaultRepository()) {
  stopLoop();
  const saved = await repo.update((data) => ({ ...data, enabled: false }));
  return viewFrom(saved, "", 1);
}

export async function forgetVault(repo: VaultRepository = vaultRepository()) {
  stopLoop();
  const saved = await repo.update((data) => ({
    ...data,
    token: "",
    enabled: false,
    lastError: undefined,
  }));
  runtime().lastError = undefined;
  return viewFrom(saved, "", 1);
}

export async function deleteVaultItem(code: string, repo: VaultRepository = vaultRepository()) {
  const current = await repo.load();
  const pack = current.packs.find((entry) => entry.code === code);
  if (!pack) throw new HttpError(404, "没有这个编号");
  await repo.update((data) => ({ ...data, packs: data.packs.filter((entry) => entry.code !== code) }));
  if (current.token) {
    const client = new BotClient(current.token);
    for (const file of pack.files) {
      if (file.channelId && file.channelMessageId) {
        await client.deleteMessage(file.channelId, file.channelMessageId).catch(() => undefined);
      }
    }
  }
  return viewFrom(await repo.load(), "", 1);
}

let booting: Promise<void> | null = null;

export function resumeVault(repo: VaultRepository = vaultRepository()) {
  if (runtime().looping) return Promise.resolve();
  if (!booting) {
    booting = repo
      .load()
      .then((data) => {
        if (runtime().looping) return;
        if (data.enabled && data.token) startLoop(repo);
      })
      .catch((error: unknown) => {
        runtime().lastError = explainBot(error) || "存储机器人没有启动";
      })
      .finally(() => {
        booting = null;
      });
  }
  return booting;
}

function startLoop(repo: VaultRepository, clientFor: (token: string) => BotClient = (token) => new BotClient(token)) {
  const rt = runtime();
  rt.generation += 1;
  const generation = rt.generation;
  rt.controller?.abort();
  const controller = new AbortController();
  rt.controller = controller;
  rt.looping = true;
  rt.running = true;
  void poll(repo, clientFor, generation, controller).finally(() => {
    if (runtime().generation === generation) {
      runtime().looping = false;
      runtime().running = false;
    }
  });
}

function stopLoop() {
  const rt = runtime();
  rt.generation += 1;
  rt.controller?.abort();
  rt.looping = false;
  rt.running = false;
}

async function poll(
  repo: VaultRepository,
  clientFor: (token: string) => BotClient,
  generation: number,
  controller: AbortController,
) {
  let failures = 0;
  let announced = false;
  while (runtime().generation === generation) {
    const data = await repo.load();
    if (!data.enabled || !data.token || runtime().generation !== generation) return;
    const client = clientFor(data.token);
    try {
      if (!announced) {
        announced = true;
        await client.setCommands().catch(() => undefined);
      }
      await sweepExpiring(repo, client);
      const updates = await client.getUpdates(data.offset, controller.signal);
      if (runtime().generation !== generation) return;
      failures = 0;
      runtime().lastError = undefined;
      if (data.lastError) await repo.update((current) => ({ ...current, lastError: undefined }));
      for (const update of updates) {
        if (runtime().generation !== generation) return;
        await applyVaultUpdate(update, repo, ioFromClient(client));
      }
    } catch (error) {
      if (controller.signal.aborted || runtime().generation !== generation) return;
      if (error instanceof BotApiError && error.code === 409 && failures < 3) {
        failures += 1;
        await sleep(1000, controller.signal);
        continue;
      }
      const message = explainBot(error) || "收消息时断了";
      failures += 1;
      runtime().lastError = message;
      const latest = await repo.load();
      if (latest.lastError !== message) await repo.update((current) => ({ ...current, lastError: message }));
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), controller.signal);
    }
  }
}

async function sweepExpiring(repo: VaultRepository, client: BotClient) {
  const data = await repo.load();
  const now = Date.now();
  const due = (data.expiring ?? []).filter((item) => Date.parse(item.deleteAt) <= now);
  if (!due.length) return;
  for (const item of due) {
    await client.deleteMessage(item.chatId, item.messageId).catch(() => undefined);
  }
  const dueKeys = new Set(due.map((item) => `${item.chatId}:${item.messageId}`));
  await repo.update((current) => ({
    ...current,
    expiring: (current.expiring ?? []).filter((item) => !dueKeys.has(`${item.chatId}:${item.messageId}`)),
  }));
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort);
  });
}

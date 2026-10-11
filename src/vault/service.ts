import { parseBotToken } from "../bot-token";
import { HttpError } from "../http";
import { applyVaultUpdate, ioFromClient } from "./apply";
import { BotApiError, BotClient, canPostInChannel, explainBot } from "./bot-client";
import { botIdFromToken, fleetStore, isBotId, type Fleet } from "./fleet";
import { maskToken, normalizeChannel, queryItems } from "./format";
import {
  VAULT_LIMITS,
  type BotPublic,
  type VaultData,
  type VaultPack,
  type VaultPackPublic,
  type VaultStatus,
} from "./types";

export type VaultView = {
  status: VaultStatus;
  bots: BotPublic[];
  items: VaultPackPublic[];
  page: number;
  pages: number;
  total: number;
};

type BotLoop = {
  generation: number;
  running: boolean;
  controller?: AbortController;
};

type Runtime = {
  bots: Map<string, BotLoop>;
};

function runtime(): Runtime {
  const root = globalThis as { __storageBot?: Runtime };
  if (!root.__storageBot?.bots) root.__storageBot = { bots: new Map() };
  return root.__storageBot;
}

function loopOf(botId: string) {
  const bots = runtime().bots;
  const found = bots.get(botId);
  if (found) return found;
  const created: BotLoop = { generation: 0, running: false };
  bots.set(botId, created);
  return created;
}

export function botRunning(botId: string) {
  return Boolean(runtime().bots.get(botId)?.running);
}

export function toPublic(pack: VaultPack, username?: string, botId?: string): VaultPackPublic {
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
    botId,
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
    lastError: data.lastError,
    seenChannels: data.seenChannels,
    connectedAt: data.connectedAt,
  };
}


export async function vaultView(query = "", page = 1, fleet: Fleet = fleetStore()) {
  await resumeVault(fleet);
  return fleetView(fleet, query, page);
}

export async function connectVault(
  input: { token?: unknown; botId?: unknown; channelId?: unknown; shareLinks?: unknown },
  fleet: Fleet = fleetStore(),
  clientFor: (token: string) => BotClient = (token) => new BotClient(token),
) {
  await fleet.prepare();
  const pasted = typeof input.token === "string" ? input.token.trim() : "";
  const parsed = pasted ? parseBotToken(pasted) : null;
  if (pasted && !parsed) {
    throw new HttpError(400, "令牌格式不正确。请粘贴 @BotFather 发来的整段，类似 123456789:ABC…");
  }
  const requested = typeof input.botId === "string" && isBotId(input.botId) ? input.botId : "";
  const fromToken = parsed ? botIdFromToken(parsed) : null;
  let botId = fromToken || requested;
  if (!botId) botId = await onlyActive(fleet);
  if (!botId) throw new HttpError(400, "请填写机器人令牌");
  const repo = fleet.repo(botId);
  const current = await repo.load();
  const token = parsed || current.token;
  if (!token) throw new HttpError(400, "请填写机器人令牌");
  if (botIdFromToken(token) !== botId) throw new HttpError(400, "令牌和机器人对不上");
  const already = (await fleet.entries()).some((bot) => bot.id === botId && bot.active);
  if (!already && (await fleet.activeCount()) >= VAULT_LIMITS.maxBots) {
    throw new HttpError(400, `最多接入 ${VAULT_LIMITS.maxBots} 个机器人`);
  }

  const client = clientFor(token);
  let me;
  try {
    me = await client.getMe();
  } catch (error) {
    const message = explainBot(error) || "机器人令牌不正确";
    throw new HttpError(message.includes("令牌") ? 400 : 502, message);
  }
  if (!me.is_bot) throw new HttpError(400, "这不是一个机器人令牌");
  if (String(me.id) !== botId) throw new HttpError(400, "令牌和机器人对不上");

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
  await fleet.note(botId, saved);
  startLoop(fleet, botId, clientFor);
  return fleetView(fleet, "", 1);
}

export async function pauseVault(input: { botId?: unknown } = {}, fleet: Fleet = fleetStore()) {
  await fleet.prepare();
  const botId = await chosenBot(input.botId, fleet);
  stopLoop(botId);
  const saved = await fleet.repo(botId).update((data) => ({ ...data, enabled: false }));
  await fleet.note(botId, saved);
  return fleetView(fleet, "", 1);
}

export async function forgetVault(input: { botId?: unknown } = {}, fleet: Fleet = fleetStore()) {
  await fleet.prepare();
  const botId = await chosenBot(input.botId, fleet);
  stopLoop(botId);
  const saved = await fleet.repo(botId).update((data) => ({
    ...data,
    token: "",
    enabled: false,
    lastError: undefined,
  }));
  await fleet.note(botId, saved);
  await fleet.markInactive(botId);
  return fleetView(fleet, "", 1);
}

export async function deleteVaultItem(code: string, botId?: string, fleet: Fleet = fleetStore()) {
  await fleet.prepare();
  const id = botId && isBotId(botId) ? botId : await onlyActive(fleet);
  if (!id) throw new HttpError(400, "请选择机器人");
  const repo = fleet.repo(id);
  const current = await repo.load();
  const pack = current.packs.find((entry) => entry.code === code);
  if (!pack) throw new HttpError(404, "没有这个口令");
  const saved = await repo.update((data) => ({ ...data, packs: data.packs.filter((entry) => entry.code !== code) }));
  await fleet.note(id, saved);
  if (current.token) {
    const client = new BotClient(current.token);
    for (const file of pack.files) {
      if (file.channelId && file.channelMessageId) {
        await client.deleteMessage(file.channelId, file.channelMessageId).catch(() => undefined);
      }
    }
  }
  return fleetView(fleet, "", 1);
}

let booting: Promise<void> | null = null;

export function resumeVault(fleet: Fleet = fleetStore()) {
  if (booting) return booting;
  booting = (async () => {
    await fleet.prepare();
    const entries = await fleet.entries();
    let index = 0;
    for (const entry of entries) {
      if (!entry.active) continue;
      const data = await fleet.repo(entry.id).load();
      if (!data.enabled || !data.token) continue;
      if (botRunning(entry.id)) continue;
      const delay = index * 10;
      index += 1;
      setTimeout(() => {
        if (!botRunning(entry.id)) startLoop(fleet, entry.id);
      }, delay);
    }
  })()
    .catch((error: unknown) => {
      console.error(explainBot(error) || "存储机器人没有启动");
    })
    .finally(() => {
      booting = null;
    });
  return booting;
}

function startLoop(
  fleet: Fleet,
  botId: string,
  clientFor: (token: string) => BotClient = (token) => new BotClient(token),
) {
  const loop = loopOf(botId);
  loop.generation += 1;
  const generation = loop.generation;
  loop.controller?.abort();
  const controller = new AbortController();
  loop.controller = controller;
  loop.running = true;
  const repo = fleet.repo(botId);
  void poll(fleet, botId, repo, clientFor, generation, controller).finally(() => {
    const current = runtime().bots.get(botId);
    if (current?.generation === generation) current.running = false;
  });
}

function stopLoop(botId: string) {
  const loop = runtime().bots.get(botId);
  if (!loop) return;
  loop.generation += 1;
  loop.controller?.abort();
  loop.running = false;
}

async function poll(
  fleet: Fleet,
  botId: string,
  repo: ReturnType<Fleet["repo"]>,
  clientFor: (token: string) => BotClient,
  generation: number,
  controller: AbortController,
) {
  let failures = 0;
  let announced = false;
  while (runtime().bots.get(botId)?.generation === generation) {
    const data = await repo.load();
    if (!data.enabled || !data.token || runtime().bots.get(botId)?.generation !== generation) return;
    const client = clientFor(data.token);
    try {
      if (!announced) {
        announced = true;
        await client.setCommands().catch(() => undefined);
      }
      await sweepExpiring(repo, client);
      const updates = await client.getUpdates(data.offset, controller.signal);
      if (runtime().bots.get(botId)?.generation !== generation) return;
      failures = 0;
      if (data.lastError) await repo.update((current) => ({ ...current, lastError: undefined }));
      for (const update of updates) {
        if (runtime().bots.get(botId)?.generation !== generation) return;
        await applyVaultUpdate(update, repo, ioFromClient(client));
      }
      if (updates.length || data.lastError) await fleet.note(botId, await repo.load());
    } catch (error) {
      if (controller.signal.aborted || runtime().bots.get(botId)?.generation !== generation) return;
      if (error instanceof BotApiError && error.code === 409 && failures < 3) {
        failures += 1;
        await sleep(1000, controller.signal);
        continue;
      }
      const message = explainBot(error) || "收消息时断了";
      failures += 1;
      const latest = await repo.load();
      const saved = latest.lastError === message ? latest : await repo.update((current) => ({ ...current, lastError: message }));
      await fleet.note(botId, saved);
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), controller.signal);
    }
  }
}

async function fleetView(fleet: Fleet, query: string, page: number): Promise<VaultView> {
  const entries = (await fleet.entries()).filter((bot) => bot.active).reverse();
  const botPages = Math.max(1, Math.ceil(entries.length / VAULT_LIMITS.adminPageSize));
  const botPage = Math.min(Math.max(1, page), botPages);
  const slice = entries.slice((botPage - 1) * VAULT_LIMITS.adminPageSize, botPage * VAULT_LIMITS.adminPageSize);
  const loaded = await Promise.all(slice.map(async (entry) => ({ entry, data: await fleet.repo(entry.id).load() })));
  for (const item of loaded) await fleet.note(item.entry.id, item.data);
  const refreshed = (await fleet.entries()).filter((bot) => bot.active);
  const bots = loaded.map((item) => toBot(item.entry.id, item.data));
  const items = loaded.flatMap((item) => listedPacks(item.data, query).map((pack) => toPublic(pack, item.data.botUsername, item.entry.id)));
  const runningCount = refreshed.filter((entry) => botRunning(entry.id)).length;
  const packCount = refreshed.reduce((sum, entry) => sum + entry.packCount, 0);
  const firstError = loaded.map((item) => item.data.lastError).find(Boolean);
  const only = refreshed.length === 1 ? loaded[0] : undefined;
  return {
    status: {
      connected: refreshed.length > 0,
      running: runningCount > 0,
      botCount: refreshed.length,
      runningCount,
      maxBots: VAULT_LIMITS.maxBots,
      packCount,
      shareLinks: refreshed.length === 0 || refreshed.every((entry) => entry.shareLinks),
      lastError: firstError,
      botId: only?.entry.id,
      botName: only?.data.botName,
      botUsername: only?.data.botUsername,
      tokenHint: only?.data.token ? maskToken(only.data.token) : undefined,
      channelId: only?.data.channelId,
      channelTitle: only?.data.channelTitle,
      seenChannels: only?.data.seenChannels ?? [],
      connectedAt: only?.data.connectedAt,
    },
    bots,
    items,
    page: botPage,
    pages: botPages,
    total: refreshed.length,
  };
}

function listedPacks(data: VaultData, query: string) {
  const ready = data.packs.filter((pack) => pack.status === "ready" && pack.code);
  return queryItems(
    ready.map((pack) => ({
      ...pack,
      name: pack.name || "",
      code: pack.code || "",
      text: pack.files.map((file) => file.name).join("\n"),
      createdAt: pack.readyAt || pack.createdAt,
    })),
    query,
    1,
    VAULT_LIMITS.maxFilesPerPack,
  ).items;
}

function toBot(botId: string, data: VaultData): BotPublic {
  return {
    botId,
    botName: data.botName,
    botUsername: data.botUsername,
    tokenHint: data.token ? maskToken(data.token) : undefined,
    running: botRunning(botId),
    enabled: data.enabled,
    packCount: data.packs.filter((pack) => pack.status === "ready" && pack.code).length,
    shareLinks: data.shareLinks,
    lastError: data.lastError,
    channelTitle: data.channelTitle,
  };
}

async function chosenBot(value: unknown, fleet: Fleet) {
  if (typeof value === "string" && isBotId(value)) return value;
  const only = await onlyActive(fleet);
  if (!only) throw new HttpError(400, "请选择机器人");
  return only;
}

async function onlyActive(fleet: Fleet) {
  const active = (await fleet.entries()).filter((bot) => bot.active);
  return active.length === 1 ? active[0]?.id ?? "" : "";
}

async function sweepExpiring(repo: ReturnType<Fleet["repo"]>, client: BotClient) {
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
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

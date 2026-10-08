import { Api, Logger, TelegramClient, password } from "teleproto";
import { LogLevel } from "teleproto/extensions/Logger";
import { StringSession } from "teleproto/sessions";
import { demoChats, demoFails, isDemoAccount } from "./demo-data";
import { explain } from "./errors";
import { classifyChat, LIMITS, normalizePhone, type RawChat } from "./policy";
import {
  deleteStoredAccount,
  getConfig,
  listStoredAccounts,
  upsertAccount,
  type StoredAccount,
} from "./store";
import type { ChatPublic } from "./types";

const PENDING_TTL_MS = 10 * 60 * 1000;

type PendingLogin = {
  id: string;
  phone: string;
  phoneCodeHash: string;
  client: TelegramClient;
  createdAt: number;
  deliveryMessage: string;
  hint?: string;
};

type Live = {
  clients: Map<string, TelegramClient>;
  pending: Map<string, PendingLogin>;
  peers: Map<string, Map<string, Api.TypeInputPeer>>;
};

function live(): Live {
  const root = globalThis as { __xunzhanLive?: Live };
  if (!root.__xunzhanLive) {
    root.__xunzhanLive = {
      clients: new Map(),
      pending: new Map(),
      peers: new Map(),
    };
  }
  return root.__xunzhanLive;
}

function clientOptions() {
  return {
    connectionRetries: 3,
    timeout: 12,
    requestRetries: 2,
    floodSleepThreshold: 0,
    deviceModel: "Xunzhan Desk",
    systemVersion: "Web",
    appVersion: "1.0.0",
    langCode: "zh",
    systemLangCode: "zh",
    baseLogger: new Logger(LogLevel.NONE),
  };
}

async function credentials() {
  const config = await getConfig();
  const apiId = config.apiId || Number(process.env.TELEGRAM_API_ID);
  const apiHash = config.apiHash || process.env.TELEGRAM_API_HASH || "";
  if (!apiId || !apiHash) {
    throw new Error("先在设置里填写 my.telegram.org 的 api_id 和 api_hash");
  }
  return { apiId, apiHash };
}

function toRaw(dialog: {
  id?: { toString(): string };
  title?: string;
  entity?: unknown;
}): RawChat | null {
  if (!dialog.id || !dialog.entity || typeof dialog.entity !== "object") return null;
  const entity = dialog.entity as Record<string, unknown>;
  const className = String(entity.className ?? "");
  if (!["Chat", "Channel", "ChatForbidden", "ChannelForbidden"].includes(className)) return null;
  const admin = entity.adminRights as { postMessages?: boolean } | undefined;
  const banned = entity.bannedRights as { sendMessages?: boolean } | undefined;
  const defaults = entity.defaultBannedRights as { sendMessages?: boolean } | undefined;
  return {
    className: className as RawChat["className"],
    id: dialog.id.toString(),
    title: typeof entity.title === "string" ? entity.title : dialog.title,
    left: Boolean(entity.left),
    deactivated: Boolean(entity.deactivated),
    broadcast: Boolean(entity.broadcast),
    megagroup: Boolean(entity.megagroup),
    gigagroup: Boolean(entity.gigagroup),
    creator: Boolean(entity.creator),
    username: typeof entity.username === "string" ? entity.username : undefined,
    participantsCount:
      typeof entity.participantsCount === "number" ? entity.participantsCount : undefined,
    adminPost: Boolean(admin?.postMessages),
    adminAny: Boolean(entity.adminRights),
    bannedSend: Boolean(banned?.sendMessages),
    defaultBannedSend: Boolean(defaults?.sendMessages),
    slowmode: Boolean(entity.slowmodeEnabled),
  };
}

async function openClient(session: string) {
  const { apiId, apiHash } = await credentials();
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, clientOptions());
  try {
    await client.connect();
  } catch {
    await client.destroy().catch(() => undefined);
    throw new Error("连不上 Telegram。确认这台机器可以访问 Telegram 网络后再试。");
  }
  return client;
}

function profileOf(user: Api.User, fallbackPhone: string) {
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || fallbackPhone;
  const phone = user.phone
    ? user.phone.startsWith("+")
      ? user.phone
      : `+${user.phone}`
    : fallbackPhone;
  return {
    id: user.id.toString(),
    name,
    username: user.username,
    phone,
  };
}

async function persistSession(
  client: TelegramClient,
  user: Api.User,
  fallbackPhone: string,
  loginId: string,
) {
  const profile = profileOf(user, fallbackPhone);
  const stored = await listStoredAccounts();
  const exists = stored.some((account) => account.id === profile.id);
  if (!exists && stored.length >= LIMITS.maxAccounts) {
    live().pending.delete(loginId);
    await client.logOut().catch(() => client.destroy().catch(() => undefined));
    throw new Error(`最多同时登录 ${LIMITS.maxAccounts} 个账号，请先退出一个`);
  }
  const session = client.session.save();
  if (!session) throw new Error("无法保存登录会话");
  const account: StoredAccount = {
    id: profile.id,
    phone: profile.phone,
    name: profile.name,
    username: profile.username,
    session,
    addedAt: stored.find((item) => item.id === profile.id)?.addedAt ?? new Date().toISOString(),
  };
  await upsertAccount(account);
  live().pending.delete(loginId);
  live().clients.set(profile.id, client);
  return {
    id: profile.id,
    name: profile.name,
    phone: profile.phone,
    username: profile.username,
    demo: false,
  };
}

function takePending(loginId: string) {
  const pending = live().pending.get(loginId);
  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    if (pending) {
      live().pending.delete(loginId);
      void pending.client.destroy().catch(() => undefined);
    }
    throw new Error("登录已过期，请重新获取验证码");
  }
  return pending;
}

export async function startLogin(phoneInput: string) {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw new Error("手机号需要带国家码，例如 +8613800138000");
  const stored = await listStoredAccounts();
  if (stored.length >= LIMITS.maxAccounts) {
    throw new Error(`最多同时登录 ${LIMITS.maxAccounts} 个账号，请先退出一个`);
  }

  const { apiId, apiHash } = await credentials();
  const client = await openClient("");
  try {
    const sent = await client.sendCode({ apiId, apiHash }, phone);
    if (sent.emailRequired || sent.emailCodeSent) {
      throw new Error("Telegram 要求先完成邮箱验证。请用官方客户端登录一次后再回到这里。");
    }
    for (const [id, pending] of live().pending) {
      if (pending.phone === phone) {
        live().pending.delete(id);
        void pending.client.destroy().catch(() => undefined);
      }
    }
    const id = crypto.randomUUID();
    const deliveryMessage = sent.isCodeViaApp
      ? "验证码已发到你已登录的 Telegram 客户端，而不是短信。"
      : "验证码已通过短信发送。";
    live().pending.set(id, {
      id,
      phone,
      phoneCodeHash: sent.phoneCodeHash,
      client,
      createdAt: Date.now(),
      deliveryMessage,
    });
    return { loginId: id, message: deliveryMessage };
  } catch (error) {
    await client.destroy().catch(() => undefined);
    if (error instanceof Error && !("errorMessage" in error)) throw error;
    throw new Error(explain(error));
  }
}

export async function submitCode(loginId: string, code: string) {
  const pending = takePending(loginId);
  const trimmed = code.trim();
  if (!/^\d{4,8}$/.test(trimmed)) throw new Error("验证码一般是 4 到 8 位数字");
  try {
    const result = await pending.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: trimmed,
      }),
    );
    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
      live().pending.delete(loginId);
      await pending.client.destroy().catch(() => undefined);
      throw new Error("这个手机号还没有注册 Telegram");
    }
    if (!(result instanceof Api.auth.Authorization) || !(result.user instanceof Api.User)) {
      throw new Error("登录没有完成");
    }
    const account = await persistSession(pending.client, result.user, pending.phone, loginId);
    return { needPassword: false as const, account };
  } catch (error) {
    const codeName =
      error && typeof error === "object" && "errorMessage" in error
        ? String(error.errorMessage)
        : "";
    if (codeName === "SESSION_PASSWORD_NEEDED") {
      const info = await pending.client.invoke(new Api.account.GetPassword());
      pending.hint = info.hint || undefined;
      return { needPassword: true as const, hint: pending.hint };
    }
    if (error instanceof Error && !codeName) throw error;
    throw new Error(explain(error));
  }
}

export async function submitPassword(loginId: string, passwordText: string) {
  const pending = takePending(loginId);
  if (!passwordText.trim()) throw new Error("请填写两步验证密码");
  try {
    const info = await pending.client.invoke(new Api.account.GetPassword());
    const check = await password.computeCheck(info, passwordText);
    const result = await pending.client.invoke(
      new Api.auth.CheckPassword({ password: check }),
    );
    if (!(result instanceof Api.auth.Authorization) || !(result.user instanceof Api.User)) {
      throw new Error("登录没有完成");
    }
    const account = await persistSession(pending.client, result.user, pending.phone, loginId);
    return { account };
  } catch (error) {
    if (error instanceof Error && !("errorMessage" in error)) throw error;
    throw new Error(explain(error));
  }
}

export async function resendLoginCode(loginId: string) {
  const pending = takePending(loginId);
  try {
    const result = await pending.client.invoke(
      new Api.auth.ResendCode({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
      }),
    );
    if (result instanceof Api.auth.SentCode) {
      pending.phoneCodeHash = result.phoneCodeHash;
      pending.deliveryMessage = "已重新发送验证码。";
      return { message: pending.deliveryMessage };
    }
    throw new Error("暂时不能重发验证码");
  } catch (error) {
    if (error instanceof Error && !("errorMessage" in error)) throw error;
    throw new Error(explain(error));
  }
}

export async function cancelLogin(loginId: string) {
  const pending = live().pending.get(loginId);
  if (!pending) return;
  live().pending.delete(loginId);
  await pending.client
    .invoke(
      new Api.auth.CancelCode({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
      }),
    )
    .catch(() => undefined);
  await pending.client.destroy().catch(() => undefined);
}

async function connectAccount(accountId: string) {
  const accounts = await listStoredAccounts();
  const account = accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("找不到这个账号");
  const existing = live().clients.get(accountId);
  if (existing?.connected) return existing;
  const client = await openClient(account.session);
  if (!(await client.checkAuthorization())) {
    await client.destroy().catch(() => undefined);
    live().clients.delete(accountId);
    throw new Error("登录已失效，请重新登录这个账号");
  }
  live().clients.set(accountId, client);
  return client;
}

export async function listChats(accountId: string): Promise<ChatPublic[]> {
  if (isDemoAccount(accountId)) {
    const config = await getConfig();
    if (!config.demo) throw new Error("演示模式已关闭");
    return demoChats(accountId);
  }
  const client = await connectAccount(accountId);
  const dialogs = await client.getDialogs({ limit: 200 });
  const chats: ChatPublic[] = [];
  const peers = new Map<string, Api.TypeInputPeer>();
  for (const dialog of dialogs) {
    const raw = toRaw(dialog);
    if (!raw) continue;
    const chat = classifyChat(raw);
    chats.push(chat);
    if (dialog.inputEntity) peers.set(chat.id, dialog.inputEntity);
  }
  chats.sort(
    (a, b) => Number(b.canPost) - Number(a.canPost) || a.title.localeCompare(b.title, "zh"),
  );
  live().peers.set(accountId, peers);
  return chats;
}

export async function sendTo(accountId: string, chatId: string, message: string) {
  if (isDemoAccount(accountId)) {
    const failure = demoFails(accountId, chatId);
    if (failure) throw new Error(failure);
    if (!demoChats(accountId).some((chat) => chat.id === chatId)) {
      throw new Error("找不到这个群，请刷新列表");
    }
    return;
  }
  const client = await connectAccount(accountId);
  let peer = live().peers.get(accountId)?.get(chatId);
  if (!peer) {
    await listChats(accountId);
    peer = live().peers.get(accountId)?.get(chatId);
  }
  if (!peer) throw new Error("找不到这个群，请刷新列表");
  try {
    await client.sendMessage(peer, { message });
  } catch (error) {
    throw new Error(explain(error));
  }
}

export async function logoutAccount(accountId: string) {
  let client = live().clients.get(accountId);
  if (!client) {
    const account = (await listStoredAccounts()).find((item) => item.id === accountId);
    if (account) {
      client = await openClient(account.session).catch(() => undefined);
    }
  }
  live().clients.delete(accountId);
  live().peers.delete(accountId);
  if (client) {
    await client.logOut().catch(() => client.destroy().catch(() => undefined));
  }
  await deleteStoredAccount(accountId);
}

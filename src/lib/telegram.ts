import { Api, Logger, TelegramClient, password } from "teleproto";
import { Raw } from "teleproto/events";
import { LogLevel } from "teleproto/extensions/Logger";
import { StringSession } from "teleproto/sessions";
import { parseBotToken } from "./bot-token";
import { demoChats, demoFails, demoPosts, isDemoAccount } from "./demo-data";
import { explain } from "./errors";
import { resolveCredentials } from "./credentials";
import { telegramLoginUrl } from "./login-link";
import { classifyChat, LIMITS, normalizePhone, readablePost, type RawChat } from "./policy";
import {
  deleteStoredAccount,
  getConfig,
  listStoredAccounts,
  upsertAccount,
  type StoredAccount,
} from "./store";
import type { ChatPublic, PostPublic } from "./types";

const PENDING_TTL_MS = 10 * 60 * 1000;
const DONE_TTL_MS = 2 * 60 * 1000;

type SignedAccount = {
  id: string;
  name: string;
  phone: string;
  username?: string;
  demo: false;
};

type PendingLogin = {
  id: string;
  kind: "phone" | "qr";
  phone: string;
  phoneCodeHash: string;
  client: TelegramClient;
  createdAt: number;
  deliveryMessage: string;
  hint?: string;
  qrUrl?: string;
  qrExpires?: number;
  lastExportAt?: number;
  needPassword?: boolean;
  failure?: string;
  cancelled?: boolean;
  queue: Promise<void>;
  unlisten?: () => void;
};

type Live = {
  clients: Map<string, TelegramClient>;
  pending: Map<string, PendingLogin>;
  peers: Map<string, Map<string, Api.TypeInputPeer>>;
  done: Map<string, { account: SignedAccount; at: number }>;
};

function live(): Live {
  const root = globalThis as { __xunzhanLive?: Live };
  if (!root.__xunzhanLive) {
    root.__xunzhanLive = {
      clients: new Map(),
      pending: new Map(),
      peers: new Map(),
      done: new Map(),
    };
  }
  if (!root.__xunzhanLive.done) root.__xunzhanLive.done = new Map();
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
  return resolveCredentials();
}

function toRaw(dialog: {
  id?: { toString(): string };
  title?: string;
  entity?: unknown;
}): RawChat | null {
  if (!dialog.id || !dialog.entity || typeof dialog.entity !== "object") return null;
  const entity = dialog.entity as Record<string, unknown>;
  const className = String(entity.className ?? "");
  if (className === "User") {
    return {
      className: "User",
      id: dialog.id.toString(),
      title: typeof dialog.title === "string" ? dialog.title : undefined,
      firstName: typeof entity.firstName === "string" ? entity.firstName : undefined,
      lastName: typeof entity.lastName === "string" ? entity.lastName : undefined,
      username: typeof entity.username === "string" ? entity.username : undefined,
      self: Boolean(entity.self),
      deleted: Boolean(entity.deleted),
      bot: Boolean(entity.bot),
    };
  }
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
    : user.bot
      ? user.username
        ? `@${user.username}`
        : `机器人 ${user.id.toString()}`
      : fallbackPhone || (user.username ? `@${user.username}` : "已登录");
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
  remember = false,
) {
  const profile = profileOf(user, fallbackPhone);
  const stored = await listStoredAccounts();
  const exists = stored.some((account) => account.id === profile.id);
  if (!exists && stored.length >= LIMITS.maxAccounts) {
    live().pending.delete(loginId);
    await client.logOut().catch(() => client.destroy().catch(() => undefined));
    throw new Error(`最多登录 ${LIMITS.maxAccounts} 个账号，请先退出一个`);
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
  const signed: SignedAccount = {
    id: profile.id,
    name: profile.name,
    phone: profile.phone,
    username: profile.username,
    demo: false,
  };
  if (remember) live().done.set(loginId, { account: signed, at: Date.now() });
  live().pending.delete(loginId);
  live().clients.set(profile.id, client);
  return signed;
}

function enqueue(pending: PendingLogin, task: () => Promise<void>) {
  const run = pending.queue.then(task, task);
  pending.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function takeDone(loginId: string) {
  const item = live().done.get(loginId);
  if (!item) return null;
  live().done.delete(loginId);
  if (Date.now() - item.at > DONE_TTL_MS) return null;
  return item.account;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "errorMessage" in error
    ? String(error.errorMessage)
    : "";
}

async function exportLoginToken(client: TelegramClient) {
  const { apiId, apiHash } = await credentials();
  return client.invoke(
    new Api.auth.ExportLoginToken({
      apiId,
      apiHash,
      exceptIds: [],
    }),
  );
}

async function applyQrResult(pending: PendingLogin, result: Api.auth.TypeLoginToken): Promise<void> {
  if (pending.cancelled || pending.needPassword) return;
  if (result instanceof Api.auth.LoginToken) {
    pending.qrUrl = telegramLoginUrl(result.token);
    pending.qrExpires = Number(result.expires);
    return;
  }
  if (result instanceof Api.auth.LoginTokenMigrateTo) {
    await pending.client._switchDC(result.dcId);
    const migrated = await pending.client.invoke(
      new Api.auth.ImportLoginToken({ token: result.token }),
    );
    await applyQrResult(pending, migrated);
    return;
  }
  if (
    result instanceof Api.auth.LoginTokenSuccess &&
    result.authorization instanceof Api.auth.Authorization &&
    result.authorization.user instanceof Api.User
  ) {
    pending.unlisten?.();
    pending.unlisten = undefined;
    await persistSession(pending.client, result.authorization.user, pending.phone, pending.id, true);
    return;
  }
  throw new Error("扫码没有完成，请重新生成二维码");
}

async function refreshQr(pending: PendingLogin) {
  if (pending.cancelled || pending.needPassword || pending.failure) return;
  pending.lastExportAt = Date.now();
  try {
    const result = await exportLoginToken(pending.client);
    await applyQrResult(pending, result);
  } catch (error) {
    if (pending.cancelled) return;
    if (errorCode(error) === "SESSION_PASSWORD_NEEDED") {
      pending.needPassword = true;
      pending.unlisten?.();
      pending.unlisten = undefined;
      try {
        const info = await pending.client.invoke(new Api.account.GetPassword());
        pending.hint = info.hint || undefined;
      } catch {
        pending.hint = undefined;
      }
      return;
    }
    pending.failure = error instanceof Error && !errorCode(error) ? error.message : explain(error);
    pending.unlisten?.();
    pending.unlisten = undefined;
  }
}

function discardPending(pending: PendingLogin) {
  pending.cancelled = true;
  live().pending.delete(pending.id);
  pending.unlisten?.();
  void pending.client.destroy().catch(() => undefined);
}

function takePending(loginId: string) {
  const pending = live().pending.get(loginId);
  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    if (pending) {
      pending.cancelled = true;
      pending.unlisten?.();
      live().pending.delete(loginId);
      void pending.client.destroy().catch(() => undefined);
    }
    throw new Error("登录已过期，请重新开始");
  }
  return pending;
}

export async function startLogin(phoneInput: string) {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw new Error("手机号需要带国家码，例如 +8613800138000");
  const stored = await listStoredAccounts();
  if (stored.length >= LIMITS.maxAccounts) {
    throw new Error(`最多登录 ${LIMITS.maxAccounts} 个账号，请先退出一个`);
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
      kind: "phone",
      phone,
      phoneCodeHash: sent.phoneCodeHash,
      client,
      createdAt: Date.now(),
      deliveryMessage,
      queue: Promise.resolve(),
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

export async function startQrLogin() {
  const stored = await listStoredAccounts();
  if (stored.length >= LIMITS.maxAccounts) {
    throw new Error(`最多登录 ${LIMITS.maxAccounts} 个账号，请先退出一个`);
  }
  const client = await openClient("");
  const id = crypto.randomUUID();
  const pending: PendingLogin = {
    id,
    kind: "qr",
    phone: "",
    phoneCodeHash: "",
    client,
    createdAt: Date.now(),
    deliveryMessage: "用已经登录的 Telegram 扫描二维码。",
    queue: Promise.resolve(),
  };
  try {
    await enqueue(pending, () => refreshQr(pending));
    if (pending.failure) throw new Error(pending.failure);
    if (!pending.qrUrl || !pending.qrExpires) throw new Error("没有生成二维码，请重试");
    const filter = new Raw({});
    const onUpdate = (update: unknown) => {
      if (!(update instanceof Api.UpdateLoginToken)) return;
      void enqueue(pending, () => refreshQr(pending));
    };
    client.addEventHandler(onUpdate, filter);
    pending.unlisten = () => {
      client.removeEventHandler(onUpdate, filter);
    };
    live().pending.set(id, pending);
    return { loginId: id, url: pending.qrUrl, expires: pending.qrExpires };
  } catch (error) {
    await client.destroy().catch(() => undefined);
    if (error instanceof Error && !errorCode(error)) throw error;
    throw new Error(explain(error));
  }
}

export async function pollQrLogin(loginId: string) {
  const finished = takeDone(loginId);
  if (finished) return { status: "done" as const, account: finished };

  const pending = live().pending.get(loginId);
  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    if (pending) discardPending(pending);
    throw new Error("二维码已过期，请重新生成");
  }
  if (pending.kind !== "qr") throw new Error("这不是扫码登录");
  await pending.queue;

  const after = takeDone(loginId);
  if (after) return { status: "done" as const, account: after };
  if (!live().pending.has(loginId)) throw new Error("二维码已过期，请重新生成");
  if (pending.needPassword) return { status: "password" as const, hint: pending.hint };
  if (pending.failure) {
    const message = pending.failure;
    discardPending(pending);
    throw new Error(message);
  }

  const now = Math.floor(Date.now() / 1000);
  const stale = !pending.qrExpires || pending.qrExpires <= now + 5;
  const cooled = Date.now() - (pending.lastExportAt ?? 0) >= 3000;
  if (stale && cooled) {
    await enqueue(pending, () => refreshQr(pending));
    const renewed = takeDone(loginId);
    if (renewed) return { status: "done" as const, account: renewed };
    if (pending.needPassword) return { status: "password" as const, hint: pending.hint };
    if (pending.failure) {
      const message = pending.failure;
      discardPending(pending);
      throw new Error(message);
    }
  }
  if (!pending.qrUrl || !pending.qrExpires) throw new Error("没有生成二维码，请重试");
  return { status: "waiting" as const, url: pending.qrUrl, expires: pending.qrExpires };
}

export async function startBotLogin(tokenInput: string) {
  const token = parseBotToken(tokenInput);
  if (!token) {
    throw new Error("令牌格式不对。从 @BotFather 复制整段，类似 123456789:ABC…");
  }
  const stored = await listStoredAccounts();
  if (stored.length >= LIMITS.maxAccounts) {
    throw new Error(`最多登录 ${LIMITS.maxAccounts} 个账号，请先退出一个`);
  }
  const { apiId, apiHash } = await credentials();
  const client = await openClient("");
  const loginId = crypto.randomUUID();
  try {
    const user = await client.signInBot({ apiId, apiHash }, { botAuthToken: token });
    if (!(user instanceof Api.User) || !user.bot) throw new Error("这不是一个机器人令牌");
    (client as TelegramClient & { _bot?: boolean })._bot = true;
    const account = await persistSession(client, user, "", loginId);
    return { account };
  } catch (error) {
    await client.destroy().catch(() => undefined);
    if (error instanceof Error && !errorCode(error)) throw error;
    throw new Error(explain(error));
  }
}

export async function cancelLogin(loginId: string) {
  live().done.delete(loginId);
  const pending = live().pending.get(loginId);
  if (!pending) return;
  pending.cancelled = true;
  live().pending.delete(loginId);
  pending.unlisten?.();
  if (pending.kind === "phone" && pending.phone && pending.phoneCodeHash) {
    await pending.client
      .invoke(
        new Api.auth.CancelCode({
          phoneNumber: pending.phone,
          phoneCodeHash: pending.phoneCodeHash,
        }),
      )
      .catch(() => undefined);
  }
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
  live().peers.set(accountId, peers);
  return chats;
}

export async function listPosts(
  accountId: string,
  chatId: string,
): Promise<{ chat: ChatPublic; posts: PostPublic[] }> {
  const chats = await listChats(accountId);
  const chat = chats.find((item) => item.id === chatId);
  if (!chat) throw new Error("找不到这个频道，请刷新列表");
  if (chat.kind !== "channel") throw new Error("自动浏览只用于已经加入的频道");
  if (chat.reason?.includes("退出") || chat.reason?.includes("无权")) {
    throw new Error("这个频道已经退出，不能浏览");
  }
  if (isDemoAccount(accountId)) {
    return { chat, posts: demoPosts(accountId, chatId) };
  }
  const peer = live().peers.get(accountId)?.get(chatId);
  if (!peer) throw new Error("找不到这个频道，请刷新列表");
  const client = await connectAccount(accountId);
  let messages: { className?: string; id?: number; message?: string; date?: number; views?: number; media?: { className?: string } | null }[];
  try {
    messages = await client.getMessages(peer, { limit: 30 });
  } catch (error) {
    throw new Error(explain(error));
  }
  const posts = messages
    .map((message) =>
      readablePost({
        className: message.className,
        id: message.id,
        message: message.message,
        date: message.date,
        views: message.views,
        mediaClass: message.media?.className,
        out: Boolean((message as { out?: boolean }).out),
      }),
    )
    .filter((post): post is PostPublic => post !== null);
  return { chat, posts };
}

export async function listThread(
  accountId: string,
  chatId: string,
): Promise<{ chat: ChatPublic; posts: PostPublic[] }> {
  const chats = await listChats(accountId);
  const chat = chats.find((item) => item.id === chatId);
  if (!chat) throw new Error("找不到这个会话，请刷新列表");
  if (chat.reason?.includes("退出") || chat.reason?.includes("无权")) {
    throw new Error("这个会话已经退出，不能打开");
  }
  if (isDemoAccount(accountId)) {
    return { chat, posts: demoPosts(accountId, chatId) };
  }
  if (chat.kind === "channel") return listPosts(accountId, chatId);
  const peer = live().peers.get(accountId)?.get(chatId);
  if (!peer) throw new Error("找不到这个会话，请刷新列表");
  const client = await connectAccount(accountId);
  let messages: {
    className?: string;
    id?: number;
    message?: string;
    date?: number;
    views?: number;
    out?: boolean;
    media?: { className?: string } | null;
  }[];
  try {
    messages = await client.getMessages(peer, { limit: 40 });
  } catch (error) {
    throw new Error(explain(error));
  }
  const posts = messages
    .map((message) =>
      readablePost({
        className: message.className,
        id: message.id,
        message: message.message,
        date: message.date,
        views: message.views,
        mediaClass: message.media?.className,
        out: Boolean(message.out),
      }),
    )
    .filter((post): post is PostPublic => post !== null);
  return { chat, posts };
}

export async function replyTo(accountId: string, chatId: string, message: string) {
  const text = message.trim();
  if (!text) throw new Error("先写一点内容");
  if (text.length > LIMITS.maxMessageLength) {
    throw new Error(`一条消息最长 ${LIMITS.maxMessageLength} 个字`);
  }
  const chats = await listChats(accountId);
  const chat = chats.find((item) => item.id === chatId);
  if (!chat) throw new Error("找不到这个会话，请刷新列表");
  if (!chat.canPost) throw new Error(chat.reason || "这里不能发消息");
  await sendTo(accountId, chatId, text);
  return chat;
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

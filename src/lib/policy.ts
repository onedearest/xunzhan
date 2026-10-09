import type { ChatKind, ChatPublic, Delivery, Job, PostPublic } from "./types";

export const LIMITS = {
  minIntervalSec: 8,
  demoMinIntervalSec: 1,
  maxIntervalSec: 180,
  maxTargets: 60,
  maxPerAccount: 20,
  maxAccounts: 50,
  maxScheduleDays: 7,
  maxMessageLength: 4096,
};

export type RawChat = {
  className: "Chat" | "Channel" | "ChatForbidden" | "ChannelForbidden" | "User";
  id: string;
  title?: string;
  left?: boolean;
  deactivated?: boolean;
  self?: boolean;
  deleted?: boolean;
  bot?: boolean;
  firstName?: string;
  lastName?: string;
  broadcast?: boolean;
  megagroup?: boolean;
  gigagroup?: boolean;
  creator?: boolean;
  username?: string;
  participantsCount?: number;
  adminPost?: boolean;
  adminAny?: boolean;
  bannedSend?: boolean;
  defaultBannedSend?: boolean;
  slowmode?: boolean;
};

export function classifyChat(raw: RawChat): ChatPublic {
  const title = raw.title?.trim() || "未命名";
  const base = {
    id: raw.id,
    title,
    username: raw.username || undefined,
    participantsCount: raw.participantsCount,
    slowmode: raw.slowmode || undefined,
  };

  if (
    raw.className === "ChatForbidden" ||
    raw.className === "ChannelForbidden" ||
    raw.left ||
    raw.deactivated
  ) {
    return {
      ...base,
      kind: kindOf(raw),
      canPost: false,
      reason: "已退出或无权访问",
    };
  }

  if (raw.className === "User") {
    const name =
      [raw.firstName, raw.lastName].filter(Boolean).join(" ") ||
      raw.username ||
      raw.title ||
      "未命名";
    return {
      ...base,
      title: raw.self ? "收藏夹" : name,
      kind: "private",
      canPost: !raw.deleted,
      reason: raw.deleted ? "这个账号已注销" : undefined,
    };
  }

  if (raw.className === "Chat") {
    const blocked = !!raw.defaultBannedSend && !raw.creator && !raw.adminAny;
    return {
      ...base,
      kind: "group",
      canPost: !blocked,
      reason: blocked ? "群里默认禁止发言" : undefined,
    };
  }

  const channel = !!raw.broadcast && !raw.megagroup;
  if (channel) {
    const canPost = !!(raw.creator || raw.adminPost);
    return {
      ...base,
      kind: "channel",
      canPost,
      reason: canPost ? undefined : "频道需要发帖权限",
    };
  }

  const blocked =
    !!raw.bannedSend || (!!raw.defaultBannedSend && !raw.creator && !raw.adminAny);
  return {
    ...base,
    kind: "supergroup",
    canPost: !blocked,
    reason: blocked ? "你在这个超级群里被禁止发言" : undefined,
  };
}

function kindOf(raw: RawChat): ChatKind {
  if (raw.className === "User") return "private";
  if (raw.className === "Chat" || raw.className === "ChatForbidden") return "group";
  if (raw.broadcast && !raw.megagroup) return "channel";
  return "supergroup";
}

export function normalizePhone(input: string): string | null {
  const compact = input.trim().replace(/[\s-]/g, "");
  if (!/^\+\d{8,15}$/.test(compact)) return null;
  return compact;
}

export function parseCredentials(
  apiId: unknown,
  apiHash: unknown,
): { ok: true; apiId: number; apiHash: string } | { ok: false; error: string } {
  const id = typeof apiId === "number" ? apiId : Number(String(apiId ?? "").trim());
  const hash = typeof apiHash === "string" ? apiHash.trim() : "";
  if (!Number.isInteger(id) || id < 1 || id > 99_999_999) {
    return { ok: false, error: "api_id 应该是 my.telegram.org 上的数字" };
  }
  if (!/^[a-fA-F0-9]{16,64}$/.test(hash)) {
    return { ok: false, error: "api_hash 应该是 16 到 64 位的十六进制字符" };
  }
  return { ok: true, apiId: id, apiHash: hash };
}

export type SelectionInput = {
  accountId: string;
  accountName: string;
  demo: boolean;
  chatIds: string[];
};

export function planBatch(input: {
  message: string;
  intervalSec: number;
  confirmed: boolean;
  selections: SelectionInput[];
  catalogs: Record<string, ChatPublic[]>;
}):
  | { ok: true; message: string; intervalSec: number; deliveries: Delivery[] }
  | { ok: false; error: string } {
  const message = input.message.trim();
  if (!message) return { ok: false, error: "先写好要发送的内容" };
  if (message.length > LIMITS.maxMessageLength) {
    return { ok: false, error: `消息最长 ${LIMITS.maxMessageLength} 个字符` };
  }
  if (input.confirmed !== true) {
    return { ok: false, error: "请确认这些群允许你发布" };
  }
  if (!Number.isInteger(input.intervalSec)) {
    return { ok: false, error: "发送间隔需要是整数秒" };
  }

  const selections = input.selections
    .map((selection) => ({
      ...selection,
      chatIds: [...new Set(selection.chatIds.filter((id) => id.trim()))],
    }))
    .filter((selection) => selection.chatIds.length > 0);

  if (selections.length === 0) return { ok: false, error: "还没有选择群" };

  const demoOnly = selections.every((selection) => selection.demo);
  const minInterval = demoOnly ? LIMITS.demoMinIntervalSec : LIMITS.minIntervalSec;
  if (input.intervalSec < minInterval || input.intervalSec > LIMITS.maxIntervalSec) {
    return {
      ok: false,
      error: demoOnly
        ? `演示模式的间隔要在 ${LIMITS.demoMinIntervalSec} 到 ${LIMITS.maxIntervalSec} 秒之间`
        : `每条消息之间的间隔不能短于 ${LIMITS.minIntervalSec} 秒`,
    };
  }

  const deliveries: Delivery[] = [];
  for (const selection of selections) {
    if (selection.chatIds.length > LIMITS.maxPerAccount) {
      return { ok: false, error: `每个账号单次最多 ${LIMITS.maxPerAccount} 个群` };
    }
    if (deliveries.length + selection.chatIds.length > LIMITS.maxTargets) {
      return { ok: false, error: `单次最多发送到 ${LIMITS.maxTargets} 个群` };
    }
    const catalog = input.catalogs[selection.accountId] ?? [];
    for (const chatId of selection.chatIds) {
      const chat = catalog.find((item) => item.id === chatId);
      if (!chat) return { ok: false, error: "有选中的群不在列表里，请刷新后再发" };
      if (chat.kind === "private") {
        return { ok: false, error: `私聊请在会话里单独回复：「${chat.title}」` };
      }
      if (!chat.canPost) {
        return {
          ok: false,
          error: `不能发到「${chat.title}」：${chat.reason ?? "没有发言权限"}`,
        };
      }
      deliveries.push({
        accountId: selection.accountId,
        accountName: selection.accountName,
        chatId: chat.id,
        title: chat.title,
        status: "pending",
      });
    }
  }

  return {
    ok: true,
    message,
    intervalSec: input.intervalSec,
    deliveries: roundRobinOrder(deliveries),
  };
}

export function parseSchedule(
  value: unknown,
  now = Date.now(),
): { ok: true; at?: string } | { ok: false; error: string } {
  if (value == null || value === "") return { ok: true };
  if (typeof value !== "string") return { ok: false, error: "发送时间不正确" };
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return { ok: false, error: "发送时间不正确" };
  if (time < now - 30_000) return { ok: false, error: "这个时间已经过了" };
  const horizon = now + LIMITS.maxScheduleDays * 24 * 60 * 60 * 1000;
  if (time > horizon) {
    return { ok: false, error: `定时最远只能设到 ${LIMITS.maxScheduleDays} 天内` };
  }
  return { ok: true, at: new Date(time).toISOString() };
}

export function roundRobinOrder(deliveries: Delivery[]): Delivery[] {
  const queues = new Map<string, Delivery[]>();
  const order: string[] = [];
  for (const delivery of deliveries) {
    let queue = queues.get(delivery.accountId);
    if (!queue) {
      queue = [];
      queues.set(delivery.accountId, queue);
      order.push(delivery.accountId);
    }
    queue.push(delivery);
  }
  const result: Delivery[] = [];
  while (result.length < deliveries.length) {
    let progressed = false;
    for (const accountId of order) {
      const next = queues.get(accountId)?.shift();
      if (!next) continue;
      result.push(next);
      progressed = true;
    }
    if (!progressed) break;
  }
  return result;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
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

export async function runDeliveries(options: {
  deliveries: Delivery[];
  intervalMs: number;
  signal: AbortSignal;
  send: (delivery: Delivery) => Promise<void>;
  onUpdate?: () => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const wait = options.sleep ?? sleep;
  const sequence = roundRobinOrder(options.deliveries);
  for (let index = 0; index < sequence.length; index += 1) {
    const delivery = sequence[index];
    if (options.signal.aborted) {
      delivery.status = "skipped";
      delivery.error = "已停止";
      options.onUpdate?.();
      continue;
    }
    delivery.status = "sending";
    options.onUpdate?.();
    try {
      await options.send(delivery);
      delivery.status = "ok";
      delivery.sentAt = new Date().toISOString();
    } catch (error) {
      delivery.status = "error";
      delivery.error = error instanceof Error ? error.message : "发送失败";
    }
    options.onUpdate?.();
    if (index < sequence.length - 1 && !options.signal.aborted) {
      await wait(options.intervalMs, options.signal);
    }
  }
}

export function finishStatus(deliveries: Delivery[], aborted: boolean): Job["status"] {
  const skipped = deliveries.some(
    (delivery) => delivery.status === "skipped" || delivery.status === "pending",
  );
  if (skipped || (aborted && deliveries.some((delivery) => delivery.status !== "ok"))) {
    return "stopped";
  }
  if (deliveries.length > 0 && deliveries.every((delivery) => delivery.status === "error")) {
    return "failed";
  }
  return "done";
}

export function readablePost(input: {
  className?: string;
  id?: number | string;
  message?: string;
  date?: number;
  views?: number;
  mediaClass?: string;
  out?: boolean;
}): PostPublic | null {
  if (input.className !== "Message") return null;
  const text = typeof input.message === "string" ? input.message.trim() : "";
  const media = mediaLabel(input.mediaClass);
  const body = text || (media ? `〔${media}〕` : "");
  if (!body) return null;
  const seconds = typeof input.date === "number" ? input.date : 0;
  return {
    id: String(input.id ?? body.slice(0, 24)),
    text: body,
    date: new Date(seconds * 1000).toISOString(),
    ...(typeof input.views === "number" ? { views: input.views } : {}),
    ...(input.out ? { out: true } : {}),
  };
}

function mediaLabel(className?: string) {
  if (className === "MessageMediaPhoto") return "图片";
  if (className === "MessageMediaDocument") return "文件";
  if (className === "MessageMediaWebPage") return "链接";
  return "";
}

export function jobSummary(job: Job) {
  const ok = job.deliveries.filter((delivery) => delivery.status === "ok").length;
  const error = job.deliveries.filter((delivery) => delivery.status === "error").length;
  const skipped = job.deliveries.filter((delivery) => delivery.status === "skipped").length;
  return {
    ok,
    error,
    skipped,
    total: job.deliveries.length,
    done: ok + error + skipped,
  };
}

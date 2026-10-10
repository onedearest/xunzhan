import { collectingBar, menuKeyboard } from "./format";
import type { InlineButton, TgChat, TgUpdate, TgUser, VaultFile, VaultKind } from "./types";

const API = "https://api.telegram.org";

export class BotApiError extends Error {
  code: number;
  description: string;

  constructor(code: number, description: string) {
    super(description);
    this.code = code;
    this.description = description;
  }
}

export function sanitizeTelegram(message: string, token: string) {
  return message.replace(/bot\d{6,16}:[A-Za-z0-9_-]{20,64}/g, "bot***").split(token).join("***");
}

export function explainBot(error: unknown) {
  if (error instanceof BotApiError) {
    if (error.code === 401) return "机器人令牌不正确，请核对 @BotFather 发来的整段";
    if (error.code === 409) {
      return "这个令牌正在别的地方收消息。先停掉另一个程序，或到 @BotFather 重新生成令牌。";
    }
    const description = error.description.toLowerCase();
    if (description.includes("chat not found")) return "找不到这个频道。请先把机器人加进去，再核对编号。";
    if (description.includes("not enough rights") || description.includes("need administrator")) {
      return "机器人还不能在这个频道发消息。请设为管理员，并允许发布消息。";
    }
    if (description.includes("bot was blocked")) return "对方已经停用了这个机器人。";
    if (description.includes("forbidden")) return "没有权限。请把机器人设为频道管理员，并允许发布消息。";
    if (description.includes("too many requests") || description.includes("retry after")) {
      return "Telegram 限流了，等一会儿再试。";
    }
    if (description.includes("message is not modified")) return "";
    return error.description;
  }
  if (error instanceof Error && error.name === "AbortError") return "";
  if (error instanceof Error && /fetch|network|enotfound|econn|timed out|timeout/i.test(error.message)) {
    return "连不上 Telegram。这台机器需要能访问 api.telegram.org。";
  }
  if (error instanceof Error && error.message) return error.message;
  return "连不上 Telegram";
}

type Member = {
  status?: string;
  can_post_messages?: boolean;
};

const fileMethod: Record<Exclude<VaultKind, "text">, { method: string; field: string; caption: boolean }> = {
  document: { method: "sendDocument", field: "document", caption: true },
  photo: { method: "sendPhoto", field: "photo", caption: true },
  video: { method: "sendVideo", field: "video", caption: true },
  audio: { method: "sendAudio", field: "audio", caption: true },
  voice: { method: "sendVoice", field: "voice", caption: true },
  animation: { method: "sendAnimation", field: "animation", caption: true },
  sticker: { method: "sendSticker", field: "sticker", caption: false },
  video_note: { method: "sendVideoNote", field: "video_note", caption: false },
};

export const botCommands = [
  { command: "start", description: "开始" },
  { command: "store", description: "存储" },
  { command: "folders", description: "查看文件夹（打包好的）" },
  { command: "search", description: "搜索关键词" },
  { command: "get", description: "按编号取回这一组" },
  { command: "del", description: "删除这一组" },
  { command: "cancel", description: "取消还没起名的一组" },
  { command: "stats", description: "查看用量" },
  { command: "help", description: "查看用法" },
];

export function canPostInChannel(member: Member) {
  if (member.status === "creator") return true;
  return member.status === "administrator" && member.can_post_messages !== false;
}

export class BotClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const message = error instanceof Error ? error.message : "连不上 Telegram";
      throw new Error(sanitizeTelegram(message, this.token));
    }
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    } | null;
    if (!payload?.ok) {
      const description = sanitizeTelegram(payload?.description || `HTTP ${response.status}`, this.token);
      throw new BotApiError(payload?.error_code || response.status, description);
    }
    return payload.result as T;
  }

  getMe() {
    return this.call<TgUser>("getMe");
  }

  deleteWebhook() {
    return this.call<boolean>("deleteWebhook", { drop_pending_updates: false });
  }

  setCommands() {
    return this.call<boolean>("setMyCommands", { commands: botCommands });
  }

  getUpdates(offset: number, signal: AbortSignal) {
    return this.call<TgUpdate[]>(
      "getUpdates",
      {
        offset,
        timeout: 25,
        allowed_updates: ["message", "channel_post", "callback_query", "my_chat_member"],
      },
      signal,
    );
  }

  getChat(chatId: string) {
    return this.call<TgChat>("getChat", { chat_id: chatId });
  }

  getChatMember(chatId: string, userId: string) {
    return this.call<Member>("getChatMember", { chat_id: chatId, user_id: userId });
  }

  async copyMessage(fromChat: string, messageId: number, toChat: string) {
    const result = await this.call<{ message_id: number }>("copyMessage", {
      chat_id: toChat,
      from_chat_id: fromChat,
      message_id: messageId,
    });
    return result.message_id;
  }

  async sendMessage(
    chatId: string,
    text: string,
    keyboard?: InlineButton[][],
    menu?: boolean,
    bar?: "finish",
    replyTo?: { messageId?: number; threadId?: number },
  ) {
    const result = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 4096),
      message_thread_id: replyTo?.threadId,
      reply_parameters: replyTo?.messageId
        ? { message_id: replyTo.messageId, allow_sending_without_reply: true }
        : undefined,
      reply_markup: keyboard
        ? { inline_keyboard: keyboard }
        : bar === "finish"
          ? { keyboard: collectingBar(), resize_keyboard: true, is_persistent: true }
          : menu
            ? { keyboard: menuKeyboard(), resize_keyboard: true, is_persistent: true }
            : undefined,
    });
    return result.message_id;
  }

  async editMessage(chatId: string, messageId: number, text: string, keyboard?: InlineButton[][]) {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, 4096),
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
      });
    } catch (error) {
      if (error instanceof BotApiError && error.description.toLowerCase().includes("message is not modified")) return;
      throw error;
    }
  }

  answerCallback(id: string, text?: string) {
    return this.call("answerCallbackQuery", {
      callback_query_id: id,
      text: text?.slice(0, 180),
    });
  }

  deleteMessage(chatId: string, messageId: number) {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  sendMediaGroup(
    chatId: string,
    media: { type: "photo" | "video" | "document" | "audio"; media: string; caption?: string }[],
  ) {
    return this.call<Array<{ message_id: number }>>("sendMediaGroup", {
      chat_id: chatId,
      media: media.map((item) => ({
        type: item.type,
        media: item.media,
        ...(item.caption ? { caption: item.caption.slice(0, 1024) } : {}),
      })),
    });
  }

  sendFile(chatId: string, item: VaultFile) {
    if (item.kind === "text" || !item.fileId) {
      return this.sendMessage(chatId, item.text || item.name);
    }
    const spec = fileMethod[item.kind];
    const body: Record<string, unknown> = {
      chat_id: chatId,
      [spec.field]: item.fileId,
    };
    if (spec.caption && item.caption) body.caption = item.caption.slice(0, 1024);
    return this.call(spec.method, body);
  }
}

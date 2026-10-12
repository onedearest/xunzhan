import { randomBytes } from "node:crypto";
import { explainBot, type BotClient } from "./bot-client";
import { canStore, deliveryBatches, noteDelivery, retrievalPlan } from "./format";
import { reduceVault, type Decision, type Reply } from "./reduce";
import type { VaultRepository } from "./store";
import { CODE_ALPHABET, VAULT_LIMITS, type InlineButton, type TgUpdate, type VaultFile, type VaultPack } from "./types";

export type VaultIO = {
  copyMessage(fromChat: string, messageId: number, toChat: string): Promise<number>;
  sendMessage(
    chatId: string,
    text: string,
    keyboard?: InlineButton[][],
    menu?: boolean,
    bar?: "finish",
    replyTo?: { messageId?: number; threadId?: number; quiet?: boolean; guest?: boolean },
  ): Promise<number | void>;
  editMessage(chatId: string, messageId: number, text: string, keyboard?: InlineButton[][]): Promise<void>;
  answerCallback(id: string, text?: string): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  deliver(chatId: string, pack: VaultPack, currentBotId?: string, note?: string): Promise<number | void>;
  flashBar?(chatId: string, bar: "finish" | "menu" | "guest"): Promise<void>;
  getChatMember?(chatId: string, userId: string): Promise<{ status?: string; is_member?: boolean } | null>;
  setProtect?(on: boolean): void;
};

export function randomCode() {
  const bytes = randomBytes(VAULT_LIMITS.codeLength);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

export function ioFromClient(client: BotClient): VaultIO {
  return {
    copyMessage: (fromChat, messageId, toChat) => client.copyMessage(fromChat, messageId, toChat),
    sendMessage: (chatId, text, keyboard, menu, bar, replyTo) =>
      client.sendMessage(chatId, text, keyboard, menu, bar, replyTo),
    editMessage: (chatId, messageId, text, keyboard) => client.editMessage(chatId, messageId, text, keyboard),
    answerCallback: (id, text) => client.answerCallback(id, text).then(() => undefined),
    deleteMessage: (chatId, messageId) => client.deleteMessage(chatId, messageId).then(() => undefined),
    deliver: (chatId, pack, currentBotId, note) => deliverPack(client, chatId, pack, currentBotId, note),
    flashBar: (chatId, bar) => client.flashReplyBar(chatId, bar),
    getChatMember: async (chatId, userId) => {
      try {
        return await client.getChatMember(chatId, userId);
      } catch {
        return null;
      }
    },
    setProtect: (on) => {
      client.protectContent = on;
    },
  };
}

export async function deliverPack(client: BotClient, chatId: string, pack: VaultPack, currentBotId?: string, note?: string) {
  const batches = deliveryBatches(pack.files, currentBotId);
  const grouped = batches.some((batch) => batch.mode === "album");
  const intro = grouped
    ? `「${pack.name || "未命名"}」共 ${pack.files.length} 个，按 ${VAULT_LIMITS.filePageSize} 个一组发出`
    : `「${pack.name || "未命名"}」共 ${pack.files.length} 个`;
  const introId = await client.sendMessage(chatId, note ? `${intro}\n\n${note}` : intro);
  const showIndex = grouped && batches.length > 1;
  let index = 0;
  for (const batch of batches) {
    index += 1;
    if (batch.mode === "single") {
      if (showIndex) await client.sendMessage(chatId, `第 ${index}/${batches.length} 组，1 个`);
      try {
        await deliverItem(client, chatId, batch.file, currentBotId);
      } catch {
        await client.sendMessage(chatId, `「${batch.file.name}」没发出去。`);
      }
      continue;
    }
    const label = showIndex ? `第 ${index}/${batches.length} 组，${batch.files.length} 个` : undefined;
    try {
      await client.sendMediaGroup(
        chatId,
        batch.files.map((file, fileIndex) => ({
          type: file.kind as "photo" | "video" | "document" | "audio",
          media: file.fileId || "",
          caption: fileIndex === 0 && label ? joinCaption(label, file.caption) : file.caption,
        })),
      );
    } catch {
      if (label) await client.sendMessage(chatId, label);
      for (const file of batch.files) {
        try {
          await deliverItem(client, chatId, file, currentBotId);
        } catch {
          await client.sendMessage(chatId, `「${file.name}」没发出去。`);
        }
      }
    }
  }
  return introId;
}

function joinCaption(label: string, caption?: string) {
  const own = caption?.trim();
  return own ? `${label}\n${own}` : label;
}

export async function deliverItem(client: BotClient, chatId: string, item: VaultFile, currentBotId?: string) {
  const plan = retrievalPlan(item, currentBotId);
  if (plan === "channel" && item.channelId && item.channelMessageId) {
    try {
      await client.copyMessage(item.channelId, item.channelMessageId, chatId);
      return;
    } catch {
      const fallback = retrievalPlan({ ...item, channelId: undefined, channelMessageId: undefined }, currentBotId);
      if (fallback === "unavailable") throw new Error("仓库频道里的那份取不回来了");
    }
  }
  const fallback = retrievalPlan(
    plan === "channel" ? { ...item, channelId: undefined, channelMessageId: undefined } : item,
    currentBotId,
  );
  if (fallback === "text") {
    await client.sendMessage(chatId, item.text || item.name);
    return;
  }
  if (fallback === "file") {
    await client.sendFile(chatId, item);
    return;
  }
  if (fallback === "source") {
    try {
      await client.copyMessage(item.chatId, item.messageId, chatId);
      return;
    } catch (error) {
      if (!item.fileId) throw error;
    }
  }
  if (item.fileId && (fallback === "file" || fallback === "source")) {
    await client.sendFile(chatId, item);
    return;
  }
  throw new Error(
    item.botId && currentBotId && item.botId !== currentBotId
      ? "这份文件是另一个机器人保存的，当前机器人取不回"
      : "这份文件已经取不回来了",
  );
}

export async function applyVaultUpdate(
  update: TgUpdate,
  repo: VaultRepository,
  io: VaultIO,
  options?: { now?: string; nextCode?: () => string },
) {
  const now = options?.now ?? new Date().toISOString();
  const nextCode = options?.nextCode ?? randomCode;
  let decision: Decision = { replies: [] };
  try {
    await repo.update((current) => {
      const reduced = reduceVault(current, update, { now, nextCode });
      decision = reduced.decision;
      return reduced.data;
    });
    noteGroup(update, decision);
    await perform(decision, repo, io, now);
  } catch (error) {
    const chatId = decision.replies[0]?.chatId ?? decision.deliver?.chatId ?? groupChatId(update);
    const reason = explainBot(error) || "请再试一次";
    if (chatId) {
      if (groupChatId(update)) console.error(`群回复失败 chat=${chatId} ${reason}`);
      await io.sendMessage(chatId, `没处理成：${reason}`).catch(() => undefined);
    }
  } finally {
    await repo.update((current) => ({
      ...current,
      offset: Math.max(current.offset, update.update_id + 1),
    }));
    if (decision.callbackId) {
      await io.answerCallback(decision.callbackId, decision.callbackText).catch(() => undefined);
    }
  }
}

function sendReply(io: VaultIO, reply: Reply) {
  return io.sendMessage(reply.chatId, reply.text, reply.keyboard, reply.menu, reply.bar, {
    messageId: reply.replyToMessageId,
    threadId: reply.messageThreadId,
    quiet: reply.quiet,
    guest: reply.guest,
  });
}

async function sendReplyTrying(io: VaultIO, reply: Reply) {
  const variants = [reply];
  const withoutCopy = stripCopyButtons(reply);
  if (withoutCopy) variants.push(withoutCopy);
  if (reply.messageThreadId || reply.replyToMessageId || reply.keyboard?.length) {
    variants.push({
      ...reply,
      keyboard: undefined,
      menu: undefined,
      bar: undefined,
      messageThreadId: undefined,
      replyToMessageId: undefined,
      quiet: false,
    });
  }
  let last: unknown;
  for (const [index, variant] of variants.entries()) {
    try {
      return await sendReply(io, variant);
    } catch (error) {
      last = error;
      const detail = `${error instanceof Error ? error.message : ""} ${explainBot(error)}`.toLowerCase();
      if (/too many requests|retry after|令牌|别的地方收消息/.test(detail) || index === variants.length - 1) throw error;
    }
  }
  throw last;
}

function groupChatId(update: TgUpdate) {
  const chat = update.message?.chat;
  if (!chat || chat.type === "private") return undefined;
  return String(chat.id);
}

function noteGroup(update: TgUpdate, decision: Decision) {
  const message = update.message;
  if (!message || message.chat.type === "private") return;
  const looked = [message.text, message.caption].filter(Boolean).join("\n");
  const anonymous = message.from?.username?.toLowerCase() === "groupanonymousbot";
  if (!looked || (!decision.replies.length && !/[a-z0-9]{8}/i.test(looked))) return;
  console.log(
    `群消息 chat=${message.chat.id} type=${message.chat.type} 回复=${decision.replies.length}${anonymous ? " 匿名管理员" : ""}`,
  );
}

function stripCopyButtons(reply: Reply): Reply | undefined {
  if (!reply.keyboard?.some((row) => row.some((button) => button.copy_text))) return undefined;
  const keyboard = reply.keyboard
    .map((row) => row.filter((button) => !button.copy_text))
    .filter((row) => row.length > 0);
  return { ...reply, keyboard };
}

async function perform(decision: Decision, repo: VaultRepository, io: VaultIO, now: string) {
  if (decision.copy) {
    try {
      const messageId = await io.copyMessage(decision.copy.fromChat, decision.copy.messageId, decision.copy.toChat);
      const copy = decision.copy;
      await repo.update((current) => ({
        ...current,
        packs: current.packs.map((pack) => ({
          ...pack,
          files: pack.files.map((file) =>
            copy && file.chatId === copy.fromChat && file.messageId === copy.messageId
              ? { ...file, channelId: copy.toChat, channelMessageId: messageId }
              : file,
          ),
        })),
      }));
    } catch (error) {
      const note = `\n\n还没放进仓库频道：${explainBot(error) || "请检查机器人是不是频道管理员"}。可以先继续打包。`;
      decision.replies = decision.replies.map((reply) => ({ ...reply, text: `${reply.text}${note}` }));
    }
  }
  if (decision.deliver) {
    try {
      const fresh = await repo.load();
      const pack = fresh.packs.find((entry) => entry.code === decision.deliver?.code && entry.status === "ready");
      if (!pack) throw new Error("没有这个口令");
      let blocked = false;
      if (fresh.followChannel && !canStore(fresh, decision.deliver.chatId)) {
        const member = await io.getChatMember?.(fresh.followChannel, decision.deliver.chatId);
        const status = member?.status;
        const joined =
          status === "creator" ||
          status === "administrator" ||
          status === "member" ||
          (status === "restricted" && member?.is_member !== false);
        if (!joined) {
          const name = fresh.followChannel.startsWith("@") ? fresh.followChannel.slice(1) : "";
          await io.sendMessage(
            decision.deliver.chatId,
            name
              ? `请先关注 ${fresh.followChannel}，然后再取回。`
              : "请先加入创建者指定的频道，然后再取回。机器人还不能确认你是否已经加入。",
            name ? [[{ text: "去关注", url: `https://t.me/${name}` }]] : undefined,
          );
          blocked = true;
        }
      }
      if (!blocked) {
        try {
          io.setProtect?.(fresh.protectContent === true);
          const introId = await io.deliver(decision.deliver.chatId, pack, fresh.botId, fresh.deliverAd);
          if (fresh.expireHours && typeof introId === "number") {
            const deleteAt = new Date(Date.parse(now) + fresh.expireHours * 60 * 60 * 1000).toISOString();
            const chatId = decision.deliver.chatId;
            const messageId = introId;
            await repo.update((current) => ({
              ...current,
              expiring: [...(current.expiring ?? []), { chatId, messageId, deleteAt }].slice(-400),
            }));
            setTimeout(() => {
              void io.deleteMessage(chatId, messageId).catch(() => undefined);
            }, fresh.expireHours * 60 * 60 * 1000).unref();
          }
          const count = pack.files.length;
          await repo.update((current) => noteDelivery(current, count, now));
        } finally {
          io.setProtect?.(false);
        }
      }
    } catch (error) {
      const message = `取回失败：${explainBot(error) || "请再试一次"}`;
      decision.callbackText = message;
      if (!decision.callbackId) await io.sendMessage(decision.deliver.chatId, message);
    }
  }
  if (decision.channelPost) {
    await io.sendMessage(decision.channelPost.chatId, decision.channelPost.text).catch(() => undefined);
  }
  for (const message of decision.removeChannelMessages ?? []) {
    await io.deleteMessage(message.channelId, message.messageId).catch(() => undefined);
  }
  for (const reply of decision.replies) {
    let sent: number | void;
    if (reply.replaceMessageId) {
      await io.deleteMessage(reply.chatId, reply.replaceMessageId).catch(() => undefined);
    }
    if (reply.kind === "edit" && reply.messageId) {
      try {
        await io.editMessage(reply.chatId, reply.messageId, reply.text, reply.keyboard);
      } catch {
        await io.deleteMessage(reply.chatId, reply.messageId).catch(() => undefined);
        sent = await sendReply(io, reply);
      }
    } else {
      sent = await sendReplyTrying(io, reply);
    }
    if (reply.deleteAfterMs && typeof sent === "number") {
      const chatId = reply.chatId;
      const messageId = sent;
      const deleteAt = new Date(Date.now() + reply.deleteAfterMs).toISOString();
      await repo.update((current) => ({
        ...current,
        expiring: [...(current.expiring ?? []), { chatId, messageId, deleteAt }].slice(-100),
      }));
      setTimeout(() => {
        void io.deleteMessage(chatId, messageId).catch(() => undefined);
        void repo
          .update((current) => ({
            ...current,
            expiring: (current.expiring ?? []).filter((item) => !(item.chatId === chatId && item.messageId === messageId)),
          }))
          .catch(() => undefined);
      }, reply.deleteAfterMs).unref();
    }
    if (reply.trackOwnerId && typeof sent === "number") {
      const ownerId = reply.trackOwnerId;
      const messageId = sent;
      await repo.update((current) => ({
        ...current,
        packs: current.packs.map((pack) =>
          pack.ownerId === ownerId && pack.status !== "ready" ? { ...pack, noticeMessageId: messageId } : pack,
        ),
      }));
    }
    if (reply.armBar) await io.flashBar?.(reply.chatId, reply.armBar);
  }
}

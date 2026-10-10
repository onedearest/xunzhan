import { randomBytes } from "node:crypto";
import { explainBot, type BotClient } from "./bot-client";
import { deliveryBatches, retrievalPlan } from "./format";
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
    replyTo?: { messageId?: number; threadId?: number; quiet?: boolean },
  ): Promise<number | void>;
  editMessage(chatId: string, messageId: number, text: string, keyboard?: InlineButton[][]): Promise<void>;
  answerCallback(id: string, text?: string): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  deliver(chatId: string, pack: VaultPack, currentBotId?: string): Promise<void>;
  flashBar?(chatId: string, bar: "finish" | "menu"): Promise<void>;
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
    deliver: (chatId, pack, currentBotId) => deliverPack(client, chatId, pack, currentBotId),
    flashBar: (chatId, bar) => client.flashReplyBar(chatId, bar),
  };
}

export async function deliverPack(client: BotClient, chatId: string, pack: VaultPack, currentBotId?: string) {
  const batches = deliveryBatches(pack.files, currentBotId);
  const grouped = batches.some((batch) => batch.mode === "album");
  await client.sendMessage(
    chatId,
    grouped
      ? `「${pack.name || "未命名"}」共 ${pack.files.length} 个，按 ${VAULT_LIMITS.filePageSize} 个一组发出`
      : `「${pack.name || "未命名"}」共 ${pack.files.length} 个`,
  );
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
    await client.copyMessage(item.chatId, item.messageId, chatId);
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
    await perform(decision, repo, io);
  } catch (error) {
    const chatId = decision.replies[0]?.chatId ?? decision.deliver?.chatId;
    if (chatId) {
      await io.sendMessage(chatId, `没处理成：${explainBot(error) || "请再试一次"}`).catch(() => undefined);
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
  });
}

async function perform(decision: Decision, repo: VaultRepository, io: VaultIO) {
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
      if (!pack) throw new Error("没有这个编号");
      await io.deliver(decision.deliver.chatId, pack, fresh.botId);
    } catch (error) {
      const message = `取回失败：${explainBot(error) || "请再试一次"}`;
      decision.callbackText = message;
      if (!decision.callbackId) await io.sendMessage(decision.deliver.chatId, message);
    }
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
      sent = await sendReply(io, reply);
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
      }, reply.deleteAfterMs);
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

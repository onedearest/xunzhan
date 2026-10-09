import { randomBytes } from "node:crypto";
import { explainBot, type BotClient } from "./bot-client";
import { retrievalPlan } from "./format";
import { reduceVault, type Decision } from "./reduce";
import type { VaultRepository } from "./store";
import { CODE_ALPHABET, VAULT_LIMITS, type InlineButton, type TgUpdate, type VaultItem } from "./types";

export type VaultIO = {
  copyMessage(fromChat: string, messageId: number, toChat: string): Promise<number>;
  sendMessage(chatId: string, text: string, keyboard?: InlineButton[][]): Promise<void>;
  editMessage(chatId: string, messageId: number, text: string, keyboard?: InlineButton[][]): Promise<void>;
  answerCallback(id: string, text?: string): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  deliver(chatId: string, item: VaultItem, currentBotId?: string): Promise<void>;
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
    sendMessage: (chatId, text, keyboard) => client.sendMessage(chatId, text, keyboard).then(() => undefined),
    editMessage: (chatId, messageId, text, keyboard) => client.editMessage(chatId, messageId, text, keyboard),
    answerCallback: (id, text) => client.answerCallback(id, text).then(() => undefined),
    deleteMessage: (chatId, messageId) => client.deleteMessage(chatId, messageId).then(() => undefined),
    deliver: (chatId, item, currentBotId) => deliverItem(client, chatId, item, currentBotId),
  };
}

export async function deliverItem(client: BotClient, chatId: string, item: VaultItem, currentBotId?: string) {
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

async function perform(decision: Decision, repo: VaultRepository, io: VaultIO) {
  if (decision.copy) {
    try {
      const messageId = await io.copyMessage(decision.copy.fromChat, decision.copy.messageId, decision.copy.toChat);
      await repo.update((current) => ({
        ...current,
        items: current.items.map((item) =>
          item.code === decision.copy?.code
            ? { ...item, channelId: decision.copy.toChat, channelMessageId: messageId }
            : item,
        ),
      }));
    } catch (error) {
      const note = `\n\n还没放进仓库频道：${explainBot(error) || "请检查机器人是不是频道管理员"}。编号可以先用。`;
      decision.replies = decision.replies.map((reply) => ({ ...reply, text: `${reply.text}${note}` }));
    }
  }
  if (decision.deliver) {
    try {
      const fresh = await repo.load();
      const item = fresh.items.find((entry) => entry.code === decision.deliver?.code);
      if (!item) throw new Error("没有这个编号");
      await io.deliver(decision.deliver.chatId, item, fresh.botId);
    } catch (error) {
      const message = `取回失败：${explainBot(error) || "请再试一次"}`;
      decision.callbackText = message;
      if (!decision.callbackId) await io.sendMessage(decision.deliver.chatId, message);
    }
  }
  if (decision.removeChannelMessage) {
    await io
      .deleteMessage(decision.removeChannelMessage.channelId, decision.removeChannelMessage.messageId)
      .catch(() => undefined);
  }
  for (const reply of decision.replies) {
    if (reply.kind === "edit" && reply.messageId) {
      try {
        await io.editMessage(reply.chatId, reply.messageId, reply.text, reply.keyboard);
        continue;
      } catch {
        await io.sendMessage(reply.chatId, reply.text, reply.keyboard);
        continue;
      }
    }
    await io.sendMessage(reply.chatId, reply.text, reply.keyboard);
  }
}

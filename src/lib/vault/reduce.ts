import {
  commandOf,
  draftFromMessage,
  isVaultCode,
  listText,
  personName,
  queryItems,
  savedText,
  searchText,
  statsText,
  welcomeText,
} from "./format";
import {
  VAULT_LIMITS,
  type InlineButton,
  type TgChat,
  type TgMessage,
  type TgUpdate,
  type TgUser,
  type VaultData,
  type VaultItem,
} from "./types";

export type Reply = {
  kind: "send" | "edit";
  chatId: string;
  messageId?: number;
  text: string;
  keyboard?: InlineButton[][];
};

export type Decision = {
  replies: Reply[];
  callbackId?: string;
  callbackText?: string;
  copy?: { code: string; fromChat: string; messageId: number; toChat: string };
  deliver?: { chatId: string; code: string };
  removeChannelMessage?: { channelId: string; messageId: number };
  channelHint?: string;
};

type Options = {
  now: string;
  nextCode: () => string;
};

export function reduceVault(data: VaultData, update: TgUpdate, options: Options): { data: VaultData; decision: Decision } {
  const decision: Decision = { replies: [] };
  if (update.my_chat_member?.chat?.type === "channel") {
    return { data: remember(data, update.my_chat_member.chat, options.now), decision };
  }
  if (update.channel_post?.chat?.type === "channel") {
    return { data: remember(data, update.channel_post.chat, options.now), decision };
  }
  if (update.callback_query) return reduceCallback(data, update.callback_query, decision);
  const message = update.message;
  if (!message?.from || message.from.is_bot) return { data, decision };
  const forwarded = forwardedChannel(message);
  const next = forwarded ? remember(data, forwarded, options.now) : data;
  const seenBefore = Boolean(forwarded && data.seenChannels.some((item) => item.id === String(forwarded.id)));
  if (forwarded && !seenBefore && forwarded.id !== Number(data.channelId)) {
    decision.channelHint = `这个频道的编号是 ${forwarded.id}。可以在网页里把它设成仓库。`;
  }
  if (message.chat.type !== "private") {
    const command = commandOf(message.text);
    if (command?.name === "start" || command?.name === "help") {
      decision.replies.push({
        kind: "send",
        chatId: String(message.chat.id),
        text: "存储请私聊我。把文件直接发给我就可以。",
      });
    }
    return { data: next, decision };
  }
  const command = commandOf(message.text);
  if (command) return reduceCommand(next, message, command, decision);
  return reduceIncoming(next, message, decision, options);
}

function reduceCallback(
  data: VaultData,
  query: NonNullable<TgUpdate["callback_query"]>,
  decision: Decision,
): { data: VaultData; decision: Decision } {
  decision.callbackId = query.id;
  const chatId = query.message ? String(query.message.chat.id) : String(query.from.id);
  const messageId = query.message?.message_id;
  const action = parseAction(query.data || "");
  if (!action) {
    decision.callbackText = "这个按钮已经失效了";
    return { data, decision };
  }
  if (action.type === "cancel") {
    decision.callbackText = "已取消";
    decision.replies.push({
      kind: messageId ? "edit" : "send",
      chatId,
      messageId,
      text: "已取消，文件还在。发送 /list 可以再看。",
    });
    return { data, decision };
  }
  if (action.type === "list") {
    const owned = ownedItems(data, query.from.id);
    const listed = queryItems(owned, "", action.page, VAULT_LIMITS.userPageSize);
    decision.callbackText = `第 ${listed.page} 页`;
    decision.replies.push({
      kind: messageId ? "edit" : "send",
      chatId,
      messageId,
      text: listText(listed.items, listed.page, listed.pages, listed.total),
      keyboard: itemKeyboard(listed.items, listed.page, listed.pages),
    });
    return { data, decision };
  }
  const item = data.items.find((entry) => entry.code === action.code);
  if (!item) {
    decision.callbackText = "没有这个编号";
    return { data, decision };
  }
  if (action.type === "get") {
    if (!canRead(data, item, query.from.id)) {
      decision.callbackText = "这个编号只有保存它的人能取回";
      return { data, decision };
    }
    decision.callbackText = "已发给你";
    decision.deliver = { chatId, code: item.code };
    return { data, decision };
  }
  if (item.ownerId !== String(query.from.id)) {
    decision.callbackText = "只能删除自己保存的文件";
    return { data, decision };
  }
  if (action.type === "ask-delete") {
    decision.callbackText = "再确认一次";
    decision.replies.push({
      kind: messageId ? "edit" : "send",
      chatId,
      messageId,
      text: `确定删除「${item.name}」？编号 ${item.code}。删除后分享链接也会失效。`,
      keyboard: [
        [
          { text: "确定删除", callback_data: `y:${item.code}` },
          { text: "取消", callback_data: "x" },
        ],
      ],
    });
    return { data, decision };
  }
  decision.callbackText = "已删除";
  if (item.channelId && item.channelMessageId) {
    decision.removeChannelMessage = { channelId: item.channelId, messageId: item.channelMessageId };
  }
  decision.replies.push({
    kind: messageId ? "edit" : "send",
    chatId,
    messageId,
    text: `已删除「${item.name}」。`,
  });
  return { data: { ...data, items: data.items.filter((entry) => entry.code !== item.code) }, decision };
}

function reduceCommand(
  data: VaultData,
  message: TgMessage,
  command: { name: string; arg: string },
  decision: Decision,
): { data: VaultData; decision: Decision } {
  const chatId = String(message.chat.id);
  const user = message.from as TgUser;
  if (command.name === "start" && command.arg) {
    return deliverCode(data, decision, chatId, user.id, command.arg);
  }
  if (command.name === "start" || command.name === "help") {
    decision.replies.push({
      kind: "send",
      chatId,
      text: withHint(
        welcomeText({
          username: data.botUsername,
          shareLinks: data.shareLinks,
          channelBound: Boolean(data.channelId),
        }),
        decision,
      ),
    });
    return { data, decision };
  }
  if (command.name === "list") {
    const page = positivePage(command.arg);
    const owned = ownedItems(data, user.id);
    const listed = queryItems(owned, "", page, VAULT_LIMITS.userPageSize);
    decision.replies.push({
      kind: "send",
      chatId,
      text: listText(listed.items, listed.page, listed.pages, listed.total),
      keyboard: itemKeyboard(listed.items, listed.page, listed.pages),
    });
    return { data, decision };
  }
  if (command.name === "search") {
    if (!command.arg) {
      decision.replies.push({ kind: "send", chatId, text: "用法：/search 后面跟上文件名里的词。" });
      return { data, decision };
    }
    const owned = ownedItems(data, user.id);
    const found = queryItems(owned, command.arg, 1, VAULT_LIMITS.userPageSize);
    decision.replies.push({
      kind: "send",
      chatId,
      text: searchText(command.arg, found.items, found.total),
      keyboard: itemKeyboard(found.items, 1, 1),
    });
    return { data, decision };
  }
  if (command.name === "get") {
    if (!command.arg) {
      decision.replies.push({ kind: "send", chatId, text: "用法：/get 后面跟上编号。" });
      return { data, decision };
    }
    return deliverCode(data, decision, chatId, user.id, command.arg);
  }
  if (command.name === "del") {
    if (!isVaultCode(command.arg)) {
      decision.replies.push({ kind: "send", chatId, text: "用法：/del 后面跟上编号。" });
      return { data, decision };
    }
    return removeItem(data, decision, chatId, user.id, command.arg);
  }
  if (command.name === "stats") {
    const owned = ownedItems(data, user.id);
    decision.replies.push({
      kind: "send",
      chatId,
      text: statsText(owned, data.channelTitle || data.channelId),
    });
    return { data, decision };
  }
  decision.replies.push({ kind: "send", chatId, text: "没有这个命令。发送 /help 看用法。" });
  return { data, decision };
}

function reduceIncoming(
  data: VaultData,
  message: TgMessage,
  decision: Decision,
  options: Options,
): { data: VaultData; decision: Decision } {
  const chatId = String(message.chat.id);
  const user = message.from as TgUser;
  const draft = draftFromMessage(message);
  if (!draft) {
    decision.replies.push({
      kind: "send",
      chatId,
      text: withHint("这种消息我还存不了。请发文件、图片、视频、语音或文字。", decision),
    });
    return { data, decision };
  }
  const duplicate = data.items.find((item) => item.chatId === chatId && item.messageId === message.message_id);
  if (duplicate) {
    decision.replies.push(savedReply(chatId, duplicate, data, decision));
    return { data, decision };
  }
  if (data.items.length >= VAULT_LIMITS.maxItems) {
    decision.replies.push({ kind: "send", chatId, text: "仓库已满。请在网页里删掉一些旧文件。" });
    return { data, decision };
  }
  const owned = data.items.filter((item) => item.ownerId === String(user.id)).length;
  if (owned >= VAULT_LIMITS.maxPerUser) {
    decision.replies.push({ kind: "send", chatId, text: "你保存的太多了。先用 /del 删掉一些再发。" });
    return { data, decision };
  }
  const item: VaultItem = {
    code: allocateCode(data.items, options.nextCode),
    ownerId: String(user.id),
    ownerName: personName(user),
    ownerUsername: user.username,
    botId: data.botId,
    kind: draft.kind,
    name: draft.name,
    caption: draft.caption,
    text: draft.text,
    mime: draft.mime,
    size: draft.size,
    fileId: draft.fileId,
    chatId,
    messageId: message.message_id,
    createdAt: options.now,
  };
  if (data.channelId) {
    decision.copy = {
      code: item.code,
      fromChat: chatId,
      messageId: message.message_id,
      toChat: data.channelId,
    };
  }
  decision.replies.push(savedReply(chatId, item, data, decision));
  return { data: { ...data, items: [...data.items, item] }, decision };
}

function deliverCode(data: VaultData, decision: Decision, chatId: string, userId: number, code: string) {
  const item = data.items.find((entry) => entry.code === code);
  if (!item || !isVaultCode(code)) {
    decision.replies.push({ kind: "send", chatId, text: "没有这个编号。" });
    return { data, decision };
  }
  if (!canRead(data, item, userId)) {
    decision.replies.push({ kind: "send", chatId, text: "这个编号只有保存它的人能取回。" });
    return { data, decision };
  }
  decision.deliver = { chatId, code: item.code };
  return { data, decision };
}

function removeItem(data: VaultData, decision: Decision, chatId: string, userId: number, code: string) {
  const item = data.items.find((entry) => entry.code === code);
  if (!item) {
    decision.replies.push({ kind: "send", chatId, text: "没有这个编号。" });
    return { data, decision };
  }
  if (item.ownerId !== String(userId)) {
    decision.replies.push({ kind: "send", chatId, text: "只能删除自己保存的文件。" });
    return { data, decision };
  }
  if (item.channelId && item.channelMessageId) {
    decision.removeChannelMessage = { channelId: item.channelId, messageId: item.channelMessageId };
  }
  decision.replies.push({ kind: "send", chatId, text: `已删除「${item.name}」。` });
  return { data: { ...data, items: data.items.filter((entry) => entry.code !== code) }, decision };
}

function savedReply(chatId: string, item: VaultItem, data: VaultData, decision: Decision): Reply {
  return {
    kind: "send",
    chatId,
    text: withHint(savedText(item, { username: data.botUsername, shareLinks: data.shareLinks }), decision),
    keyboard: [
      [
        { text: "取回", callback_data: `g:${item.code}` },
        { text: "删除", callback_data: `d:${item.code}` },
      ],
    ],
  };
}

function itemKeyboard(items: VaultItem[], page: number, pages: number) {
  if (!items.length) return undefined;
  const rows: InlineButton[][] = items.map((item) => [
    { text: `取回 ${item.code}`, callback_data: `g:${item.code}` },
    { text: "删除", callback_data: `d:${item.code}` },
  ]);
  const nav: InlineButton[] = [];
  if (page > 1) nav.push({ text: "上一页", callback_data: `l:${page - 1}` });
  if (page < pages) nav.push({ text: "下一页", callback_data: `l:${page + 1}` });
  if (nav.length) rows.push(nav);
  return rows;
}

function parseAction(data: string) {
  if (data === "x") return { type: "cancel" as const };
  const list = /^l:(\d{1,4})$/.exec(data);
  if (list) return { type: "list" as const, page: Number(list[1]) };
  const get = /^g:([abcdefghjkmnpqrstuvwxyz23456789]{8})$/.exec(data);
  if (get) return { type: "get" as const, code: get[1] };
  const ask = /^d:([abcdefghjkmnpqrstuvwxyz23456789]{8})$/.exec(data);
  if (ask) return { type: "ask-delete" as const, code: ask[1] };
  const yes = /^y:([abcdefghjkmnpqrstuvwxyz23456789]{8})$/.exec(data);
  if (yes) return { type: "confirm-delete" as const, code: yes[1] };
  return null;
}

function ownedItems(data: VaultData, userId: number) {
  return data.items.filter((item) => item.ownerId === String(userId));
}

function canRead(data: VaultData, item: VaultItem, userId: number) {
  return data.shareLinks || item.ownerId === String(userId);
}

function positivePage(arg: string) {
  if (!arg) return 1;
  const page = Number(arg);
  if (!Number.isInteger(page) || page < 1) return 1;
  return page;
}

function allocateCode(items: VaultItem[], nextCode: () => string) {
  const used = new Set(items.map((item) => item.code));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = nextCode();
    if (!isVaultCode(code) || used.has(code)) continue;
    return code;
  }
  throw new Error("生成编号失败");
}

function remember(data: VaultData, chat: TgChat, seenAt: string): VaultData {
  const id = String(chat.id);
  const next = [
    {
      id,
      title: chat.title?.trim() || "未命名频道",
      username: chat.username,
      seenAt,
    },
    ...data.seenChannels.filter((item) => item.id !== id),
  ];
  return { ...data, seenChannels: next.slice(0, VAULT_LIMITS.seenChannels) };
}

function forwardedChannel(message: TgMessage) {
  if (message.forward_origin?.type === "channel" && message.forward_origin.chat?.type === "channel") {
    return message.forward_origin.chat;
  }
  if (message.forward_from_chat?.type === "channel") return message.forward_from_chat;
  return null;
}

function withHint(text: string, decision: Decision) {
  if (!decision.channelHint) return text;
  const hint = decision.channelHint;
  decision.channelHint = undefined;
  return `${text}\n\n${hint}`;
}

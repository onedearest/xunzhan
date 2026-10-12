import {
  codesInText,
  collectingText,
  commandOf,
  draftFromMessage,
  isVaultCode,
  listText,
  menuAction,
  cleanName,
  folderText,
  nameAskText,
  nameProblem,
  packDetailText,
  personName,
  receiveText,
  canStore,
  copyCodeButton,
  guestHomeText,
  noteVisit,
  ownerHomeText,
  savedText,
  storeChoiceText,
  queryItems,
  searchAskText,
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
  type VaultFile,
  type VaultPack,
} from "./types";

export type Reply = {
  kind: "send" | "edit";
  chatId: string;
  messageId?: number;
  text: string;
  keyboard?: InlineButton[][];
  menu?: boolean;
  guest?: boolean;
  bar?: "finish";
  armBar?: "finish" | "menu" | "guest";
  replaceMessageId?: number;
  quiet?: boolean;
  trackOwnerId?: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  deleteAfterMs?: number;
};

export type Decision = {
  replies: Reply[];
  callbackId?: string;
  callbackText?: string;
  copy?: { fromChat: string; messageId: number; toChat: string };
  deliver?: { chatId: string; code: string };
  removeChannelMessages?: { channelId: string; messageId: number }[];
  channelHint?: string;
};

type Options = {
  now: string;
  nextCode: () => string;
};

export function reduceVault(data: VaultData, update: TgUpdate, options: Options): { data: VaultData; decision: Decision } {
  const decision: Decision = { replies: [] };
  if (update.my_chat_member?.chat) {
    const member = update.my_chat_member;
    if (member.chat.type === "channel") return { data: remember(data, member.chat, options.now), decision };
    const status = member.new_chat_member?.status;
    const oldStatus = member.old_chat_member?.status;
    const joined = (!oldStatus || oldStatus === "left" || oldStatus === "kicked") && (status === "member" || status === "administrator");
    if (joined && (member.chat.type === "group" || member.chat.type === "supergroup") && status === "member" && data.readsAllGroupMessages !== true) {
      decision.replies.push({
        kind: "send",
        chatId: String(member.chat.id),
        text: "我还看不见群里的普通消息，所以直接发口令不会有回复。请把我设为管理员，或在 @BotFather 里对这个机器人发送 /setprivacy，选 Disable，然后把我移出群再拉进来。",
      });
    }
    return { data, decision };
  }
  if (update.channel_post?.chat?.type === "channel") {
    return { data: remember(data, update.channel_post.chat, options.now), decision };
  }
  if (update.callback_query) {
    const chat = update.callback_query.message?.chat;
    const visited = !chat || chat.type === "private" ? rememberUser(data, update.callback_query.from, options.now) : data;
    const result = reduceCallback(visited, update.callback_query, decision, options);
    paintGuestMenu(result.data, update.callback_query.from.id, result.decision);
    return result;
  }
  const message = update.message;
  if (!message) return { data, decision };
  if (message.from?.is_bot && !anonymousGroupAdmin(message)) return { data, decision };
  if (message.from && data.botId && String(message.from.id) === data.botId) return { data, decision };
  const forwarded = forwardedChannel(message);
  const next = forwarded ? remember(data, forwarded, options.now) : data;
  const seenBefore = Boolean(forwarded && data.seenChannels.some((item) => item.id === String(forwarded.id)));
  if (forwarded && !seenBefore && forwarded.id !== Number(data.channelId)) {
    decision.channelHint = `这个频道的编号是 ${forwarded.id}。可以在网页里把它设成仓库。`;
  }
  if (message.chat.type !== "private") {
    if (message.is_automatic_forward) return { data: next, decision };
    return reduceGroup(next, message, decision);
  }
  if (!message.from) return { data: next, decision };
  const visited = rememberUser(next, message.from, options.now);
  const command = commandOf(message.text);
  if (command) return finishPrivate(reduceCommand(clearPrompt(visited, message.from.id), message, command, decision, options.now), message.from.id);
  const action = message.text ? menuAction(message.text) : null;
  if (action) return finishPrivate(reduceCommand(clearPrompt(visited, message.from.id), message, { name: action, arg: "" }, decision, options.now), message.from.id);
  return finishPrivate(reduceIncoming(visited, message, decision, options), message.from.id);
}

function rememberUser(data: VaultData, user: TgUser | undefined, now: string) {
  if (!user || user.is_bot) return data;
  return noteVisit(data, String(user.id), now);
}

function finishPrivate(result: { data: VaultData; decision: Decision }, userId: number) {
  paintGuestMenu(result.data, userId, result.decision);
  return result;
}

function paintGuestMenu(data: VaultData, userId: number, decision: Decision) {
  if (canStore(data, userId)) return;
  for (const reply of decision.replies) {
    if (reply.menu) reply.guest = true;
    if (reply.armBar === "menu") reply.armBar = "guest";
  }
}

function reduceGroup(data: VaultData, message: TgMessage, decision: Decision) {
  const threadId = commentThreadId(message);
  const command = commandOf(message.text);
  if (command && ["start", "help", "store", "folders", "list", "search"].includes(command.name)) {
    decision.replies.push({
      kind: "send",
      chatId: String(message.chat.id),
      replyToMessageId: message.message_id,
      messageThreadId: threadId,
      text: "这些功能请私聊我。点「存储」把文件发过来，点 ✅确认 之后再起名称。",
    });
  }
  const looked = codesInText([message.text, message.caption].filter(Boolean).join("\n"));
  if (!looked.length) return { data, decision };
  const notice = {
    kind: "send" as const,
    chatId: String(message.chat.id),
    replyToMessageId: message.message_id,
    messageThreadId: threadId,
    deleteAfterMs: 60_000,
  };
  if (!data.botUsername) {
    decision.replies.push({
      ...notice,
      text: "我还不知道自己的用户名，暂时不能在群里打开文件夹。请到管理页重新接入这个机器人。",
    });
    return { data, decision };
  }
  if (!data.shareLinks) {
    decision.replies.push({
      ...notice,
      text: "分享已关闭，群里不能代打开文件夹。请到管理页打开分享，或让打包的人私聊我。",
    });
    return { data, decision };
  }
  const packs = looked.slice(0, 3).flatMap((code) => {
    const pack = readyPacks(data).find((entry) => entry.code === code);
    return pack?.code ? [pack] : [];
  });
  if (!packs.length) {
    decision.replies.push({ ...notice, text: "没有这个口令。" });
    return { data, decision };
  }
  decision.replies.push({
    ...notice,
    text: packs
      .map((pack) => `「${pack.name || "未命名"}」共 ${pack.files.length} 个文件。\nhttps://t.me/${data.botUsername}?start=${pack.code}`)
      .join("\n"),
    keyboard: packs.map((pack) => [
      {
        text: `打开「${clipName(pack.name)}」`,
        url: `https://t.me/${data.botUsername}?start=${pack.code}`,
      },
    ]),
  });
  return { data, decision };
}

function anonymousGroupAdmin(message: TgMessage) {
  if (message.chat.type !== "group" && message.chat.type !== "supergroup") return false;
  if (message.is_automatic_forward) return false;
  if (message.from?.username?.toLowerCase() === "groupanonymousbot") return true;
  return Boolean(message.sender_chat && String(message.sender_chat.id) === String(message.chat.id));
}

function commentThreadId(message: TgMessage) {
  if (message.message_thread_id) return message.message_thread_id;
  const reply = message.reply_to_message;
  if (!reply) return undefined;
  if (reply.message_thread_id) return reply.message_thread_id;
  if (
    reply.is_automatic_forward ||
    reply.sender_chat?.type === "channel" ||
    reply.forward_from_chat?.type === "channel" ||
    reply.forward_origin?.type === "channel"
  ) {
    return reply.message_id;
  }
  return undefined;
}

function reduceCallback(
  data: VaultData,
  query: NonNullable<TgUpdate["callback_query"]>,
  decision: Decision,
  options: Options,
): { data: VaultData; decision: Decision } {
  decision.callbackId = query.id;
  const chatId = query.message ? String(query.message.chat.id) : String(query.from.id);
  const messageId = query.message?.message_id;
  const action = parseAction(query.data || "");
  if (!action) {
    decision.callbackText = "这个按钮已经失效了";
    return { data, decision };
  }
  if ((action.type === "continue" || action.type === "finish" || action.type === "new-folder" || action.type === "add-recent") && !canStore(data, query.from.id)) {
    return denyStore(data, decision, chatId, query.from.id);
  }
  if (action.type === "continue") {
    const open = openPack(data, query.from.id);
    decision.callbackText = open ? "继续发文件" : "先发文件";
    decision.replies.push({
      kind: "send",
      chatId,
      bar: open ? "finish" : undefined,
      menu: !open,
      text: open ? collectingText(open.files.length) : "还没有待打包的文件。直接把文件发给我。",
    });
    return { data, decision };
  }
  if (action.type === "finish") {
    return askName(data, decision, chatId, query.from.id);
  }
  if (action.type === "drop") {
    const open = openPack(data, query.from.id);
    decision.callbackText = open ? "已取消" : "没有进行中的打包";
    decision.replies.push({
      kind: "send",
      chatId,
      text: open ? "已取消这一组，还没有口令。" : "现在没有还没起名的一组。",
    });
    return open ? { data: dropOpen(data, query.from.id), decision } : { data, decision };
  }
  if (action.type === "cancel") {
    decision.callbackText = "已取消";
    decision.replies.push({
      kind: messageId ? "edit" : "send",
      chatId,
      messageId,
      text: "已取消。点「查看文件夹（打包好的）」可以再看。",
      menu: true,
    });
    return { data, decision };
  }
  if (action.type === "new-folder") {
    return beginNewFolder(data, decision, chatId, query.from, options.now);
  }
  if (action.type === "add-recent") {
    return beginRecent(data, decision, chatId, query.from, options.now);
  }
  if (action.type === "close-store") {
    decision.callbackText = "已关闭";
    decision.replies.push({
      kind: messageId ? "edit" : "send",
      chatId,
      messageId,
      text: "已关闭。",
      menu: true,
    });
    return { data, decision };
  }
  if (action.type === "home") {
    decision.callbackText = "首页";
    return showHome(data, decision, chatId, query.from, options.now);
  }
  if (action.type === "usage") {
    decision.callbackText = "使用说明";
    decision.replies.push({
      kind: "send",
      chatId,
      menu: true,
      text: welcomeText({
        username: data.botUsername,
        shareLinks: data.shareLinks,
        channelBound: Boolean(data.channelId),
        readsAllGroupMessages: data.readsAllGroupMessages,
        canStore: canStore(data, query.from.id),
        userId: String(query.from.id),
      }),
    });
    return { data, decision };
  }
  if (action.type === "edit-ad") {
    if (data.ownerId !== String(query.from.id)) {
      decision.callbackText = "只有创建者可以设置";
      return { data, decision };
    }
    decision.callbackText = "把文案发过来";
    decision.replies.push({
      kind: "send",
      chatId,
      menu: true,
      text: "把普通用户首页要显示的广告文案发过来。可以换行。发送「清空」就恢复默认。",
    });
    return { data: askGuestHome(data, query.from.id), decision };
  }
  if (action.type === "list") {
    const listed = queryPacks(visiblePacks(data, query.from.id), "", action.page, VAULT_LIMITS.userPageSize);
    decision.callbackText = `第 ${listed.page} 页`;
    decision.replies.push({
      kind: messageId ? "edit" : "send",
      chatId,
      messageId,
      text: listText(listed.items, listed.page, listed.pages, listed.total, String(query.from.id), data.shareLinks),
      keyboard: packKeyboard(listed.items, listed.page, listed.pages, String(query.from.id)),
    });
    return { data, decision };
  }
  const pack = readyPacks(data).find((entry) => entry.code === action.code);
  if (!pack?.code) {
    decision.callbackText = "没有这个口令";
    return { data, decision };
  }
  if (action.type === "manage") {
    if (pack.ownerId !== String(query.from.id)) {
      decision.callbackText = "只能管理自己打包的";
      return { data, decision };
    }
    return showFolder(data, decision, chatId, pack, messageId);
  }
  if (action.type === "add") {
    if (!canStore(data, query.from.id)) return denyStore(data, decision, chatId, query.from.id);
    if (pack.ownerId !== String(query.from.id)) {
      decision.callbackText = "只能往自己的文件夹里加文件";
      return { data, decision };
    }
    const open = openPack(data, query.from.id);
    if (open && open.id !== pack.id) {
      decision.callbackText = "先收完正在存的那一组";
      decision.replies.push({
        kind: "send",
        chatId,
        bar: "finish",
        text: "先点 ✅确认 或 ❌取消并退出，再往别的文件夹里加文件。",
      });
      return { data, decision };
    }
    const next: VaultPack = {
      ...pack,
      status: "collecting",
      appendFrom: pack.files.length,
    };
    decision.callbackText = "把文件发过来";
    decision.replies.push(collectingReply({ ...next, noticeMessageId: undefined }, chatId));
    return { data: upsertPack(data, next), decision };
  }
  if (action.type === "rename") {
    if (pack.ownerId !== String(query.from.id)) {
      decision.callbackText = "只能改自己的名称";
      return { data, decision };
    }
    decision.callbackText = "把新名称发过来";
    decision.replies.push({
      kind: "send",
      chatId,
      menu: true,
      text: `现在的名称是「${pack.name || "未命名"}」。\n\n把新名称发过来。`,
    });
    return { data: askRename(data, query.from.id, pack.code), decision };
  }
  if (action.type === "share") {
    if (!canRead(data, pack, query.from.id)) {
      decision.callbackText = "这个文件包只有打包的人能分享";
      return { data, decision };
    }
    decision.callbackText = "可以把这条转出去";
    const link =
      data.shareLinks && data.botUsername && pack.code ? `https://t.me/${data.botUsername}?start=${pack.code}` : "";
    decision.replies.push({
      kind: "send",
      chatId,
      text: link
        ? `「${pack.name || "未命名"}」共 ${pack.files.length} 个文件\n${link}\n\n把这条转给别人，对方打开就能取回。`
        : "分享已关闭，这个口令只有打包的人能取回。",
      keyboard: pack.code ? [[copyCodeButton(pack.code)]] : undefined,
    });
    return { data, decision };
  }
  if (action.type === "get") {
    if (!canRead(data, pack, query.from.id)) {
      decision.callbackText = "这个口令只有打包的人能取回";
      return { data, decision };
    }
    decision.callbackText = "已发给你";
    decision.deliver = { chatId, code: pack.code };
    return { data, decision };
  }
  if (action.type === "view") {
    if (!canRead(data, pack, query.from.id)) {
      decision.callbackText = "这个文件包只有打包的人能看";
      return { data, decision };
    }
    const detail = packDetailText(pack, { username: data.botUsername, shareLinks: data.shareLinks }, action.page);
    decision.callbackText = "这是里面的文件";
    decision.replies.push({
      kind: messageId ? "edit" : "send",
      chatId,
      messageId,
      text: detail.text,
      keyboard: detailKeyboard(pack, String(query.from.id), detail.page, detail.pages),
    });
    return { data, decision };
  }
  if (pack.ownerId !== String(query.from.id)) {
    decision.callbackText = "只能删除自己打包的";
    return { data, decision };
  }
  if (action.type === "ask-delete") {
    decision.callbackText = "再确认一次";
    decision.replies.push({
      kind: messageId ? "edit" : "send",
      chatId,
      messageId,
      text: `确定删除「${pack.name}」？口令 ${pack.code}。删除后链接也会失效。`,
      keyboard: [
        [
          { text: "确定删除", callback_data: `y:${pack.code}` },
          { text: "取消", callback_data: "x" },
        ],
      ],
    });
    return { data, decision };
  }
  decision.callbackText = "已删除";
  decision.removeChannelMessages = channelCopies(pack);
  decision.replies.push({
    kind: messageId ? "edit" : "send",
    chatId,
    messageId,
    text: `已删除「${pack.name}」。`,
  });
  return { data: { ...data, packs: data.packs.filter((entry) => entry.code !== pack.code) }, decision };
}

function reduceCommand(
  data: VaultData,
  message: TgMessage,
  command: { name: string; arg: string },
  decision: Decision,
  now: string,
): { data: VaultData; decision: Decision } {
  const chatId = String(message.chat.id);
  const user = message.from as TgUser;
  if (command.name === "put" || command.name === "folder") {
    return reduceCommand(
      data,
      message,
      { name: command.name === "put" ? "store" : "folders", arg: command.arg },
      decision,
      now,
    );
  }
  if (command.name === "start" && command.arg) {
    return deliverCode(data, decision, chatId, user.id, command.arg);
  }
  if (command.name === "start" || command.name === "help") {
    return showHome(data, decision, chatId, user, now);
  }
  if (command.name === "store") {
    if (!canStore(data, user.id)) return denyStore(data, decision, chatId, user.id);
    decision.replies.push({
      kind: "send",
      chatId,
      text: storeChoiceText(),
      keyboard: [
        [{ text: "📁新建文件夹", callback_data: "w:new" }],
        [{ text: "📩继续添加到最近一次文件夹", callback_data: "w:add" }],
        [{ text: "× 关闭", callback_data: "w:close" }],
      ],
    });
    return { data, decision };
  }
  if (command.name === "finish") {
    if (!canStore(data, user.id)) return denyStore(data, decision, chatId, user.id);
    const open = openPack(data, user.id);
    if (open?.code) return finishAppend(data, decision, user.id);
    return askName(data, decision, chatId, user.id);
  }
  if (command.name === "page-prev" || command.name === "page-next") {
    return turnCollectingPage(data, decision, chatId, user.id);
  }
  if (command.name === "cancel") {
    return cancelOpen(data, decision, chatId, user.id);
  }
  if (command.name === "list" || command.name === "folders") {
    return listPacks(data, decision, chatId, user.id, positivePage(command.arg));
  }
  if (command.name === "search") {
    if (!command.arg) {
      decision.replies.push({ kind: "send", chatId, menu: true, text: searchAskText() });
      return { data: askSearch(data, user.id), decision };
    }
    return searchPacks(data, decision, chatId, user.id, command.arg);
  }
  if (command.name === "get") {
    if (!command.arg) {
      decision.replies.push({ kind: "send", chatId, menu: true, text: "用法：/get 后面跟上口令。也可以点「查看文件夹（打包好的）」。" });
      return { data, decision };
    }
    return deliverCode(data, decision, chatId, user.id, command.arg);
  }
  if (command.name === "del") {
    if (!isVaultCode(command.arg)) {
      decision.replies.push({ kind: "send", chatId, menu: true, text: "用法：/del 后面跟上口令。也可以在文件夹里点删除。" });
      return { data, decision };
    }
    return removePack(data, decision, chatId, user.id, command.arg);
  }
  if (command.name === "stats") {
    decision.replies.push({
      kind: "send",
      chatId,
      menu: true,
      text: statsText(readyPacks(data, user.id), data.channelTitle || data.channelId),
    });
    return { data, decision };
  }
  decision.replies.push({ kind: "send", chatId, menu: true, text: "没有这个命令。点「开始」看用法。" });
  return { data, decision };
}

function listPacks(data: VaultData, decision: Decision, chatId: string, userId: number, page: number) {
  const listed = queryPacks(visiblePacks(data, userId), "", page, VAULT_LIMITS.userPageSize);
  const keyboard = packKeyboard(listed.items, listed.page, listed.pages, String(userId));
  decision.replies.push({
    kind: "send",
    chatId,
    menu: !keyboard,
    text: listText(listed.items, listed.page, listed.pages, listed.total, String(userId), data.shareLinks),
    keyboard,
  });
  return { data, decision };
}

function searchPacks(data: VaultData, decision: Decision, chatId: string, userId: number, query: string) {
  const found = queryPacks(visiblePacks(data, userId), query, 1, VAULT_LIMITS.userPageSize);
  const keyboard = packKeyboard(found.items, 1, 1, String(userId));
  decision.replies.push({
    kind: "send",
    chatId,
    menu: !keyboard,
    text: searchText(query, found.items, found.total, String(userId)),
    keyboard,
  });
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
  const open = openPack(data, user.id);
  const draft = draftFromMessage(message);
  const prompt = (data.prompts ?? []).find((item) => item.ownerId === String(user.id));
  if (prompt?.kind === "guest-home") {
    return saveGuestHome(data, decision, chatId, user.id, draft?.kind === "text" ? draft.text : undefined);
  }
  if (prompt?.kind === "search" && draft?.kind === "text" && draft.text) {
    return searchPacks(clearPrompt(data, user.id), decision, chatId, user.id, draft.text);
  }
  if (prompt?.kind === "rename") {
    if (draft?.kind === "text" && draft.text) {
      return renamePack(clearPrompt(data, user.id), decision, user.id, prompt.code, draft.text);
    }
    decision.replies.push({ kind: "send", chatId, menu: true, text: "新名称是一段文字。把名称发过来。" });
    return { data, decision };
  }
  if (!canStore(data, user.id)) return denyStore(data, decision, chatId, user.id);
  if (open?.status === "naming" && draft?.kind === "text" && draft.text) {
    return finishPack(clearPrompt(data, user.id), decision, user.id, draft.text, options);
  }
  if (!draft || draft.kind === "text") {
    decision.replies.push({
      kind: "send",
      chatId,
      text: withHint(
        open?.status === "naming"
          ? "把名称发过来。名称就是一段文字，不要发命令。"
          : open
            ? "这一组还没收完。继续发文件，或者点底部的 ✅确认。"
            : "把文件、图片、视频或语音发给我。可以连续发，点 ✅确认 之后再起名称。",
        decision,
      ),
      menu: !(open && open.status !== "naming"),
      bar: open && open.status !== "naming" ? "finish" : undefined,
    });
    return { data, decision };
  }
  if (alreadyStored(data, chatId, message.message_id)) {
    decision.replies.push({
      kind: "send",
      chatId,
      bar: open ? "finish" : undefined,
      text: open ? "这份已经收过了。继续发新的文件就会存进来。" : "这份已经收过了。",
    });
    return { data, decision };
  }
  if (countFiles(data) >= VAULT_LIMITS.maxFiles) {
    decision.replies.push({ kind: "send", chatId, text: "仓库已满。请在网页里删掉一些旧的打包。" });
    return { data, decision };
  }
  const ownedReady = readyPacks(data, user.id).length;
  if (!open && ownedReady >= VAULT_LIMITS.maxPacksPerUser) {
    decision.replies.push({ kind: "send", chatId, text: "你打包的太多了。先用 /del 删掉一些。" });
    return { data, decision };
  }
  if (open && open.files.length >= VAULT_LIMITS.maxFilesPerPack) {
    decision.replies.push({
      kind: "send",
      chatId,
      bar: "finish",
      text: `这一组已经有 ${open.files.length} 个了。点底部的 ✅确认 完成存储。`,
    });
    return { data, decision };
  }
  const file: VaultFile = {
    kind: draft.kind,
    name: draft.name,
    caption: draft.caption,
    mime: draft.mime,
    size: draft.size,
    fileId: draft.fileId,
    botId: data.botId,
    chatId,
    messageId: message.message_id,
    mediaGroupId: message.media_group_id,
  };
  const pack = open
    ? { ...open, status: "collecting" as const, files: [...open.files, file] }
    : {
        id: `draft:${user.id}`,
        status: "collecting" as const,
        ownerId: String(user.id),
        ownerName: personName(user),
        ownerUsername: user.username,
        files: [file],
        createdAt: options.now,
      };
  if (data.channelId) {
    decision.copy = { fromChat: chatId, messageId: message.message_id, toChat: data.channelId };
  }
  const hinted = withHint(receiveText(pack.files.length, pack.code ? "add" : "new"), decision);
  decision.replies.push(collectingReply(pack, chatId, hinted));
  return { data: clearPrompt(upsertPack(data, pack), user.id), decision };
}

function askName(data: VaultData, decision: Decision, chatId: string, userId: number) {
  const open = openPack(data, userId);
  if (!open || open.files.length === 0) {
    decision.callbackText = "还没有文件";
    decision.replies.push({
      kind: "send",
      chatId,
      bar: "finish",
      text: "还没有文件。请先发送你要存储的文件，完成后再点 ✅确认。",
    });
    return { data, decision };
  }
  const pack: VaultPack = { ...open, status: "naming" };
  decision.callbackText = "请起个名称";
  decision.replies.push({
    kind: "send",
    chatId,
    menu: true,
    text: nameAskText(),
  });
  return { data: upsertPack(data, pack), decision };
}

function finishPack(data: VaultData, decision: Decision, userId: number, rawName: string, options: Options) {
  const open = openPack(data, userId);
  const chatId = open?.files[0]?.chatId || "";
  const name = cleanName(rawName);
  if (!open || !chatId) return { data, decision };
  const problem = nameProblem(name);
  if (problem) {
    decision.replies.push({ kind: "send", chatId, menu: true, text: problem });
    return { data, decision };
  }
  const code = allocateCode(data.packs, options.nextCode);
  const pack: VaultPack = {
    ...open,
    id: code,
    code,
    status: "ready",
    name,
    readyAt: options.now,
  };
  decision.replies.push({
    kind: "send",
    chatId,
    menu: true,
    text: savedText(pack, { username: data.botUsername, shareLinks: data.shareLinks }),
    keyboard: [
      [copyCodeButton(code)],
      [{ text: "➕继续新建文件夹存储内容", callback_data: "w:new" }],
      [{ text: "📩继续追加到当前文件夹", callback_data: `a:${code}` }],
      [{ text: "< 返回首页", callback_data: "h" }],
    ],
  });
  return { data: clearPrompt(upsertPack(data, pack), userId), decision };
}

function deliverCode(data: VaultData, decision: Decision, chatId: string, userId: number, code: string) {
  const pack = readyPacks(data).find((entry) => entry.code === code);
  if (!pack?.code || !isVaultCode(code)) {
    decision.replies.push({ kind: "send", chatId, text: "没有这个口令。" });
    return { data, decision };
  }
  if (!canRead(data, pack, userId)) {
    decision.replies.push({ kind: "send", chatId, text: "这个口令只有打包的人能取回。" });
    return { data, decision };
  }
  decision.deliver = { chatId, code: pack.code };
  return { data, decision };
}

function removePack(data: VaultData, decision: Decision, chatId: string, userId: number, code: string) {
  const pack = readyPacks(data).find((entry) => entry.code === code);
  if (!pack) {
    decision.replies.push({ kind: "send", chatId, text: "没有这个口令。" });
    return { data, decision };
  }
  if (pack.ownerId !== String(userId)) {
    decision.replies.push({ kind: "send", chatId, text: "只能删除自己打包的。" });
    return { data, decision };
  }
  decision.removeChannelMessages = channelCopies(pack);
  decision.replies.push({ kind: "send", chatId, text: `已删除「${pack.name}」。` });
  return { data: { ...data, packs: data.packs.filter((entry) => entry.code !== code) }, decision };
}

function clearPrompt(data: VaultData, userId: number): VaultData {
  const prompts = (data.prompts ?? []).filter((item) => item.ownerId !== String(userId));
  if (prompts.length === (data.prompts ?? []).length) return data;
  return { ...data, prompts };
}

function showHome(data: VaultData, decision: Decision, chatId: string, user: TgUser, now: string) {
  if (data.ownerId && data.ownerId === String(user.id)) {
    decision.replies.push({
      kind: "send",
      chatId,
      menu: true,
      text: withHint(ownerHomeText(data, now), decision),
      keyboard: [
        [{ text: "✏️ 设置用户首页文案", callback_data: "ad" }],
        [{ text: "📖 使用说明", callback_data: "p" }],
      ],
    });
    return { data, decision };
  }
  decision.replies.push({
    kind: "send",
    chatId,
    menu: true,
    text: withHint(guestHomeText(data, String(user.id)), decision),
  });
  return { data, decision };
}

function askGuestHome(data: VaultData, userId: number): VaultData {
  const prompts = (data.prompts ?? []).filter((item) => item.ownerId !== String(userId));
  return { ...data, prompts: [...prompts, { ownerId: String(userId), kind: "guest-home" }] };
}

function saveGuestHome(data: VaultData, decision: Decision, chatId: string, userId: number, raw?: string) {
  if (data.ownerId !== String(userId)) {
    decision.replies.push({ kind: "send", chatId, menu: true, text: "只有创建者可以设置用户首页。" });
    return { data: clearPrompt(data, userId), decision };
  }
  const text = raw?.trim() ?? "";
  if (!text) {
    decision.replies.push({ kind: "send", chatId, menu: true, text: "文案是一段文字。把广告发过来，或发送「清空」。" });
    return { data, decision };
  }
  if (text === "清空") {
    decision.replies.push({ kind: "send", chatId, menu: true, text: "已恢复默认的用户首页。" });
    return { data: { ...clearPrompt(data, userId), guestHome: undefined }, decision };
  }
  if (text.startsWith("/") || menuAction(text)) {
    decision.replies.push({ kind: "send", chatId, menu: true, text: "这是菜单或命令，不能当成广告。请另写一段文案。" });
    return { data: clearPrompt(data, userId), decision };
  }
  const copy = text.slice(0, 500);
  decision.replies.push({
    kind: "send",
    chatId,
    menu: true,
    text: copy.length < text.length ? "用户首页文案已更新，超长的部分没有保存。" : "用户首页文案已更新。普通用户点首页会看到这段。",
  });
  return { data: { ...clearPrompt(data, userId), guestHome: copy }, decision };
}

function askSearch(data: VaultData, userId: number): VaultData {
  const prompts = (data.prompts ?? []).filter((item) => item.ownerId !== String(userId));
  return { ...data, prompts: [...prompts, { ownerId: String(userId), kind: "search" }] };
}

function finishAppend(data: VaultData, decision: Decision, userId: number) {
  const open = openPack(data, userId);
  const chatId = open?.files[0]?.chatId || "";
  if (!open?.code || !chatId) return askName(data, decision, chatId, userId);
  const pack: VaultPack = { ...open, status: "ready", appendFrom: undefined };
  decision.replies.push(folderReply(data, chatId, pack, true));
  return { data: upsertPack(data, pack), decision };
}

function cancelOpen(data: VaultData, decision: Decision, chatId: string, userId: number) {
  const open = openPack(data, userId);
  if (open?.code) {
    const pack: VaultPack = {
      ...open,
      status: "ready",
      files: open.files.slice(0, open.appendFrom ?? open.files.length),
      appendFrom: undefined,
    };
    decision.replies.push(folderReply(data, chatId, pack, true));
    return { data: upsertPack(data, pack), decision };
  }
  decision.replies.push({
    kind: "send",
    chatId,
    menu: true,
    text: open ? "已取消这一组，还没有口令。" : "现在没有还没起名的一组。",
  });
  return open ? { data: dropOpen(data, userId), decision } : { data, decision };
}

function showFolder(
  data: VaultData,
  decision: Decision,
  chatId: string,
  pack: VaultPack,
  messageId?: number,
) {
  decision.callbackText = pack.name || "文件夹";
  decision.replies.push({ ...folderReply(data, chatId, pack, false), kind: messageId ? "edit" : "send", messageId });
  return { data, decision };
}

function folderReply(data: VaultData, chatId: string, pack: VaultPack, restoreMenu: boolean): Reply {
  return {
    kind: pack.noticeMessageId && restoreMenu ? "edit" : "send",
    chatId,
    messageId: restoreMenu ? pack.noticeMessageId : undefined,
    text: folderText(pack, { username: data.botUsername, shareLinks: data.shareLinks }),
    keyboard: folderKeyboard(pack),
    armBar: restoreMenu ? "menu" : undefined,
  };
}

function askRename(data: VaultData, userId: number, code: string): VaultData {
  const prompts = (data.prompts ?? []).filter((item) => item.ownerId !== String(userId));
  return { ...data, prompts: [...prompts, { ownerId: String(userId), kind: "rename", code }] };
}

function renamePack(data: VaultData, decision: Decision, userId: number, code: string, rawName: string) {
  const chatId = String(userId);
  const pack = readyPacks(data).find((entry) => entry.code === code && entry.ownerId === String(userId));
  const name = cleanName(rawName);
  if (!pack?.code) {
    decision.replies.push({ kind: "send", chatId, menu: true, text: "没有这个口令。" });
    return { data, decision };
  }
  const problem = nameProblem(name);
  if (problem) {
    decision.replies.push({ kind: "send", chatId, menu: true, text: problem });
    return { data, decision };
  }
  const next = { ...pack, name };
  decision.replies.push(folderReply(data, chatId, next, false));
  decision.replies[decision.replies.length - 1]!.menu = true;
  return { data: upsertPack(data, next), decision };
}

function collectingReply(pack: VaultPack, chatId: string, text = receiveText(pack.files.length, pack.code ? "add" : "new")): Reply {
  return {
    kind: "send",
    chatId,
    text,
    bar: "finish",
    replaceMessageId: pack.noticeMessageId,
    quiet: Boolean(pack.noticeMessageId),
    trackOwnerId: pack.ownerId,
  };
}

function beginNewFolder(
  data: VaultData,
  decision: Decision,
  chatId: string,
  user: TgUser,
  now: string,
) {
  const open = openPack(data, user.id);
  if (open?.code) {
    decision.callbackText = "先收完正在追加的文件夹";
    decision.replies.push({
      kind: "send",
      chatId,
      bar: "finish",
      text: "先点 ✅确认 或 ❌取消并退出，再新建文件夹。",
    });
    return { data, decision };
  }
  const pack: VaultPack = open ?? {
    id: `draft:${user.id}`,
    status: "collecting",
    ownerId: String(user.id),
    ownerName: personName(user),
    ownerUsername: user.username,
    files: [],
    createdAt: now,
  };
  decision.callbackText = "请发送文件";
  decision.replies.push(collectingReply(pack, chatId));
  return { data: upsertPack(data, { ...pack, status: "collecting" }), decision };
}

function beginRecent(data: VaultData, decision: Decision, chatId: string, user: TgUser, now: string) {
  const open = openPack(data, user.id);
  if (open && !open.code) {
    decision.callbackText = "先收完新建的文件夹";
    decision.replies.push({
      kind: "send",
      chatId,
      bar: "finish",
      text: "新建的文件夹还没收完。先点 ✅确认 或 ❌取消并退出。",
    });
    return { data, decision };
  }
  const cutoff = Date.parse(now) - 7 * 24 * 60 * 60 * 1000;
  const recent = readyPacks(data, user.id)
    .filter((pack) => Date.parse(pack.readyAt || pack.createdAt) >= cutoff)
    .sort((a, b) => ((a.readyAt || a.createdAt) < (b.readyAt || b.createdAt) ? 1 : -1))[0];
  if (!recent?.code) {
    decision.callbackText = "没有可追加的文件夹";
    decision.replies.push({
      kind: "send",
      chatId,
      text: "7天内没有可以追加的文件夹。请新建一个。",
      keyboard: [[{ text: "📁新建文件夹", callback_data: "w:new" }]],
    });
    return { data, decision };
  }
  const pack: VaultPack = { ...recent, status: "collecting", appendFrom: recent.files.length, noticeMessageId: undefined };
  decision.callbackText = "请发送文件";
  decision.replies.push(collectingReply(pack, chatId));
  return { data: upsertPack(data, pack), decision };
}

function turnCollectingPage(data: VaultData, decision: Decision, chatId: string, userId: number) {
  const open = openPack(data, userId);
  if (!open || open.status === "naming") {
    decision.replies.push({
      kind: "send",
      chatId,
      menu: !open,
      bar: open ? "finish" : undefined,
      text: open ? "先把名称发过来。翻页要等这组还在存文件的时候。" : "还没有正在存的文件。直接发过来就会存入。",
    });
    return { data, decision };
  }
  decision.replies.push(collectingReply(open, chatId, collectingText(open.files.length)));
  return { data, decision };
}

function packKeyboard(packs: VaultPack[], page: number, pages: number, viewerId: string) {
  const ready = packs.filter((pack) => pack.code);
  if (!ready.length) return undefined;
  const rows: InlineButton[][] = ready.map((pack) => {
    const row: InlineButton[] =
      pack.ownerId === viewerId
        ? [
            { text: `管理 ${clipName(pack.name)}`, callback_data: `m:${pack.code}` },
            { text: "取回", callback_data: `g:${pack.code}` },
            { text: "删除", callback_data: `d:${pack.code}` },
          ]
        : [
            { text: `查看 ${clipName(pack.name)}`, callback_data: `v:${pack.code}` },
            { text: "取回", callback_data: `g:${pack.code}` },
          ];
    return row;
  });
  const nav: InlineButton[] = [];
  if (page > 1) nav.push({ text: "上一页", callback_data: `l:${page - 1}` });
  if (page < pages) nav.push({ text: "下一页", callback_data: `l:${page + 1}` });
  if (nav.length) rows.push(nav);
  return rows;
}

function folderKeyboard(pack: VaultPack) {
  const code = pack.code || "";
  return [
    ...(code ? [[copyCodeButton(code)]] : []),
    [
      { text: "📂添加文件", callback_data: `a:${code}` },
      { text: "👀查看内容", callback_data: `v:${code}:1` },
    ],
    [
      { text: "✏️修改名称", callback_data: `n:${code}` },
      { text: "🗑删除", callback_data: `d:${code}` },
    ],
    [
      { text: "取回", callback_data: `g:${code}` },
      { text: "🔗分享给别人", callback_data: `s:${code}` },
    ],
    [{ text: "< 返回", callback_data: "l:1" }],
  ];
}

function detailKeyboard(pack: VaultPack, viewerId: string, page: number, pages: number) {
  const row: InlineButton[] = [{ text: "取回这一组", callback_data: `g:${pack.code}` }];
  if (pack.ownerId === viewerId) row.push({ text: "删除", callback_data: `d:${pack.code}` });
  const rows: InlineButton[][] = pack.code ? [[copyCodeButton(pack.code)], row] : [row];
  const nav: InlineButton[] = [];
  if (page > 1) nav.push({ text: "上一页", callback_data: `v:${pack.code}:${page - 1}` });
  if (page < pages) nav.push({ text: "下一页", callback_data: `v:${pack.code}:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "< 返回", callback_data: pack.ownerId === viewerId ? `m:${pack.code}` : "l:1" }]);
  return rows;
}

function clipName(name?: string) {
  const text = (name || "未命名").replace(/\s+/g, " ").trim();
  return text.length > 12 ? `${text.slice(0, 11)}…` : text;
}

function parseAction(data: string) {
  if (data === "w:new") return { type: "new-folder" as const };
  if (data === "w:add") return { type: "add-recent" as const };
  if (data === "w:close") return { type: "close-store" as const };
  if (data === "h") return { type: "home" as const };
  if (data === "p") return { type: "usage" as const };
  if (data === "ad") return { type: "edit-ad" as const };
  if (data === "c") return { type: "continue" as const };
  if (data === "e") return { type: "finish" as const };
  if (data === "z") return { type: "drop" as const };
  if (data === "x") return { type: "cancel" as const };
  const list = /^l:(\d{1,4})$/.exec(data);
  if (list) return { type: "list" as const, page: Number(list[1]) };
  const codeOf = (prefix: string) => new RegExp(`^${prefix}:([abcdefghjkmnpqrstuvwxyz23456789]{8})$`).exec(data);
  const manage = codeOf("m");
  if (manage) return { type: "manage" as const, code: manage[1] };
  const add = codeOf("a");
  if (add) return { type: "add" as const, code: add[1] };
  const rename = codeOf("n");
  if (rename) return { type: "rename" as const, code: rename[1] };
  const share = codeOf("s");
  if (share) return { type: "share" as const, code: share[1] };
  const get = codeOf("g");
  if (get) return { type: "get" as const, code: get[1] };
  const view = /^v:([abcdefghjkmnpqrstuvwxyz23456789]{8})(?::(\d{1,4}))?$/.exec(data);
  if (view) return { type: "view" as const, code: view[1], page: view[2] ? Number(view[2]) : 1 };
  const ask = /^d:([abcdefghjkmnpqrstuvwxyz23456789]{8})$/.exec(data);
  if (ask) return { type: "ask-delete" as const, code: ask[1] };
  const yes = /^y:([abcdefghjkmnpqrstuvwxyz23456789]{8})$/.exec(data);
  if (yes) return { type: "confirm-delete" as const, code: yes[1] };
  return null;
}

function openPack(data: VaultData, userId: number) {
  return data.packs.find((pack) => pack.ownerId === String(userId) && pack.status !== "ready");
}

function readyPacks(data: VaultData, userId?: number) {
  return data.packs.filter((pack) => pack.status === "ready" && pack.code && (userId === undefined || pack.ownerId === String(userId)));
}

function visiblePacks(data: VaultData, userId: number) {
  return data.shareLinks ? readyPacks(data) : readyPacks(data, userId);
}

function denyStore(data: VaultData, decision: Decision, chatId: string, userId: number) {
  decision.callbackText = "只有创建者或已添加的用户可以存储";
  decision.replies.push({
    kind: "send",
    chatId,
    menu: true,
    text: `只有创建者，或被添加了用户编号的人，才能存储。\n你的用户编号是 ${userId}。需要取回时，把口令发给我。`,
  });
  return { data: releaseOpen(data, userId), decision };
}

function releaseOpen(data: VaultData, userId: number): VaultData {
  const open = openPack(data, userId);
  if (!open) return data;
  if (open.code) {
    return upsertPack(data, {
      ...open,
      status: "ready",
      files: open.files.slice(0, open.appendFrom ?? open.files.length),
      appendFrom: undefined,
      noticeMessageId: undefined,
    });
  }
  return dropOpen(data, userId);
}

function dropOpen(data: VaultData, userId: number): VaultData {
  return { ...data, packs: data.packs.filter((pack) => !(pack.ownerId === String(userId) && pack.status !== "ready")) };
}

function upsertPack(data: VaultData, pack: VaultPack): VaultData {
  const others = data.packs.filter(
    (entry) => entry.id !== pack.id && !(entry.ownerId === pack.ownerId && entry.status !== "ready"),
  );
  return { ...data, packs: [...others, pack] };
}

function alreadyStored(data: VaultData, chatId: string, messageId: number) {
  return data.packs.some((pack) => pack.files.some((file) => file.chatId === chatId && file.messageId === messageId));
}

function countFiles(data: VaultData) {
  return data.packs.reduce((sum, pack) => sum + pack.files.length, 0);
}

function channelCopies(pack: VaultPack) {
  return pack.files
    .filter((file) => file.channelId && file.channelMessageId)
    .map((file) => ({ channelId: file.channelId as string, messageId: file.channelMessageId as number }));
}

function canRead(data: VaultData, pack: VaultPack, userId: number) {
  return data.shareLinks || pack.ownerId === String(userId);
}

function positivePage(arg: string) {
  if (!arg) return 1;
  const page = Number(arg);
  if (!Number.isInteger(page) || page < 1) return 1;
  return page;
}

function allocateCode(packs: VaultPack[], nextCode: () => string) {
  const used = new Set(packs.map((pack) => pack.code).filter((code): code is string => Boolean(code)));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = nextCode();
    if (!isVaultCode(code) || used.has(code)) continue;
    return code;
  }
  throw new Error("生成口令失败");
}

function queryPacks(packs: VaultPack[], query: string, page: number, pageSize: number) {
  const listed = queryItems(
    packs.map((pack) => ({
      ...pack,
      name: pack.name || "",
      code: pack.code || "",
      text: pack.files.map((file) => [file.name, file.caption].filter(Boolean).join(" ")).join("\n"),
      createdAt: pack.readyAt || pack.createdAt,
    })),
    query,
    page,
    pageSize,
  );
  return listed;
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

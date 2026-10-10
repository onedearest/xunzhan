import {
  codesInText,
  collectingText,
  commandOf,
  draftFromMessage,
  isVaultCode,
  listText,
  menuAction,
  packDetailText,
  packedText,
  personName,
  queryItems,
  searchAskText,
  searchText,
  statsText,
  storeText,
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
  bar?: "finish";
  armBar?: "finish";
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
    return reduceGroup(next, message, decision);
  }
  const command = commandOf(message.text);
  if (command) return reduceCommand(clearPrompt(next, message.from.id), message, command, decision);
  const action = message.text ? menuAction(message.text) : null;
  if (action) return reduceCommand(clearPrompt(next, message.from.id), message, { name: action, arg: "" }, decision);
  return reduceIncoming(next, message, decision, options);
}

function reduceGroup(data: VaultData, message: TgMessage, decision: Decision) {
  const command = commandOf(message.text);
  if (command && ["start", "help", "store", "folders", "list", "search"].includes(command.name)) {
    decision.replies.push({
      kind: "send",
      chatId: String(message.chat.id),
      replyToMessageId: message.message_id,
      messageThreadId: message.message_thread_id,
      text: "这些功能请私聊我。点「存储」把文件发过来，结束之后再起名称。",
    });
  }
  if (!data.shareLinks || !data.botUsername) return { data, decision };
  const packs = codesInText([message.text, message.caption].filter(Boolean).join("\n"))
    .slice(0, 3)
    .flatMap((code) => {
      const pack = readyPacks(data).find((entry) => entry.code === code);
      return pack?.code ? [pack] : [];
    });
  if (!packs.length) return { data, decision };
  decision.replies.push({
    kind: "send",
    chatId: String(message.chat.id),
    replyToMessageId: message.message_id,
    messageThreadId: message.message_thread_id,
    deleteAfterMs: 60_000,
    text: packs.map((pack) => `「${pack.name || "未命名"}」共 ${pack.files.length} 个文件`).join("\n"),
    keyboard: packs.map((pack) => [
      {
        text: `打开「${clipName(pack.name)}」`,
        url: `https://t.me/${data.botUsername}?start=${pack.code}`,
      },
    ]),
  });
  return { data, decision };
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
  if (action.type === "continue") {
    const open = openPack(data, query.from.id);
    decision.callbackText = open ? "继续发文件" : "先发文件";
    decision.replies.push({
      kind: "send",
      chatId,
      bar: open ? "finish" : undefined,
      menu: !open,
      text: open ? "继续把文件发过来就会存进来。收完点下面的「结束」。" : "还没有待打包的文件。直接把文件发给我。",
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
      text: open ? "已取消这一组，还没有编号。" : "现在没有还没起名的一组。",
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
    decision.callbackText = "没有这个编号";
    return { data, decision };
  }
  if (action.type === "get") {
    if (!canRead(data, pack, query.from.id)) {
      decision.callbackText = "这个编号只有打包的人能取回";
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
      text: `确定删除「${pack.name}」？编号 ${pack.code}。删除后链接也会失效。`,
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
      menu: true,
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
  if (command.name === "store") {
    const open = openPack(data, user.id);
    const naming = open?.status === "naming";
    const collecting = Boolean(open && !naming);
    decision.replies.push({
      kind: "send",
      chatId,
      menu: !collecting && !naming,
      bar: collecting ? "finish" : undefined,
      text: storeText(open ? { status: naming ? "naming" : "collecting", count: open.files.length } : undefined),
      keyboard: naming ? [[{ text: "取消这组", callback_data: "z" }]] : undefined,
    });
    return { data, decision };
  }
  if (command.name === "finish") {
    return askName(data, decision, chatId, user.id);
  }
  if (command.name === "page-prev" || command.name === "page-next") {
    return turnCollectingPage(data, decision, chatId, user.id, command.name === "page-next" ? 1 : -1);
  }
  if (command.name === "cancel") {
    const open = openPack(data, user.id);
    decision.replies.push({
      kind: "send",
      chatId,
      menu: true,
      text: open ? "已取消这一组，还没有编号。" : "现在没有还没起名的一组。",
    });
    return open ? { data: dropOpen(data, user.id), decision } : { data, decision };
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
      decision.replies.push({ kind: "send", chatId, menu: true, text: "用法：/get 后面跟上编号。也可以点「查看文件夹（打包好的）」。" });
      return { data, decision };
    }
    return deliverCode(data, decision, chatId, user.id, command.arg);
  }
  if (command.name === "del") {
    if (!isVaultCode(command.arg)) {
      decision.replies.push({ kind: "send", chatId, menu: true, text: "用法：/del 后面跟上编号。也可以在文件夹里点删除。" });
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
  const searching = (data.prompts ?? []).some((item) => item.ownerId === String(user.id) && item.kind === "search");
  if (searching && draft?.kind === "text" && draft.text) {
    return searchPacks(clearPrompt(data, user.id), decision, chatId, user.id, draft.text);
  }
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
            ? "这一组还没收完。继续发文件，或者点「结束」再起名称。"
            : "把文件、图片、视频或语音发给我。可以连续发，结束之后再起名称。",
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
      text: `这一组已经有 ${open.files.length} 个了。点下面的「结束」，再起个名称。`,
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
  const shown = collectingText(pack.files);
  const hinted = withHint(shown.text, decision);
  decision.replies.push(collectingReply({ ...pack, noticePage: shown.page }, chatId, hinted));
  return { data: clearPrompt(upsertPack(data, { ...pack, noticePage: shown.page }), user.id), decision };
}

function askName(data: VaultData, decision: Decision, chatId: string, userId: number) {
  const open = openPack(data, userId);
  if (!open || open.files.length === 0) {
    decision.callbackText = "还没有文件";
    decision.replies.push({ kind: "send", chatId, menu: true, text: "还没有文件。先把要存的文件发给我。" });
    return { data, decision };
  }
  const pack: VaultPack = { ...open, status: "naming" };
  decision.callbackText = "请起个名称";
  decision.replies.push({
    kind: "send",
    chatId,
    menu: true,
    text: `这一组有 ${pack.files.length} 个文件。\n\n把名称发过来，我再生成编号和链接。不想要了就发 /cancel。`,
  });
  return { data: upsertPack(data, pack), decision };
}

function finishPack(data: VaultData, decision: Decision, userId: number, rawName: string, options: Options) {
  const open = openPack(data, userId);
  const chatId = open?.files[0]?.chatId || "";
  const name = rawName.replace(/\s+/g, " ").trim();
  if (!open || !chatId) return { data, decision };
  if (!name) {
    decision.replies.push({ kind: "send", chatId, text: "名称不能为空。再发一次。" });
    return { data, decision };
  }
  const code = allocateCode(data.packs, options.nextCode);
  const pack: VaultPack = {
    ...open,
    id: code,
    code,
    status: "ready",
    name: name.slice(0, 80),
    readyAt: options.now,
  };
  decision.replies.push({
    kind: "send",
    chatId,
    text: packedText(pack, { username: data.botUsername, shareLinks: data.shareLinks }),
    keyboard: [
      [
        { text: "取回", callback_data: `g:${code}` },
        { text: "删除", callback_data: `d:${code}` },
      ],
    ],
  });
  return { data: clearPrompt(upsertPack(data, pack), userId), decision };
}

function deliverCode(data: VaultData, decision: Decision, chatId: string, userId: number, code: string) {
  const pack = readyPacks(data).find((entry) => entry.code === code);
  if (!pack?.code || !isVaultCode(code)) {
    decision.replies.push({ kind: "send", chatId, text: "没有这个编号。" });
    return { data, decision };
  }
  if (!canRead(data, pack, userId)) {
    decision.replies.push({ kind: "send", chatId, text: "这个编号只有打包的人能取回。" });
    return { data, decision };
  }
  decision.deliver = { chatId, code: pack.code };
  return { data, decision };
}

function removePack(data: VaultData, decision: Decision, chatId: string, userId: number, code: string) {
  const pack = readyPacks(data).find((entry) => entry.code === code);
  if (!pack) {
    decision.replies.push({ kind: "send", chatId, text: "没有这个编号。" });
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

function askSearch(data: VaultData, userId: number): VaultData {
  const prompts = (data.prompts ?? []).filter((item) => item.ownerId !== String(userId));
  return { ...data, prompts: [...prompts, { ownerId: String(userId), kind: "search" }] };
}

function collectingReply(pack: VaultPack, chatId: string, text: string): Reply {
  if (pack.noticeMessageId) {
    return { kind: "edit", chatId, messageId: pack.noticeMessageId, text, trackOwnerId: pack.ownerId };
  }
  return { kind: "send", chatId, text, armBar: "finish", trackOwnerId: pack.ownerId };
}

function turnCollectingPage(data: VaultData, decision: Decision, chatId: string, userId: number, delta: number) {
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
  const current = open.noticePage ?? Math.max(1, Math.ceil(open.files.length / VAULT_LIMITS.filePageSize));
  const shown = collectingText(open.files, current + delta);
  if (shown.page === current) {
    decision.replies.push({
      kind: "send",
      chatId,
      bar: "finish",
      text: delta < 0 ? "已经是第一页。" : "已经是最后一页。",
    });
    return { data, decision };
  }
  const pack = { ...open, noticePage: shown.page };
  decision.replies.push(collectingReply(pack, chatId, shown.text));
  return { data: upsertPack(data, pack), decision };
}

function packKeyboard(packs: VaultPack[], page: number, pages: number, viewerId: string) {
  const ready = packs.filter((pack) => pack.code);
  if (!ready.length) return undefined;
  const rows: InlineButton[][] = ready.map((pack) => {
    const row: InlineButton[] = [
      { text: `查看 ${clipName(pack.name)}`, callback_data: `v:${pack.code}` },
      { text: "取回", callback_data: `g:${pack.code}` },
    ];
    if (pack.ownerId === viewerId) row.push({ text: "删除", callback_data: `d:${pack.code}` });
    return row;
  });
  const nav: InlineButton[] = [];
  if (page > 1) nav.push({ text: "上一页", callback_data: `l:${page - 1}` });
  if (page < pages) nav.push({ text: "下一页", callback_data: `l:${page + 1}` });
  if (nav.length) rows.push(nav);
  return rows;
}

function detailKeyboard(pack: VaultPack, viewerId: string, page: number, pages: number) {
  const row: InlineButton[] = [{ text: "取回这一组", callback_data: `g:${pack.code}` }];
  if (pack.ownerId === viewerId) row.push({ text: "删除", callback_data: `d:${pack.code}` });
  const rows = [row];
  const nav: InlineButton[] = [];
  if (page > 1) nav.push({ text: "上一页", callback_data: `v:${pack.code}:${page - 1}` });
  if (page < pages) nav.push({ text: "下一页", callback_data: `v:${pack.code}:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: "返回文件夹", callback_data: "l:1" }]);
  return rows;
}

function clipName(name?: string) {
  const text = (name || "未命名").replace(/\s+/g, " ").trim();
  return text.length > 12 ? `${text.slice(0, 11)}…` : text;
}

function parseAction(data: string) {
  if (data === "c") return { type: "continue" as const };
  if (data === "e") return { type: "finish" as const };
  if (data === "z") return { type: "drop" as const };
  if (data === "x") return { type: "cancel" as const };
  const list = /^l:(\d{1,4})$/.exec(data);
  if (list) return { type: "list" as const, page: Number(list[1]) };
  const get = /^g:([abcdefghjkmnpqrstuvwxyz23456789]{8})$/.exec(data);
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

function dropOpen(data: VaultData, userId: number): VaultData {
  return { ...data, packs: data.packs.filter((pack) => !(pack.ownerId === String(userId) && pack.status !== "ready")) };
}

function upsertPack(data: VaultData, pack: VaultPack): VaultData {
  const rest = data.packs.filter((entry) => entry.id !== pack.id && !(entry.ownerId === pack.ownerId && entry.status !== "ready" && pack.status === "ready"));
  const withoutOldDraft = data.packs.filter((entry) => entry.ownerId !== pack.ownerId || entry.status === "ready");
  if (pack.status === "ready") return { ...data, packs: [...withoutOldDraft, pack] };
  return { ...data, packs: [...rest.filter((entry) => entry.id !== pack.id), pack] };
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
  throw new Error("生成编号失败");
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

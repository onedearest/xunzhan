import {
  CODE_ALPHABET,
  VAULT_LIMITS,
  type Draft,
  type InlineButton,
  type TgMessage,
  type VaultData,
  type VaultFile,
  type VaultKind,
  type VaultPack,
} from "./types";

export const kindLabel: Record<VaultKind, string> = {
  text: "文字",
  document: "文件",
  photo: "图片",
  video: "视频",
  audio: "音频",
  voice: "语音",
  animation: "动图",
  sticker: "贴纸",
  video_note: "圆形视频",
};

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${VAULT_LIMITS.codeLength}}$`);

export function isVaultCode(value: string) {
  return CODE_PATTERN.test(value);
}

export function codesInText(text: string) {
  const found: string[] = [];
  const normalized = text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .toLowerCase();
  for (const run of normalized.match(/[a-z0-9]+/g) ?? []) {
    const windows = run.length === VAULT_LIMITS.codeLength ? [run] : [];
    if (run.length > VAULT_LIMITS.codeLength && run.length <= 24) {
      for (let index = 0; index + VAULT_LIMITS.codeLength <= run.length; index += 1) {
        windows.push(run.slice(index, index + VAULT_LIMITS.codeLength));
      }
    }
    for (const code of windows) {
      if (!isVaultCode(code) || found.includes(code)) continue;
      found.push(code);
    }
  }
  return found;
}

export function maskToken(token: string) {
  const [id, secret] = token.split(":");
  if (!id || !secret) return "";
  return `${id}:••••${secret.slice(-4)}`;
}

export function clip(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

export function formatSize(size?: number) {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${trimNumber(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024) return `${trimNumber(size / 1024 / 1024)} MB`;
  return `${trimNumber(size / 1024 / 1024 / 1024)} GB`;
}

function trimNumber(value: number) {
  const digits = value >= 10 ? 0 : 1;
  return value.toFixed(digits).replace(/\.0$/, "");
}

export function personName(user: { id: number; first_name?: string; last_name?: string; username?: string }) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || (user.username ? `@${user.username}` : String(user.id));
}

export function commandOf(text?: string) {
  if (!text?.startsWith("/")) return null;
  const [head, ...rest] = text.trim().split(/\s+/);
  const name = head.slice(1).split("@")[0]?.toLowerCase();
  if (!name || !/^[a-z0-9_]+$/.test(name)) return null;
  return { name, arg: rest.join(" ").trim() };
}

export function normalizeChannel(input: string) {
  const text = input.trim();
  if (!text) return "";
  if (/t\.me\/(\+|joinchat)/i.test(text)) {
    throw new Error("请用频道的公开链接、@用户名，或 -100 开头的编号。邀请链接不能当作仓库。");
  }
  const privateLink = text.match(/t\.me\/c\/(\d{6,20})/i);
  if (privateLink) return `-100${privateLink[1]}`;
  const publicLink = text.match(/t\.me\/([A-Za-z][A-Za-z0-9_]{3,})/i);
  if (publicLink) return `@${publicLink[1]}`;
  if (/^@[A-Za-z][A-Za-z0-9_]{3,}$/.test(text)) return text;
  if (/^-\d{6,20}$/.test(text)) return text;
  throw new Error("频道请填 -100 开头的编号、@用户名，或 t.me 链接。");
}

export function draftFromMessage(message: TgMessage): Draft | null {
  const caption = message.caption?.trim() || undefined;
  if (message.document?.file_id) {
    return fileDraft("document", message.document.file_name || "文件", message.document, caption);
  }
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    if (photo?.file_id) return fileDraft("photo", "图片", photo, caption);
  }
  if (message.video?.file_id) return fileDraft("video", message.video.file_name || "视频", message.video, caption);
  if (message.animation?.file_id) {
    return fileDraft("animation", message.animation.file_name || "动图", message.animation, caption);
  }
  if (message.audio?.file_id) {
    return fileDraft("audio", message.audio.title || message.audio.file_name || "音频", message.audio, caption);
  }
  if (message.voice?.file_id) return fileDraft("voice", "语音", message.voice, caption);
  if (message.video_note?.file_id) return fileDraft("video_note", "圆形视频", message.video_note, caption);
  if (message.sticker?.file_id) {
    return fileDraft("sticker", message.sticker.emoji ? `贴纸 ${message.sticker.emoji}` : "贴纸", message.sticker);
  }
  const text = message.text?.trim();
  if (!text || commandOf(text)) return null;
  const first = text.split("\n")[0] || "文字";
  return {
    kind: "text",
    name: clip(first, 40) || "文字",
    text: text.slice(0, 4096),
  };
}

function fileDraft(kind: VaultKind, name: string, file: { file_id: string; file_size?: number; mime_type?: string }, caption?: string): Draft {
  return {
    kind,
    name: clip(name, 180) || kindLabel[kind],
    caption: caption ? caption.slice(0, 1024) : undefined,
    mime: file.mime_type,
    size: typeof file.file_size === "number" ? file.file_size : undefined,
    fileId: file.file_id,
  };
}

export const MENU = {
  home: "🏠首页",
  get: "📩获取",
  store: "📩存储",
  folders: "📚管理文件夹",
} as const;

export function menuKeyboard(admin = true) {
  const top = [{ text: MENU.get }, { text: MENU.home }];
  if (!admin) return [top, [{ text: MENU.folders }]];
  return [top, [{ text: MENU.store }, { text: MENU.folders }]];
}

export function storageUsers(data: { adminIds?: string[] }) {
  return [...new Set((data.adminIds ?? []).filter((id) => /^\d{1,16}$/.test(id)))];
}

export function canStore(data: { ownerId?: string; adminIds?: string[] }, userId: number | string) {
  const id = String(userId);
  if (data.ownerId && data.ownerId === id) return true;
  return storageUsers(data).includes(id);
}

export const COLLECT = {
  cancel: "❌取消并退出",
  confirm: "✅确认",
} as const;

export function collectingBar() {
  return [[{ text: COLLECT.cancel }, { text: COLLECT.confirm }]];
}

export function menuAction(text: string) {
  const value = text.trim();
  if (value === MENU.home || value === "首页" || value === "开始") return "start" as const;
  if (value === MENU.store || value === "存储") return "store" as const;
  if (value === MENU.get || value === "获取") return "get" as const;
  if (value === MENU.folders || value === "管理文件夹" || value === "查看文件夹" || value === "查看文件夹（打包好的）") {
    return "folders" as const;
  }
  if (value === "搜索关键词") return "search" as const;
  if (value === COLLECT.confirm || value === "确认" || value === "结束") return "finish" as const;
  if (value === COLLECT.cancel || value === "取消并退出") return "cancel" as const;
  if (value === "上一页") return "page-prev" as const;
  if (value === "下一页") return "page-next" as const;
  return null;
}

export function filePage<T>(items: T[], requested?: number) {
  const pages = Math.max(1, Math.ceil(items.length / VAULT_LIMITS.filePageSize));
  const page = Math.min(pages, Math.max(1, requested ?? pages));
  const start = (page - 1) * VAULT_LIMITS.filePageSize;
  return { page, pages, start, slice: items.slice(start, start + VAULT_LIMITS.filePageSize) };
}

export function collectingText(count: number) {
  return receiveText(count, "new");
}

export function storeChoiceText() {
  return [
    "📁选择存储方式",
    "· 新建文件夹：上传后输入文件夹名称",
    "· 继续添加：追加到最近一次文件夹（7天内有效）",
    "",
    "👇请选择：",
  ].join("\n");
}

export function receiveText(count: number, mode: "new" | "add") {
  const lines = [
    mode === "add" ? "📩继续添加到当前文件夹：" : "📁新建文件夹：",
    "📩 请发送你要存储的文件",
  ];
  if (count > 0) lines.push("", `已接收你发送的第${count}个文件`);
  lines.push("", "💡 可以分多次发送多个文件作为一组一起存储，完成后点击 ✅确认 进行存储");
  return lines.join("\n");
}

export function nameAskText() {
  return ["📝 请输入文件夹名称（至少5个字符）", "", "‼️ 温馨提示：", "◆ 请勿随意填写名称！否则将被封禁！"].join("\n");
}

export function cleanName(raw: string) {
  return raw.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean).join("\n").slice(0, 200);
}

export function nameProblem(name: string) {
  if (!name) return "名称不能为空。再发一次。";
  if ([...name.replace(/\n/g, "")].length < 5) return "名称至少 5 个字符。再发一次。";
  return "";
}

export function copyCodeButton(code: string): InlineButton {
  return { text: `口令 ${code}`, copy_text: { text: code } };
}

export function savedText(pack: VaultPack, options: { username?: string; shareLinks: boolean }) {
  const lines = [
    "✅ 文件存储成功！",
    "",
    `📁 文件夹名称：${pack.name}`,
    "",
    `📦 数量：${pack.files.length}`,
    `🔑 口令：${pack.code}`,
    "点下方的口令即可复制。",
  ];
  if (options.shareLinks && options.username && pack.code) {
    lines.push(`🔗 分享链接：https://t.me/${options.username}?start=${pack.code}`);
  } else {
    lines.push("分享已关闭，只有你自己能取回。");
  }
  return lines.join("\n");
}

export function storeText(open?: { status: "collecting" | "naming"; count: number }) {
  if (open?.status === "naming") {
    return `这一组有 ${open.count} 个文件。\n\n把名称发过来，我再生成口令和链接。`;
  }
  if (open?.status === "collecting") {
    return collectingText(open.count);
  }
  return ["直接把文件、图片、视频或语音发给我，可以连续发。", "收完点底部的 ✅确认，再起个名称。我才会生成口令和链接。"].join("\n");
}

export function searchAskText() {
  return "把关键词发过来。我在已经打包的文件夹里按名称找。";
}

export function shanghaiDay(iso: string) {
  const time = Date.parse(iso);
  const shifted = new Date((Number.isFinite(time) ? time : Date.now()) + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

export function shiftDay(day: string, days: number) {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(time + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function noteVisit(data: VaultData, userId: string, now: string): VaultData {
  if (!/^\d{1,16}$/.test(userId)) return data;
  const users = data.seenUsers ?? [];
  const found = users.find((user) => user.id === userId);
  if (found) {
    if (found.lastSeen === now) return data;
    const sameDay = shanghaiDay(found.lastSeen) === shanghaiDay(now);
    const next = sameDay ? { ...found, lastSeen: now } : { ...found, prevSeen: found.lastSeen, lastSeen: now };
    return { ...data, seenUsers: users.map((user) => (user.id === userId ? next : user)) };
  }
  if (users.length >= 20000) return data;
  return { ...data, seenUsers: [...users, { id: userId, firstSeen: now, lastSeen: now }] };
}

export function noteDelivery(data: VaultData, count: number, now: string): VaultData {
  if (!Number.isFinite(count) || count <= 0) return data;
  const added = Math.floor(count);
  const day = shanghaiDay(now);
  const days = data.deliveryDays ?? [];
  const existing = days.find((item) => item.day === day);
  const next = existing
    ? days.map((item) => (item.day === day ? { ...item, count: item.count + added } : item))
    : [...days, { day, count: added }];
  const keepFrom = shiftDay(day, -40);
  return {
    ...data,
    deliveries: (data.deliveries ?? 0) + added,
    deliveryDays: next.filter((item) => item.day >= keepFrom).slice(-40),
  };
}

function operatingStart(data: VaultData) {
  const stamps = [data.openedAt, data.connectedAt, ...data.packs.map((pack) => pack.createdAt)].filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  if (!stamps.length) return undefined;
  return stamps.reduce((earliest, item) => (item < earliest ? item : earliest));
}

export function ownerHomeText(data: VaultData, now: string) {
  const day = shanghaiDay(now);
  const yesterday = shiftDay(day, -1);
  const files = data.packs.filter((pack) => pack.status === "ready").reduce((sum, pack) => sum + pack.files.length, 0);
  const users = data.seenUsers ?? [];
  const start = operatingStart(data);
  const days = start ? Math.floor((Date.parse(day) - Date.parse(shanghaiDay(start))) / 86400000) + 1 : 1;
  const yesterdaySent = (data.deliveryDays ?? []).find((item) => item.day === yesterday)?.count ?? 0;
  return [
    "⚙️ 管理员设置菜单（创建者能看到）",
    `📁Bot已存文件数：${files}`,
    "",
    `📊Bot 运营数据（截止到 ${day}）`,
    `累计运营时间：${days} 天`,
    `累计用户数：${users.length}`,
    "会员数：0",
    `昨日新增用户数：${users.filter((user) => shanghaiDay(user.firstSeen) === yesterday).length}`,
    `昨日访问用户数：${users.filter((user) => shanghaiDay(user.lastSeen) === yesterday || (user.prevSeen ? shanghaiDay(user.prevSeen) === yesterday : false)).length}`,
    `累计下发文件次数：${data.deliveries ?? 0}`,
    `昨日下发文件次数：${yesterdaySent}`,
    "",
    "💴账户余额：$ 0.00",
    "提现中：$ 0.00",
    "已提结：$ 0.00",
  ].join("\n");
}

export function ownerHomeKeyboard(): InlineButton[][] {
  return [
    [{ text: "📥存储", callback_data: "k:put" }, { text: "📁管理文件夹", callback_data: "k:dir" }],
    [{ text: "🔔强制关注", callback_data: "k:sub" }, { text: "💰设置价格", callback_data: "k:fee" }],
    [{ text: "👥管理员设置", callback_data: "k:adm" }, { text: "💎会员管理", callback_data: "k:vip" }],
    [{ text: "📝START文案设置", callback_data: "k:sta" }, { text: "🏳️自定义广告", callback_data: "k:ads" }],
    [{ text: "⏰文件定时销毁", callback_data: "k:die" }, { text: "🚫是否允许下载和转发", callback_data: "k:fwd" }],
    [{ text: "📣全员推送", callback_data: "k:all" }, { text: "📍自动频道推送", callback_data: "k:chn" }],
    [{ text: "♻️资源备份", callback_data: "k:bak" }, { text: "🔧重启机器人", callback_data: "k:reb" }],
    [{ text: "📋订单记录", callback_data: "k:ord" }, { text: "💵收益提现", callback_data: "k:pay" }],
    [{ text: "💡功能和使用流程介绍", callback_data: "k:doc" }, { text: "💬联系客服", callback_data: "k:sup" }],
  ];
}

export function userHomeKeyboard(canStoreFiles: boolean): InlineButton[][] {
  return canStoreFiles
    ? [
        [{ text: "📥存储", callback_data: "k:put" }, { text: "📁管理文件夹", callback_data: "k:dir" }],
        [{ text: "💡功能和使用流程介绍", callback_data: "k:doc" }, { text: "💬联系客服", callback_data: "k:sup" }],
      ]
    : [
        [{ text: "📩获取", callback_data: "k:get" }, { text: "📁查看文件夹", callback_data: "k:dir" }],
        [{ text: "💡功能和使用流程介绍", callback_data: "k:doc" }, { text: "💬联系客服", callback_data: "k:sup" }],
      ];
}

export function guestHomeText(data: VaultData, userId: string) {
  const custom = data.guestHome?.trim();
  const lines = [
    custom ||
      ["把口令发过来就能取回文件。", "", "📩获取：按口令取回", "📚管理文件夹：看已经分享的文件夹", "", "/get 口令"].join("\n"),
  ];
  if (!canStore(data, userId)) {
    lines.push("", `你的用户编号是 ${userId}。只有创建者，或被添加了这个编号的人，才能存储。`);
  } else if (data.ownerId !== userId) {
    lines.push("", "你已被允许存储。");
  }
  return lines.join("\n");
}

export function welcomeText(options: { username?: string; shareLinks: boolean; channelBound: boolean; readsAllGroupMessages?: boolean; canStore?: boolean; userId?: string }) {
  if (options.canStore === false) {
    const lines = [
      "把口令发过来就能取回文件。",
      "",
      "📩获取：按口令取回",
      "📚管理文件夹：看已经分享的文件夹",
      "",
      "/get 口令",
    ];
    if (options.userId) lines.push("", `你的用户编号是 ${options.userId}。只有创建者，或被添加了这个编号的人，才能存储。`);
    if (options.shareLinks && options.username) lines.push("", `链接的样子：https://t.me/${options.username}?start=口令`);
    return lines.join("\n");
  }
  const lines = [
    "用底部的四个按钮就行。",
    "",
    "🏠首页：看这段说明",
    "📩存储：把文件发过来。底部会换成「取消并退出」和「确认」",
    "📩获取：按口令取回",
    "📚管理文件夹：看已经打包的，自己的可以追加文件、改名称",
    "",
    "/get 口令 取回这一组",
    "/del 口令 删除这一组",
    "/cancel 取消还没起名的一组",
    "/stats 查看用量",
  ];
  if (options.shareLinks && options.username) {
    lines.push("", `链接的样子：https://t.me/${options.username}?start=口令`);
    lines.push("打开链接就能取回这一整组。");
  } else if (!options.shareLinks) {
    lines.push("", "分享已关闭，只有打包的人自己能取回。");
  }
  if (!options.channelBound) {
    lines.push("", "文件留在 Telegram 上。网页里如果绑定了私密频道，会再复制一份进去。");
  }
  if (options.readsAllGroupMessages === false) {
    lines.push("", "群里直接发口令如果没有回复，请把机器人设为管理员。也可以在 @BotFather 发送 /setprivacy，选 Disable，然后把机器人移出群再拉进来。");
  }
  return lines.join("\n");
}

export function folderText(pack: VaultPack, options: { username?: string; shareLinks: boolean }) {
  const lines = [
    "状态：可取回",
    `创建时间：${formatWhen(pack.createdAt)}`,
    "",
    "存储统计：",
    `· 文件数：${pack.files.length}`,
    "",
    "分享信息：",
    `· 名称：${clip(pack.name || "未命名", 80)}`,
    `· 口令：${pack.code}`,
  ];
  if (options.shareLinks && options.username && pack.code) {
    lines.push(`· 链接：https://t.me/${options.username}?start=${pack.code}`);
  } else {
    lines.push("· 链接：只有你自己能取回");
  }
  lines.push("", "请选择文件夹操作");
  return lines.join("\n");
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

export function packedText(pack: VaultPack, options: { username?: string; shareLinks: boolean }) {
  const lines = [
    "文件夹已生成",
    "",
    `名称：${clip(pack.name || "未命名", 80)}`,
    `文件：${pack.files.length} 个`,
    `口令：${pack.code}`,
    "",
    `取回：/get ${pack.code}`,
  ];
  if (options.shareLinks && options.username && pack.code) {
    lines.push(`链接：https://t.me/${options.username}?start=${pack.code}`);
  } else if (!options.shareLinks) {
    lines.push("只有你自己能用这个口令取回。");
  }
  return lines.join("\n");
}

export function listText(packs: VaultPack[], page: number, pages: number, total: number, viewerId: string, shared: boolean) {
  if (total === 0) {
    return shared
      ? "还没有打包好的文件夹。点「存储」，把文件发过来，点 ✅确认 之后再起名称。"
      : "分享已关闭，这里只显示你自己打包的。你还没有文件夹。";
  }
  const lines = packs.map((pack, index) => {
    const number = (page - 1) * VAULT_LIMITS.userPageSize + index + 1;
    const mine = pack.ownerId === viewerId;
    const who = mine ? "" : ` · ${clip(pack.ownerName, 12)}`;
    return `${number}. ${clip(pack.name || "未命名", 40)}${who}\n   ${filePreview(pack)}`;
  });
  return [`文件包，第 ${page}/${pages} 页，共 ${total} 个`, "", ...lines, "", "点「查看」能看到里面有哪些文件，点「取回」会把这一组发来。"].join("\n");
}

export function searchText(query: string, packs: VaultPack[], total: number, viewerId: string) {
  if (!packs.length) return `没有找到「${clip(query, 40)}」。`;
  const lines = packs.map((pack) => {
    const who = pack.ownerId === viewerId ? "" : ` · ${clip(pack.ownerName, 12)}`;
    return `${clip(pack.name || "未命名", 40)}${who}\n   ${filePreview(pack)}`;
  });
  const more = total > packs.length ? ["", `还有 ${total - packs.length} 个，把词写得更具体一些。`] : [];
  return [`「${clip(query, 40)}」找到 ${total} 个文件包`, "", ...lines, ...more].join("\n");
}

export function packDetailText(pack: VaultPack, options: { username?: string; shareLinks: boolean }, requestedPage = 1) {
  const shown = filePage(pack.files, requestedPage);
  const files = shown.slice.map((file, index) => {
    const size = formatSize(file.size);
    return `${shown.start + index + 1}. ${clip(file.name, 60)}${size ? ` · ${size}` : ""}`;
  });
  const lines = [
    `「${clip(pack.name || "未命名", 80)}」`,
    `来自 ${pack.ownerName} · 共 ${pack.files.length} 个文件`,
    "",
    ...files,
  ];
  if (shown.pages > 1) lines.push("", `第 ${shown.page}/${shown.pages} 页`);
  lines.push("", `口令：${pack.code}`);
  if (options.shareLinks && options.username && pack.code) {
    lines.push(`链接：https://t.me/${options.username}?start=${pack.code}`);
  }
  return { text: lines.join("\n"), page: shown.page, pages: shown.pages };
}

function filePreview(pack: VaultPack) {
  const names = pack.files.slice(0, 3).map((file) => clip(file.name, 18));
  if (!names.length) return "里面还没有文件";
  return pack.files.length > names.length ? `${names.join("、")} 等 ${pack.files.length} 个` : names.join("、");
}

export function statsText(packs: VaultPack[], channelTitle?: string) {
  const files = packs.reduce((sum, pack) => sum + pack.files.length, 0);
  return [
    `文件夹 ${packs.length} 个，共 ${files} 个文件`,
    channelTitle ? `仓库频道：${channelTitle}` : "仓库频道：还没设置。口令仍然可以取回。",
  ].join("\n");
}

export function retrievalPlan(item: VaultFile, currentBotId?: string) {
  if (item.channelId && item.channelMessageId) return "channel" as const;
  const sameBot = !item.botId || !currentBotId || item.botId === currentBotId;
  if (!sameBot) return "unavailable" as const;
  if (item.kind === "text" && item.text) return "text" as const;
  if (item.fileId) return "file" as const;
  if (item.chatId && item.messageId) return "source" as const;
  return "unavailable" as const;
}

export type DeliveryBatch =
  | { mode: "album"; files: VaultFile[] }
  | { mode: "single"; file: VaultFile };

type AlbumKind = "photo" | "video" | "document" | "audio";

function albumKind(file: VaultFile, currentBotId?: string): AlbumKind | null {
  const sameBot = !file.botId || !currentBotId || file.botId === currentBotId;
  if (!sameBot || !file.fileId) return null;
  if (file.kind === "photo" || file.kind === "video" || file.kind === "document" || file.kind === "audio") {
    return file.kind;
  }
  return null;
}

function sameAlbum(left: AlbumKind, right: AlbumKind) {
  if (left === "document" || right === "document") return left === "document" && right === "document";
  if (left === "audio" || right === "audio") return left === "audio" && right === "audio";
  return true;
}

export function deliveryBatches(files: VaultFile[], currentBotId?: string): DeliveryBatch[] {
  const batches: DeliveryBatch[] = [];
  let run: VaultFile[] = [];
  let runKind: AlbumKind | null = null;
  const flush = () => {
    if (run.length === 1) batches.push({ mode: "single", file: run[0] });
    else if (run.length > 1) batches.push({ mode: "album", files: run });
    run = [];
    runKind = null;
  };
  for (const file of files) {
    const kind = albumKind(file, currentBotId);
    if (!kind || (runKind && !sameAlbum(runKind, kind)) || run.length >= VAULT_LIMITS.filePageSize) {
      flush();
    }
    if (!kind) {
      batches.push({ mode: "single", file });
      continue;
    }
    runKind = runKind ?? kind;
    run.push(file);
  }
  flush();
  return batches;
}

export function queryItems<T extends { name: string; caption?: string; text?: string; code: string; ownerName: string; ownerUsername?: string; createdAt: string }>(
  items: T[],
  query: string,
  page: number,
  pageSize: number,
) {
  const needle = query.trim().toLowerCase();
  const filtered = items
    .filter((item) => {
      if (!needle) return true;
      const hay = [item.name, item.caption, item.text, item.code, item.ownerName, item.ownerUsername]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      return hay.includes(needle);
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (safePage - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    page: safePage,
    pages,
    total: filtered.length,
  };
}

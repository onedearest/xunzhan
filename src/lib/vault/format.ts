import { CODE_ALPHABET, VAULT_LIMITS, type Draft, type TgMessage, type VaultFile, type VaultKind, type VaultPack } from "./types";

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
  start: "开始",
  store: "存储",
  folders: "查看文件夹（打包好的）",
  search: "搜索关键词",
} as const;

export function menuKeyboard() {
  return [
    [{ text: MENU.start }, { text: MENU.store }],
    [{ text: MENU.folders }],
    [{ text: MENU.search }],
  ];
}

export function menuAction(text: string) {
  const value = text.trim();
  if (value === MENU.start) return "start" as const;
  if (value === MENU.store) return "store" as const;
  if (value === MENU.folders || value === "查看文件夹") return "folders" as const;
  if (value === MENU.search) return "search" as const;
  return null;
}

export function storeText(open?: { status: "collecting" | "naming"; count: number }) {
  if (open?.status === "naming") {
    return `这一组有 ${open.count} 个文件。\n\n把名称发过来，我再生成编号和链接。`;
  }
  if (open?.status === "collecting") {
    return `这一组已经有 ${open.count} 个。\n\n还要继续存入，还是结束？结束后再起名称。`;
  }
  return ["直接把文件、图片、视频或语音发给我，可以连续发。", "它们先放在同一组里。", "发完点「结束」，再发一个名称。我才会生成编号和链接。"].join("\n");
}

export function searchAskText() {
  return "把关键词发过来。我在已经打包的文件夹里按名称找。";
}

export function welcomeText(options: { username?: string; shareLinks: boolean; channelBound: boolean }) {
  const lines = [
    "用下面的菜单就行。",
    "",
    "开始：看这段说明",
    "存储：把文件发给我，结束之后再起名称",
    "查看文件夹（打包好的）：看到有哪些文件包，点「查看」能看里面的文件",
    "搜索关键词：按名称找文件包",
    "",
    "/get 编号 取回这一组",
    "/del 编号 删除这一组",
    "/cancel 取消还没起名的一组",
    "/stats 查看用量",
  ];
  if (options.shareLinks && options.username) {
    lines.push("", `链接的样子：https://t.me/${options.username}?start=编号`);
    lines.push("打开链接就能取回这一整组。");
  } else if (!options.shareLinks) {
    lines.push("", "分享已关闭，只有打包的人自己能取回。");
  }
  if (!options.channelBound) {
    lines.push("", "文件留在 Telegram 上。网页里如果绑定了私密频道，会再复制一份进去。");
  }
  return lines.join("\n");
}

export function packedText(pack: VaultPack, options: { username?: string; shareLinks: boolean }) {
  const lines = [
    "文件夹已生成",
    "",
    `名称：${clip(pack.name || "未命名", 80)}`,
    `文件：${pack.files.length} 个`,
    `编号：${pack.code}`,
    "",
    `取回：/get ${pack.code}`,
  ];
  if (options.shareLinks && options.username && pack.code) {
    lines.push(`链接：https://t.me/${options.username}?start=${pack.code}`);
  } else if (!options.shareLinks) {
    lines.push("只有你自己能用这个编号取回。");
  }
  return lines.join("\n");
}

export function listText(packs: VaultPack[], page: number, pages: number, total: number, viewerId: string, shared: boolean) {
  if (total === 0) {
    return shared
      ? "还没有打包好的文件夹。点「存储」，把文件发过来，结束之后再起名称。"
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

export function packDetailText(pack: VaultPack, options: { username?: string; shareLinks: boolean }) {
  const shown = pack.files.slice(0, 40);
  const files = shown.map((file, index) => {
    const size = formatSize(file.size);
    return `${index + 1}. ${clip(file.name, 60)}${size ? ` · ${size}` : ""}`;
  });
  const lines = [
    `「${clip(pack.name || "未命名", 80)}」`,
    `来自 ${pack.ownerName} · 共 ${pack.files.length} 个文件`,
    "",
    ...files,
  ];
  if (pack.files.length > shown.length) lines.push(`还有 ${pack.files.length - shown.length} 个，取回时会一起发来。`);
  lines.push("", `编号：${pack.code}`);
  if (options.shareLinks && options.username && pack.code) {
    lines.push(`链接：https://t.me/${options.username}?start=${pack.code}`);
  }
  return lines.join("\n");
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
    channelTitle ? `仓库频道：${channelTitle}` : "仓库频道：还没设置。编号仍然可以取回。",
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

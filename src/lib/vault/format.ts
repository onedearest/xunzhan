import { CODE_ALPHABET, VAULT_LIMITS, type Draft, type TgMessage, type VaultItem, type VaultKind } from "./types";

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

export function welcomeText(options: { username?: string; shareLinks: boolean; channelBound: boolean }) {
  const lines = [
    "直接把文件、图片、视频、语音或一段文字发给我，我会给你一个编号。",
    "",
    "/list 查看已保存的",
    "/search 关键词",
    "/get 编号",
    "/del 编号",
    "/stats 查看用量",
  ];
  if (options.shareLinks && options.username) {
    lines.push("", `分享链接的样子：https://t.me/${options.username}?start=编号`);
    lines.push("把链接发给别人，对方打开就能取回。");
  } else if (!options.shareLinks) {
    lines.push("", "分享已关闭，只有保存的人自己能取回。");
  }
  if (!options.channelBound) {
    lines.push("", "文件留在 Telegram 上。网页里如果绑定了私密频道，会再复制一份进去，聊天删了也能取回。");
  }
  return lines.join("\n");
}

export function savedText(item: VaultItem, options: { username?: string; shareLinks: boolean }) {
  const lines = ["已存好", "", `名称：${clip(item.name, 80)}`, `类型：${kindLabel[item.kind]}`];
  const size = formatSize(item.size);
  if (size) lines.push(`大小：${size}`);
  lines.push(`编号：${item.code}`, "", `取回：/get ${item.code}`);
  if (options.shareLinks && options.username) {
    lines.push(`分享：https://t.me/${options.username}?start=${item.code}`);
  } else if (!options.shareLinks) {
    lines.push("只有你自己能用这个编号取回。");
  }
  return lines.join("\n");
}

export function listText(items: VaultItem[], page: number, pages: number, total: number) {
  if (total === 0) return "还没有保存过。直接把文件、图片或文字发给我。";
  const lines = items.map((item, index) => {
    const number = (page - 1) * VAULT_LIMITS.userPageSize + index + 1;
    const size = formatSize(item.size);
    return `${number}. ${clip(item.name, 40)}${size ? ` · ${size}` : ""} · ${item.code}`;
  });
  return [`你的文件，第 ${page}/${pages} 页，共 ${total} 个`, "", ...lines, "", "点下面的按钮取回或删除。"].join("\n");
}

export function searchText(query: string, items: VaultItem[], total: number) {
  if (!items.length) return `没有找到「${clip(query, 40)}」。`;
  const lines = items.map((item) => {
    const size = formatSize(item.size);
    return `${clip(item.name, 40)}${size ? ` · ${size}` : ""} · ${item.code}`;
  });
  const more = total > items.length ? ["", `还有 ${total - items.length} 个，把词写得更具体一些。`] : [];
  return [`「${clip(query, 40)}」找到 ${total} 个`, "", ...lines, ...more].join("\n");
}

export function statsText(items: VaultItem[], channelTitle?: string) {
  const counts = new Map<VaultKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const parts = [...counts.entries()].map(([kind, count]) => `${kindLabel[kind]} ${count}`);
  return [
    `已保存 ${items.length} 个`,
    parts.join(" · ") || "还是空的",
    channelTitle ? `仓库频道：${channelTitle}` : "仓库频道：还没设置。编号仍然可以取回。",
  ].join("\n");
}

export function retrievalPlan(item: VaultItem, currentBotId?: string) {
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

export const VAULT_LIMITS = {
  maxFiles: 8000,
  maxFilesPerPack: 100,
  maxPacksPerUser: 500,
  userPageSize: 5,
  filePageSize: 10,
  adminPageSize: 20,
  seenChannels: 8,
  codeLength: 8,
} as const;

export const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export type VaultKind =
  | "text"
  | "document"
  | "photo"
  | "video"
  | "audio"
  | "voice"
  | "animation"
  | "sticker"
  | "video_note";

export type InlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type TgUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

export type TgChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
};

export type TgFile = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
  emoji?: string;
  title?: string;
};

export type TgMessage = {
  message_id: number;
  date?: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  media_group_id?: string;
  document?: TgFile;
  photo?: TgFile[];
  video?: TgFile;
  audio?: TgFile;
  voice?: TgFile;
  animation?: TgFile;
  sticker?: TgFile;
  video_note?: TgFile;
  forward_origin?: {
    type?: string;
    chat?: TgChat;
    message_id?: number;
  };
  forward_from_chat?: TgChat;
  message_thread_id?: number;
  reply_to_message?: { message_id: number };
};

export type TgCallback = {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
};

export type TgChatMemberUpdate = {
  chat: TgChat;
  from?: TgUser;
  new_chat_member?: { status?: string };
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: TgCallback;
  my_chat_member?: TgChatMemberUpdate;
};

export type VaultFile = {
  kind: VaultKind;
  name: string;
  caption?: string;
  text?: string;
  mime?: string;
  size?: number;
  fileId?: string;
  botId?: string;
  chatId: string;
  messageId: number;
  channelId?: string;
  channelMessageId?: number;
};

export type PackStatus = "collecting" | "naming" | "ready";

export type VaultPack = {
  id: string;
  code?: string;
  status: PackStatus;
  ownerId: string;
  ownerName: string;
  ownerUsername?: string;
  name?: string;
  files: VaultFile[];
  createdAt: string;
  readyAt?: string;
  noticeMessageId?: number;
  noticePage?: number;
};

export type SeenChannel = {
  id: string;
  title: string;
  username?: string;
  seenAt: string;
};

export type UserPrompt = {
  ownerId: string;
  kind: "search";
};

export type ExpiringNotice = {
  chatId: string;
  messageId: number;
  deleteAt: string;
};

export type VaultData = {
  token: string;
  enabled: boolean;
  botId?: string;
  botName?: string;
  botUsername?: string;
  channelId?: string;
  channelTitle?: string;
  shareLinks: boolean;
  offset: number;
  packs: VaultPack[];
  seenChannels: SeenChannel[];
  prompts: UserPrompt[];
  expiring: ExpiringNotice[];
  lastError?: string;
  connectedAt?: string;
};

export type VaultStatus = {
  connected: boolean;
  running: boolean;
  botId?: string;
  botName?: string;
  botUsername?: string;
  tokenHint?: string;
  channelId?: string;
  channelTitle?: string;
  shareLinks: boolean;
  packCount: number;
  lastError?: string;
  seenChannels: SeenChannel[];
  connectedAt?: string;
};

export type VaultPackPublic = {
  code: string;
  name: string;
  ownerId: string;
  ownerName: string;
  ownerUsername?: string;
  fileCount: number;
  files: { name: string; kind: VaultKind; size?: number }[];
  createdAt: string;
  link?: string;
};

export type Draft = {
  kind: VaultKind;
  name: string;
  caption?: string;
  text?: string;
  mime?: string;
  size?: number;
  fileId?: string;
};

export function emptyVault(): VaultData {
  return {
    token: "",
    enabled: false,
    shareLinks: true,
    offset: 0,
    packs: [],
    seenChannels: [],
    prompts: [],
    expiring: [],
  };
}

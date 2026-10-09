export const VAULT_LIMITS = {
  maxItems: 8000,
  maxPerUser: 2000,
  userPageSize: 5,
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
  callback_data: string;
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

export type VaultItem = {
  code: string;
  ownerId: string;
  ownerName: string;
  ownerUsername?: string;
  botId?: string;
  kind: VaultKind;
  name: string;
  caption?: string;
  text?: string;
  mime?: string;
  size?: number;
  fileId?: string;
  chatId: string;
  messageId: number;
  channelId?: string;
  channelMessageId?: number;
  createdAt: string;
};

export type SeenChannel = {
  id: string;
  title: string;
  username?: string;
  seenAt: string;
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
  items: VaultItem[];
  seenChannels: SeenChannel[];
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
  itemCount: number;
  lastError?: string;
  seenChannels: SeenChannel[];
  connectedAt?: string;
};

export type VaultItemPublic = {
  code: string;
  ownerId: string;
  ownerName: string;
  ownerUsername?: string;
  kind: VaultKind;
  name: string;
  preview?: string;
  mime?: string;
  size?: number;
  createdAt: string;
  inChannel: boolean;
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
    items: [],
    seenChannels: [],
  };
}

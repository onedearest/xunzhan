import type { AccountPublic, ChatPublic } from "./types";

export const demoAccounts: AccountPublic[] = [
  {
    id: "demo-lin",
    name: "林夏",
    phone: "+86 138****2610",
    username: "linxia",
    demo: true,
  },
  {
    id: "demo-zhou",
    name: "周衡",
    phone: "+65 8123****",
    username: "zhouheng",
    demo: true,
  },
];

const chats: Record<string, ChatPublic[]> = {
  "demo-lin": [
    {
      id: "demo-lin-weekly",
      title: "产品周会",
      kind: "supergroup",
      participantsCount: 128,
      canPost: true,
    },
    {
      id: "demo-lin-design",
      title: "设计批评小组",
      kind: "group",
      participantsCount: 36,
      canPost: true,
    },
    {
      id: "demo-lin-feedback",
      title: "用户反馈收集",
      kind: "supergroup",
      participantsCount: 540,
      canPost: true,
    },
    {
      id: "demo-lin-log",
      title: "产品日志",
      kind: "channel",
      username: "linxia_log",
      participantsCount: 2104,
      canPost: true,
    },
    {
      id: "demo-lin-watch",
      title: "行业观察",
      kind: "channel",
      participantsCount: 860,
      canPost: false,
      reason: "频道需要发帖权限",
    },
  ],
  "demo-zhou": [
    {
      id: "demo-zhou-reading",
      title: "城市读书会",
      kind: "supergroup",
      participantsCount: 86,
      canPost: true,
    },
    {
      id: "demo-zhou-market",
      title: "周末市集摊主",
      kind: "group",
      participantsCount: 24,
      canPost: true,
    },
    {
      id: "demo-zhou-volunteer",
      title: "志愿者协调",
      kind: "supergroup",
      participantsCount: 61,
      canPost: true,
      slowmode: true,
    },
    {
      id: "demo-zhou-slow",
      title: "慢速模式示例",
      kind: "supergroup",
      participantsCount: 14,
      canPost: true,
      slowmode: true,
    },
    {
      id: "demo-zhou-left",
      title: "已退出的旧群",
      kind: "group",
      participantsCount: 40,
      canPost: false,
      reason: "已退出或无权访问",
    },
  ],
};

export function isDemoAccount(id: string): boolean {
  return demoAccounts.some((account) => account.id === id);
}

export function demoChats(accountId: string): ChatPublic[] {
  return chats[accountId] ?? [];
}

export function demoFails(accountId: string, chatId: string): string | null {
  if (accountId === "demo-zhou" && chatId === "demo-zhou-slow") {
    return "这个群开启了慢速模式，需等待 30 秒";
  }
  return null;
}

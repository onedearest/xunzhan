import type { AccountPublic, ChatPublic, PostPublic } from "./types";

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
    {
      id: "demo-lin-saved",
      title: "收藏夹",
      kind: "private",
      canPost: true,
    },
    {
      id: "demo-lin-chen",
      title: "陈舟",
      kind: "private",
      username: "chenzhou",
      canPost: true,
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

const extraPosts = new Map<string, PostPublic[]>();

export function rememberDemoPost(accountId: string, chatId: string, text: string) {
  const key = `${accountId}:${chatId}`;
  const next = extraPosts.get(key) ?? [];
  next.unshift({
    id: `${chatId}-sent-${next.length + 1}`,
    text,
    date: new Date().toISOString(),
    out: true,
  });
  extraPosts.set(key, next);
}

const posts: Record<string, string[]> = {
  "demo-lin-weekly": [
    "周衡：这周的接口评审改到周四下午。",
    "林夏：我先把纪要发在这里，大家照着对。",
    "陈舟：登录不要再让用户填 API 了，扫码就行。",
    "林夏：发出去之后，这个群里的旧消息也要还在。",
  ],
  "demo-lin-design": [
    "间距再松一档，列表和会话分成两栏。",
    "右边要一直是这个群的消息，不要发完就换成别的页面。",
  ],
  "demo-lin-feedback": [
    "有人反馈：电脑版打开还在要 API。",
    "另一条：消息发出去就看不见群里刚才说了什么。",
  ],
  "demo-zhou-reading": [
    "这周读的是本地客户端怎么留住会话。",
    "读完把笔记发在群里，过一会儿还能翻到。",
  ],
  "demo-lin-chen": [
    "下午的产品周会，我先发纪要。",
    "好，我在设计批评小组等你那条。",
  ],
  "demo-lin-saved": [
    "待办：轮流发言，不要两个账号同时开口。",
    "收藏夹只给自己看，也可以从这里再发出去。",
  ],
  "demo-lin-log": [
    "本周版本已经合入设置页。登录态仍只保存在这台电脑的 data 目录。",
    "周会纪要：群发改成轮流。林夏先发一条，周衡再发一条，中间留间隔。",
    "设计批评小组留下三条意见，字体和边距已经按纸面色改过。",
    "用户反馈收集里，有人希望定时到明早九点再发。定时只在窗口开着时生效。",
    "产品日志这条是频道帖。在讯栈里打开它，只会滚动本窗口，不会去刷阅读数。",
    "慢速模式的群如果发得太密，会记成失败，后面的群继续排队。",
    "演示账号不会连接 Telegram。关掉演示后，这些群和帖子都会消失。",
    "下一轮只改文案长度。单条仍限制在 4096 个字符以内。",
    "登录槽放到 50 个，是为了把账号放在同一张桌子上切换。单次发送仍然有上限。",
    "定时如果设在明早，窗口要一直开着。服务重启后，还没开始的那一轮会取消。",
    "产品日志往下还有旧帖。自动浏览滑到底后会再往上，像用手拨鼠标滚轮。",
    "这条是列表末尾附近的帖子。如果它出现在窗口下沿，说明列表已经能滚动。",
  ],
  "demo-lin-watch": [
    "行业观察：各家都在把多账号收成一个工作台，切换发言比同时开口更不容易撞车。",
    "频道帖通常只是往下读。上下滑动是阅读习惯，不是给帖子加热。",
    "本周值得看的是本地客户端怎么保存会话，而不是把服务暴露到公网。",
    "慢速模式和频率限制仍然由 Telegram 决定。工作台只是把失败记下来。",
    "已经退出的频道不会出现在可浏览列表里。",
    "把鼠标当成翻页：先向下，到底再向上，循环直到你停下。",
    "只读频道也能打开。没有发帖权限，不影响把历史列出来看。",
    "阅读数是帖子上原来就有的数字。窗口滚动不会去改它。",
    "这条再长一点，方便在窄屏幕上把列表撑出滚动条。工作台只负责把已加入频道的历史摊开。",
    "滑到这里就可以往回看上面的帖子。停止之后，列表停在当前位置。",
  ],
};

export function demoPosts(accountId: string, chatId: string): PostPublic[] {
  if (!isDemoAccount(accountId)) return [];
  const lines = posts[chatId] ?? [];
  const now = Date.now();
  const history = lines.map((text, index) => ({
    id: `${chatId}-${index + 1}`,
    text,
    date: new Date(now - (index + 1) * 3_600_000).toISOString(),
    views: 86 + index * 13,
    out: index % 2 === 1,
  }));
  return [...(extraPosts.get(`${accountId}:${chatId}`) ?? []), ...history];
}

export function demoFails(accountId: string, chatId: string): string | null {
  if (accountId === "demo-zhou" && chatId === "demo-zhou-slow") {
    return "这个群开启了慢速模式，需等待 30 秒";
  }
  return null;
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyChat,
  finishStatus,
  normalizePhone,
  parseCredentials,
  parseSchedule,
  planBatch,
  readablePost,
  runDeliveries,
  type RawChat,
} from "./policy";
import type { ChatPublic, Delivery } from "./types";

function channel(overrides: Partial<RawChat> = {}): RawChat {
  return {
    className: "Channel",
    id: "1",
    title: "公告",
    broadcast: true,
    ...overrides,
  };
}

function delivery(accountId: string, chatId: string): Delivery {
  return {
    accountId,
    accountName: accountId,
    chatId,
    title: chatId,
    status: "pending",
  };
}

function catalog(chats: ChatPublic[]): Record<string, ChatPublic[]> {
  return { acc: chats };
}

test("classifies broadcast channels by post permission", () => {
  assert.equal(classifyChat(channel()).canPost, false);
  assert.equal(classifyChat(channel({ creator: true })).canPost, true);
  assert.equal(classifyChat(channel({ adminPost: true })).kind, "channel");
});

test("classifies supergroups and basic groups", () => {
  const banned = classifyChat(
    channel({
      id: "2",
      title: "超级群",
      broadcast: false,
      megagroup: true,
      defaultBannedSend: true,
    }),
  );
  assert.equal(banned.kind, "supergroup");
  assert.equal(banned.canPost, false);

  const admin = classifyChat(
    channel({
      id: "3",
      broadcast: false,
      megagroup: true,
      defaultBannedSend: true,
      adminAny: true,
    }),
  );
  assert.equal(admin.canPost, true);

  const group = classifyChat({ className: "Chat", id: "4", title: "小组" });
  assert.equal(group.kind, "group");
  assert.equal(group.canPost, true);
});

test("classifies private chats and saved messages", () => {
  const person = classifyChat({
    className: "User",
    id: "9",
    firstName: "陈",
    lastName: "舟",
    username: "chenzhou",
  });
  assert.equal(person.kind, "private");
  assert.equal(person.title, "陈 舟");
  assert.equal(person.canPost, true);

  const saved = classifyChat({ className: "User", id: "10", self: true, firstName: "林夏" });
  assert.equal(saved.title, "收藏夹");

  const gone = classifyChat({ className: "User", id: "11", deleted: true, firstName: "旧账号" });
  assert.equal(gone.canPost, false);
});

test("treats left and forbidden chats as unsendable", () => {
  const left = classifyChat({ className: "Chat", id: "5", title: "旧群", left: true });
  assert.equal(left.canPost, false);
  assert.match(left.reason ?? "", /退出/);
});

test("normalizes international phone numbers", () => {
  assert.equal(normalizePhone(" +86 138-0013-8000 "), "+8613800138000");
  assert.equal(normalizePhone("13800138000"), null);
  assert.equal(normalizePhone("+123"), null);
});

test("checks api credentials shape", () => {
  assert.equal(parseCredentials("12345", "a".repeat(32)).ok, true);
  assert.equal(parseCredentials("nope", "abc").ok, false);
});

test("plans a paced batch and rejects unsafe input", () => {
  const chats: ChatPublic[] = [
    { id: "g1", title: "一组", kind: "group", canPost: true },
    { id: "g2", title: "频道", kind: "channel", canPost: false, reason: "频道需要发帖权限" },
  ];
  const base = {
    message: "今晚 8 点例会",
    intervalSec: 8,
    confirmed: true,
    selections: [{ accountId: "acc", accountName: "林夏", demo: false, chatIds: ["g1"] }],
    catalogs: catalog(chats),
  };
  const plan = planBatch(base);
  assert.equal(plan.ok, true);
  if (plan.ok) assert.equal(plan.deliveries.length, 1);

  assert.equal(planBatch({ ...base, confirmed: false }).ok, false);
  assert.equal(planBatch({ ...base, intervalSec: 3 }).ok, false);
  assert.match(
    planBatch({
      ...base,
      selections: [{ accountId: "acc", accountName: "林夏", demo: false, chatIds: ["g2"] }],
    }).ok
      ? ""
      : (planBatch({
          ...base,
          selections: [{ accountId: "acc", accountName: "林夏", demo: false, chatIds: ["g2"] }],
        }) as { error: string }).error,
    /不能发到/,
  );

  const demo = planBatch({
    ...base,
    intervalSec: 1,
    selections: [{ accountId: "acc", accountName: "林夏", demo: true, chatIds: ["g1", "g1"] }],
  });
  assert.equal(demo.ok, true);
  if (demo.ok) assert.equal(demo.deliveries.length, 1);
});

test("caps targets per account and per run", () => {
  const chats: ChatPublic[] = Array.from({ length: 21 }, (_, index) => ({
    id: `g${index}`,
    title: `群 ${index}`,
    kind: "group" as const,
    canPost: true,
  }));
  const tooMany = planBatch({
    message: "hi",
    intervalSec: 8,
    confirmed: true,
    selections: [
      {
        accountId: "acc",
        accountName: "林夏",
        demo: false,
        chatIds: chats.map((chat) => chat.id),
      },
    ],
    catalogs: catalog(chats),
  });
  assert.equal(tooMany.ok, false);
});

test("alternates one message per account before the next round", async () => {
  const deliveries = [
    delivery("a", "a1"),
    delivery("a", "a2"),
    delivery("b", "b1"),
    delivery("b", "b2"),
    delivery("c", "c1"),
  ];
  const seen: string[] = [];
  let active = 0;
  let maxActive = 0;
  await runDeliveries({
    deliveries,
    intervalMs: 20,
    signal: new AbortController().signal,
    send: async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      seen.push(item.chatId);
      await Promise.resolve();
      active -= 1;
    },
    sleep: async () => undefined,
  });
  assert.deepEqual(seen, ["a1", "b1", "c1", "a2", "b2"]);
  assert.equal(maxActive, 1);
});

test("rejects a schedule outside the next week", () => {
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  assert.equal(parseSchedule("", now).ok, true);
  assert.equal(parseSchedule("2026-10-08T12:30:00.000Z", now).ok, true);
  assert.equal(parseSchedule("2026-10-08T11:00:00.000Z", now).ok, false);
  assert.equal(parseSchedule("2026-10-20T12:00:00.000Z", now).ok, false);
});

test("reads history text and ignores non-messages", () => {
  const post = readablePost({
    className: "Message",
    id: 7,
    message: "今晚例会改到九点",
    date: 1_760_000_000,
    views: 12,
  });
  assert.equal(post?.text, "今晚例会改到九点");
  assert.equal(post?.views, 12);
  assert.equal(readablePost({ className: "MessageService", id: 8, message: "加入了群" }), null);
  assert.equal(
    readablePost({ className: "Message", id: 9, mediaClass: "MessageMediaPhoto" })?.text,
    "〔图片〕",
  );
});

test("sends the rest of an account after one failure", async () => {
  const deliveries = [delivery("a", "1"), delivery("a", "2"), delivery("a", "3")];
  const seen: string[] = [];
  await runDeliveries({
    deliveries,
    intervalMs: 20,
    signal: new AbortController().signal,
    send: async (item) => {
      seen.push(item.chatId);
      if (item.chatId === "2") throw new Error("没有发言权限");
    },
    sleep: async () => undefined,
  });
  assert.deepEqual(seen, ["1", "2", "3"]);
  assert.equal(deliveries[1].status, "error");
  assert.equal(deliveries[2].status, "ok");
  assert.equal(finishStatus(deliveries, false), "done");
});

test("stop skips deliveries that have not started", async () => {
  const deliveries = [delivery("a", "1"), delivery("a", "2"), delivery("a", "3")];
  const controller = new AbortController();
  await runDeliveries({
    deliveries,
    intervalMs: 50,
    signal: controller.signal,
    send: async () => {
      controller.abort();
    },
    sleep: async (_ms, signal) => {
      if (signal.aborted) return;
    },
  });
  assert.equal(deliveries[0].status, "ok");
  assert.equal(deliveries[1].status, "skipped");
  assert.equal(deliveries[2].status, "skipped");
  assert.equal(finishStatus(deliveries, true), "stopped");
});

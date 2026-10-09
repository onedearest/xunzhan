import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyVaultUpdate, deliverItem, type VaultIO } from "./vault/apply";
import { BotApiError, BotClient, canPostInChannel, explainBot } from "./vault/bot-client";
import {
  commandOf,
  draftFromMessage,
  formatSize,
  maskToken,
  normalizeChannel,
  retrievalPlan,
} from "./vault/format";
import { reduceVault } from "./vault/reduce";
import { createVaultRepository } from "./vault/store";
import { toStatus } from "./vault/service";
import { emptyVault, VAULT_LIMITS, type TgUpdate, type VaultData, type VaultItem } from "./vault/types";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const CODES = ["abcdefgj", "kmnpqrst", "uvwxyz23", "456789ab", "jkmnpqrs", "tuvwxyz2"];

function codes() {
  let index = 0;
  return () => CODES[index++] ?? "zzzzzzzz";
}

function update(partial: Partial<TgUpdate> & { update_id: number }): TgUpdate {
  return partial;
}

function privateFile(updateId: number, messageId: number, name = "报告.pdf"): TgUpdate {
  return update({
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: 7, type: "private" },
      from: { id: 7, first_name: "林夏", username: "lin" },
      document: { file_id: `file-${messageId}`, file_name: name, file_size: 2048, mime_type: "application/pdf" },
    },
  });
}

function baseData(extra?: Partial<VaultData>): VaultData {
  return {
    ...emptyVault(),
    botId: "99",
    botUsername: "storebot",
    ...extra,
  };
}

test("hides the middle of a BotFather token", () => {
  assert.equal(maskToken(TOKEN), "123456789:••••Dsaw");
  assert.equal(maskToken(TOKEN).includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALD"), false);
  assert.equal(maskToken("not-a-token"), "");
});

test("reads channel ids the way storage bots expect", () => {
  assert.equal(normalizeChannel("-1001234567890"), "-1001234567890");
  assert.equal(normalizeChannel("@MyVault"), "@MyVault");
  assert.equal(normalizeChannel("https://t.me/MyVault/3"), "@MyVault");
  assert.equal(normalizeChannel("https://t.me/c/1234567890/4"), "-1001234567890");
  assert.throws(() => normalizeChannel("12345"), /频道/);
  assert.throws(() => normalizeChannel("https://t.me/+abcdef"), /邀请链接/);
});

test("formats sizes and picks the largest photo", () => {
  assert.equal(formatSize(undefined), "");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(1.5 * 1024 * 1024), "1.5 MB");
  const draft = draftFromMessage({
    message_id: 1,
    chat: { id: 1, type: "private" },
    photo: [
      { file_id: "small", file_size: 10 },
      { file_id: "large", file_size: 99 },
    ],
    caption: "封面",
  });
  assert.equal(draft?.fileId, "large");
  assert.equal(draft?.kind, "photo");
  assert.equal(draft?.caption, "封面");
  assert.equal(draftFromMessage({ message_id: 2, chat: { id: 1, type: "private" }, text: "/list" }), null);
  assert.equal(
    draftFromMessage({ message_id: 3, chat: { id: 1, type: "private" }, text: "记一下\n明天开会" })?.name,
    "记一下",
  );
  assert.deepEqual(commandOf("/start@storebot abcdefgj"), { name: "start", arg: "abcdefgj" });
});

test("stores a private file and gives back a code", () => {
  const reduced = reduceVault(baseData(), privateFile(1, 10), { now: "2026-10-09T00:00:00.000Z", nextCode: codes() });
  assert.equal(reduced.data.items.length, 1);
  assert.equal(reduced.data.items[0]?.code, "abcdefgj");
  assert.equal(reduced.data.items[0]?.ownerName, "林夏");
  assert.match(reduced.decision.replies[0]?.text ?? "", /已存好/);
  assert.match(reduced.decision.replies[0]?.text ?? "", /https:\/\/t\.me\/storebot\?start=abcdefgj/);
  assert.equal(reduced.decision.replies[0]?.keyboard?.[0]?.[0]?.callback_data, "g:abcdefgj");
});

test("does not store the same message twice", () => {
  const first = reduceVault(baseData(), privateFile(1, 10), { now: "2026-10-09T00:00:00.000Z", nextCode: codes() });
  const second = reduceVault(first.data, privateFile(2, 10), { now: "2026-10-09T00:01:00.000Z", nextCode: codes() });
  assert.equal(second.data.items.length, 1);
  assert.match(second.decision.replies[0]?.text ?? "", /abcdefgj/);
});

test("keeps each person's files private when sharing is off", () => {
  const saved = reduceVault(baseData({ shareLinks: false }), privateFile(1, 10), {
    now: "2026-10-09T00:00:00.000Z",
    nextCode: codes(),
  });
  const stranger = reduceVault(
    saved.data,
    update({
      update_id: 2,
      message: {
        message_id: 2,
        chat: { id: 8, type: "private" },
        from: { id: 8, first_name: "周衡" },
        text: "/get abcdefgj",
      },
    }),
    { now: "2026-10-09T00:02:00.000Z", nextCode: codes() },
  );
  assert.equal(stranger.decision.deliver, undefined);
  assert.match(stranger.decision.replies[0]?.text ?? "", /只有保存它的人/);
  const owner = reduceVault(
    saved.data,
    update({
      update_id: 3,
      message: {
        message_id: 3,
        chat: { id: 7, type: "private" },
        from: { id: 7, first_name: "林夏" },
        text: "/get abcdefgj",
      },
    }),
    { now: "2026-10-09T00:03:00.000Z", nextCode: codes() },
  );
  assert.equal(owner.decision.deliver?.code, "abcdefgj");
});

test("lets a shared link retrieve the file and only the owner delete it", () => {
  const saved = reduceVault(baseData(), privateFile(1, 10), { now: "2026-10-09T00:00:00.000Z", nextCode: codes() });
  const shared = reduceVault(
    saved.data,
    update({
      update_id: 2,
      message: {
        message_id: 4,
        chat: { id: 8, type: "private" },
        from: { id: 8, first_name: "周衡" },
        text: "/start abcdefgj",
      },
    }),
    { now: "2026-10-09T00:02:00.000Z", nextCode: codes() },
  );
  assert.equal(shared.decision.deliver?.chatId, "8");
  const removed = reduceVault(
    saved.data,
    update({
      update_id: 3,
      callback_query: {
        id: "cb",
        from: { id: 8, first_name: "周衡" },
        data: "y:abcdefgj",
        message: { message_id: 9, chat: { id: 8, type: "private" } },
      },
    }),
    { now: "2026-10-09T00:03:00.000Z", nextCode: codes() },
  );
  assert.equal(removed.data.items.length, 1);
  assert.match(removed.decision.callbackText ?? "", /只能删除/);
  const owner = reduceVault(
    saved.data,
    update({
      update_id: 4,
      message: {
        message_id: 5,
        chat: { id: 7, type: "private" },
        from: { id: 7, first_name: "林夏" },
        text: "/del abcdefgj",
      },
    }),
    { now: "2026-10-09T00:04:00.000Z", nextCode: codes() },
  );
  assert.equal(owner.data.items.length, 0);
  assert.equal(owner.decision.replies[0]?.text.includes("已删除"), true);
});

test("pages a person's list and searches by name", () => {
  let data = baseData();
  const nextCode = codes();
  for (let index = 0; index < 6; index += 1) {
    const reduced = reduceVault(data, privateFile(index + 1, index + 1, `笔记${index}.txt`), {
      now: `2026-10-09T00:0${index}:00.000Z`,
      nextCode,
    });
    data = reduced.data;
  }
  const listed = reduceVault(
    data,
    update({
      update_id: 20,
      message: {
        message_id: 30,
        chat: { id: 7, type: "private" },
        from: { id: 7, first_name: "林夏" },
        text: "/list 2",
      },
    }),
    { now: "2026-10-09T00:10:00.000Z", nextCode: codes() },
  );
  assert.match(listed.decision.replies[0]?.text ?? "", /第 2\/2 页/);
  assert.equal(listed.decision.replies[0]?.keyboard?.at(-1)?.some((button) => button.callback_data === "l:1"), true);
  const found = reduceVault(
    data,
    update({
      update_id: 21,
      message: {
        message_id: 31,
        chat: { id: 7, type: "private" },
        from: { id: 7, first_name: "林夏" },
        text: "/search 笔记1",
      },
    }),
    { now: "2026-10-09T00:11:00.000Z", nextCode: codes() },
  );
  assert.match(found.decision.replies[0]?.text ?? "", /笔记1\.txt/);
  assert.doesNotMatch(found.decision.replies[0]?.text ?? "", /笔记2\.txt/);
});

test("remembers a channel without storing its posts as files", () => {
  const reduced = reduceVault(
    baseData(),
    update({
      update_id: 1,
      my_chat_member: { chat: { id: -100123, type: "channel", title: "仓库" } },
    }),
    { now: "2026-10-09T00:00:00.000Z", nextCode: codes() },
  );
  assert.equal(reduced.data.items.length, 0);
  assert.equal(reduced.data.seenChannels[0]?.id, "-100123");
  assert.equal(reduced.data.seenChannels[0]?.title, "仓库");
  const posted = reduceVault(
    reduced.data,
    update({
      update_id: 2,
      channel_post: {
        message_id: 4,
        chat: { id: -100123, type: "channel", title: "仓库" },
        text: "不要当成用户文件",
      },
    }),
    { now: "2026-10-09T00:01:00.000Z", nextCode: codes() },
  );
  assert.equal(posted.data.items.length, 0);
});

test("stops a person at the per-user limit", () => {
  const items = Array.from({ length: VAULT_LIMITS.maxPerUser }, (_, index) => ({
    code: `code${index}`,
    ownerId: "7",
    ownerName: "林夏",
    kind: "text" as const,
    name: "旧",
    text: "旧",
    chatId: "7",
    messageId: index + 1,
    createdAt: "2026-10-08T00:00:00.000Z",
  }));
  const reduced = reduceVault(baseData({ items }), privateFile(1, 9000), {
    now: "2026-10-09T00:00:00.000Z",
    nextCode: codes(),
  });
  assert.equal(reduced.data.items.length, VAULT_LIMITS.maxPerUser);
  assert.match(reduced.decision.replies[0]?.text ?? "", /太多/);
});

test("copies a saved file into the storage channel", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-"));
  try {
    const repo = createVaultRepository(dir);
    await repo.update(() => baseData({ channelId: "-100555", channelTitle: "仓库" }));
    const sent: string[] = [];
    const io = fakeIo(sent, async () => 42);
    await applyVaultUpdate(privateFile(5, 10), repo, io, { now: "2026-10-09T00:00:00.000Z", nextCode: codes() });
    const saved = await repo.load();
    assert.equal(saved.offset, 6);
    assert.equal(saved.items[0]?.channelMessageId, 42);
    assert.equal(saved.items[0]?.channelId, "-100555");
    assert.match(sent[0] ?? "", /已存好/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps the code when the channel copy fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-"));
  try {
    const repo = createVaultRepository(dir);
    await repo.update(() => baseData({ channelId: "-100555" }));
    const sent: string[] = [];
    await applyVaultUpdate(privateFile(3, 8), repo, fakeIo(sent, async () => {
      throw new Error("没有权限");
    }), { now: "2026-10-09T00:00:00.000Z", nextCode: codes() });
    const saved = await repo.load();
    assert.equal(saved.items.length, 1);
    assert.equal(saved.items[0]?.channelMessageId, undefined);
    assert.match(sent[0] ?? "", /还没放进仓库频道/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status never returns the raw token", () => {
  const status = toStatus(baseData({ token: TOKEN, enabled: true, items: [] }), true);
  const body = JSON.stringify(status);
  assert.equal(status.connected, true);
  assert.equal(status.running, true);
  assert.equal(status.tokenHint, "123456789:••••Dsaw");
  assert.equal(body.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALD"), false);
});

test("chooses channel copy before a file id from another bot", () => {
  const item: VaultItem = {
    code: "abcdefgj",
    ownerId: "7",
    ownerName: "林夏",
    botId: "1",
    kind: "document",
    name: "a.pdf",
    fileId: "abc",
    chatId: "7",
    messageId: 1,
    channelId: "-1001",
    channelMessageId: 9,
    createdAt: "2026-10-09T00:00:00.000Z",
  };
  assert.equal(retrievalPlan(item, "2"), "channel");
  assert.equal(retrievalPlan({ ...item, channelId: undefined, channelMessageId: undefined }, "2"), "unavailable");
  assert.equal(retrievalPlan({ ...item, channelId: undefined, channelMessageId: undefined }, "1"), "file");
});

test("sends the stored file back through the bot client", async () => {
  const calls: string[] = [];
  const client = {
    async copyMessage() {
      calls.push("copy");
      throw new Error("频道里没有");
    },
    async sendMessage() {
      calls.push("text");
    },
    async sendFile() {
      calls.push("file");
    },
  };
  const item: VaultItem = {
    code: "abcdefgj",
    ownerId: "7",
    ownerName: "林夏",
    botId: "99",
    kind: "document",
    name: "a.pdf",
    fileId: "abc",
    chatId: "7",
    messageId: 1,
    channelId: "-1001",
    channelMessageId: 9,
    createdAt: "2026-10-09T00:00:00.000Z",
  };
  await deliverItem(client as unknown as BotClient, "7", item, "99");
  assert.deepEqual(calls, ["copy", "file"]);
});

test("explains a bad token without echoing it", async () => {
  const client = new BotClient(TOKEN, async () => {
    return Response.json({ ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` });
  });
  await assert.rejects(
    () => client.getMe(),
    (error: unknown) => {
      assert.ok(error instanceof BotApiError);
      assert.equal(error.description.includes(TOKEN), false);
      assert.match(explainBot(error), /令牌不正确/);
      return true;
    },
  );
  assert.equal(canPostInChannel({ status: "creator" }), true);
  assert.equal(canPostInChannel({ status: "administrator", can_post_messages: false }), false);
  assert.equal(canPostInChannel({ status: "member" }), false);
});

test("round-trips the vault file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-"));
  try {
    const repo = createVaultRepository(dir);
    await repo.update((current) => ({ ...current, token: TOKEN, shareLinks: false, enabled: true }));
    const loaded = await repo.load();
    assert.equal(loaded.token, TOKEN);
    assert.equal(loaded.shareLinks, false);
    assert.equal(loaded.enabled, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function fakeIo(sent: string[], copy: () => Promise<number>): VaultIO {
  return {
    async copyMessage() {
      return copy();
    },
    async sendMessage(_chatId, text) {
      sent.push(text);
    },
    async editMessage() {
      return undefined;
    },
    async answerCallback() {
      return undefined;
    },
    async deleteMessage() {
      return undefined;
    },
    async deliver() {
      return undefined;
    },
  };
}

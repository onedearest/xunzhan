import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyVaultUpdate, deliverItem, deliverPack, type VaultIO } from "./vault/apply";
import { BotApiError, BotClient, botCommands, canPostInChannel, explainBot } from "./vault/bot-client";
import {
  codesInText,
  commandOf,
  deliveryBatches,
  draftFromMessage,
  formatSize,
  maskToken,
  MENU,
  normalizeChannel,
  retrievalPlan,
} from "./vault/format";
import { reduceVault } from "./vault/reduce";
import { createFleet } from "./vault/fleet";
import { createVaultRepository } from "./vault/store";
import { connectVault, pauseVault, toStatus, vaultView } from "./vault/service";
import { emptyVault, VAULT_LIMITS, type TgUpdate, type VaultData, type VaultFile, type VaultPack } from "./vault/types";

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

function textMessage(updateId: number, messageId: number, text: string, fromId = 7): TgUpdate {
  return update({
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: fromId, type: "private" },
      from: { id: fromId, first_name: fromId === 7 ? "林夏" : "周衡", username: fromId === 7 ? "lin" : undefined },
      text,
    },
  });
}

function press(updateId: number, data: string, fromId = 7): TgUpdate {
  return update({
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: fromId, first_name: fromId === 7 ? "林夏" : "周衡" },
      data,
      message: { message_id: 90 + updateId, chat: { id: fromId, type: "private" } },
    },
  });
}

function baseData(extra?: Partial<VaultData>): VaultData {
  return {
    ...emptyVault(),
    botId: "99",
    botUsername: "storebot",
    ownerId: "7",
    ...extra,
  };
}

function step(data: VaultData, incoming: TgUpdate, now: string, nextCode: () => string) {
  return reduceVault(data, incoming, { now, nextCode });
}

function finishPack(data: VaultData, name: string, now: string, nextCode: () => string, updateId = 800) {
  const asked = step(data, press(updateId, "e"), now, nextCode);
  return step(asked.data, textMessage(updateId + 1, updateId + 1, name), now, nextCode);
}

test("finds a passcode inside punctuation and fullwidth letters", () => {
  assert.deepEqual(codesInText("口令：abcdefgj。"), ["abcdefgj"]);
  assert.deepEqual(codesInText("口令：ａｂｃｄｅｆｇｊ"), ["abcdefgj"]);
  assert.deepEqual(codesInText("0abcdefgj"), ["abcdefgj"]);
  assert.equal(codesInText("https://t.me/JJJG688Bot?start=3jbeu6fr").includes("3jbeu6fr"), true);
});

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

test("keeps files in one group until the user finishes and names it", () => {
  const nextCode = codes();
  const now = "2026-10-09T00:00:00.000Z";
  const first = step(baseData(), privateFile(1, 10, "报告.pdf"), now, nextCode);
  assert.equal(first.data.packs.length, 1);
  assert.equal(first.data.packs[0]?.status, "collecting");
  assert.equal(first.data.packs[0]?.code, undefined);
  assert.match(first.decision.replies[0]?.text ?? "", /第1个文件/);
  assert.match(first.decision.replies[0]?.text ?? "", /确认/);
  assert.equal(first.decision.replies[0]?.bar, "finish");
  assert.equal(first.decision.replies[0]?.kind, "send");

  const noted = {
    ...first.data,
    packs: [{ ...first.data.packs[0]!, noticeMessageId: 77, noticePage: 1 }],
  };
  const second = step(noted, privateFile(2, 11, "封面.png"), now, nextCode);
  assert.equal(second.data.packs.length, 1);
  assert.equal(second.data.packs[0]?.files.length, 2);
  assert.equal(second.data.packs[0]?.status, "collecting");
  assert.equal(second.decision.replies[0]?.kind, "send");
  assert.equal(second.decision.replies[0]?.bar, "finish");
  assert.equal(second.decision.replies[0]?.replaceMessageId, 77);
  assert.match(second.decision.replies[0]?.text ?? "", /第2个文件/);

  const talking = step(second.data, textMessage(3, 12, "先别起名"), now, nextCode);
  assert.equal(talking.data.packs[0]?.status, "collecting");
  assert.equal(talking.data.packs[0]?.files.length, 2);
  assert.match(talking.decision.replies[0]?.text ?? "", /确认/);

  const asked = step(talking.data, press(4, "e"), now, nextCode);
  assert.equal(asked.data.packs[0]?.status, "naming");
  assert.equal(asked.data.packs[0]?.code, undefined);
  assert.match(asked.decision.replies[0]?.text ?? "", /至少5个字符/);

  const extra = step(asked.data, privateFile(5, 13, "附录.pdf"), now, nextCode);
  assert.equal(extra.data.packs[0]?.status, "collecting");
  assert.equal(extra.data.packs[0]?.files.length, 3);
  assert.equal(extra.data.packs[0]?.code, undefined);

  const named = finishPack(extra.data, "周报素材包", now, nextCode, 6);
  const ready = named.data.packs.filter((pack) => pack.status === "ready");
  assert.equal(ready.length, 1);
  assert.equal(named.data.packs.length, 1);
  assert.equal(ready[0]?.code, "abcdefgj");
  assert.equal(ready[0]?.name, "周报素材包");
  assert.equal(ready[0]?.files.length, 3);
  assert.match(named.decision.replies[0]?.text ?? "", /文件存储成功/);
  assert.equal(named.decision.replies[0]?.keyboard?.flat().some((button) => button.callback_data === "a:abcdefgj"), true);
  assert.match(named.decision.replies[0]?.text ?? "", /https:\/\/t\.me\/storebot\?start=abcdefgj/);
  assert.equal(named.decision.replies[0]?.keyboard?.flat().some((button) => button.callback_data === "w:new"), true);
  assert.equal(named.decision.replies[0]?.keyboard?.flat().some((button) => button.callback_data === "h"), true);
  const copied = named.decision.replies[0]?.keyboard?.[0]?.[0];
  assert.equal(copied?.text, "口令 abcdefgj");
  assert.deepEqual(copied?.copy_text, { text: "abcdefgj" });
  assert.equal(copied?.callback_data, undefined);
});

test("keeps one collecting notice when more files arrive", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-"));
  try {
    const repo = createVaultRepository(dir);
    await repo.update(() => baseData());
    const sent: string[] = [];
    const edits: string[] = [];
    const deleted: number[] = [];
    let nextId = 10;
    const io: VaultIO = {
      async copyMessage() {
        return 1;
      },
      async sendMessage(_chatId, text, _keyboard, _menu, bar) {
        sent.push(`${bar ?? "-"}:${text}`);
        return nextId++;
      },
      async editMessage(_chatId, _messageId, text) {
        edits.push(text);
      },
      async answerCallback() {
        return undefined;
      },
      async deleteMessage(_chatId, messageId) {
        deleted.push(messageId);
      },
      async deliver() {
        return undefined;
      },
      async flashBar(chatId, bar) {
        const carrier = await io.sendMessage(chatId, "·", undefined, bar !== "finish", bar === "finish" ? bar : undefined);
        if (typeof carrier === "number") await io.deleteMessage(chatId, carrier);
      },
    };
    const now = "2026-10-09T00:00:00.000Z";
    await applyVaultUpdate(privateFile(1, 10, "a.pdf"), repo, io, { now, nextCode: codes() });
    await applyVaultUpdate(privateFile(2, 11, "b.pdf"), repo, io, { now, nextCode: codes() });
    const saved = await repo.load();
    assert.equal(saved.packs[0]?.noticeMessageId, 11);
    assert.equal(edits.length, 0);
    assert.match(sent[0] ?? "", /^finish:📁新建文件夹/);
    assert.match(sent[1] ?? "", /^finish:📁新建文件夹/);
    assert.match(sent[1] ?? "", /第2个文件/);
    assert.equal(sent.length, 2);
    assert.deepEqual(deleted, [10]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pages stored files by tens and finishes from the bottom button", () => {
  const now = "2026-10-09T00:00:00.000Z";
  const nextCode = codes();
  const files = Array.from({ length: 10 }, (_, index) => ({
    kind: "document" as const,
    name: `素材${index + 1}.pdf`,
    chatId: "7",
    messageId: index + 1,
  }));
  const data = baseData({
    packs: [
      {
        id: "draft:7",
        status: "collecting",
        ownerId: "7",
        ownerName: "林夏",
        files,
        createdAt: now,
        noticeMessageId: 50,
        noticePage: 1,
      },
    ],
  });
  const added = step(data, privateFile(11, 11, "素材11.pdf"), now, nextCode);
  assert.equal(added.decision.replies[0]?.kind, "send");
  assert.equal(added.decision.replies[0]?.replaceMessageId, 50);
  assert.equal(added.decision.replies[0]?.bar, "finish");
  assert.match(added.decision.replies[0]?.text ?? "", /第11个文件/);
  assert.doesNotMatch(added.decision.replies[0]?.text ?? "", /素材1\.pdf/);
  const ended = step(added.data, textMessage(13, 13, "✅确认"), now, nextCode);
  assert.equal(ended.data.packs[0]?.status, "naming");
  assert.equal(ended.decision.replies[0]?.menu, true);
  assert.match(ended.decision.replies[0]?.text ?? "", /请输入文件夹名称/);

  const ready = {
    ...added.data.packs[0]!,
    id: "abcdefgj",
    code: "abcdefgj",
    status: "ready" as const,
    name: "素材包",
  };
  const viewed = step(baseData({ packs: [ready] }), press(14, "v:abcdefgj:2"), now, nextCode);
  assert.match(viewed.decision.replies[0]?.text ?? "", /第 2\/2 页/);
  assert.match(viewed.decision.replies[0]?.text ?? "", /11\. 素材11\.pdf/);
  assert.equal(
    viewed.decision.replies[0]?.keyboard?.flat().some((button) => button.callback_data === "v:abcdefgj:1"),
    true,
  );
});

test("replies to a code in a group with a button and marks it for deletion", () => {
  const nextCode = codes();
  const now = "2026-10-09T00:00:00.000Z";
  const saved = finishPack(step(baseData(), privateFile(1, 10), now, nextCode).data, "周报素材包", now, nextCode);
  const group = step(
    saved.data,
    update({
      update_id: 30,
      message: {
        message_id: 80,
        message_thread_id: 4,
        chat: { id: -1009, type: "supergroup", title: "讨论" },
        from: { id: 8, first_name: "周衡" },
        text: "编号 abcdefgj 看看",
      },
    }),
    now,
    nextCode,
  );
  const reply = group.decision.replies[0];
  assert.equal(reply?.replyToMessageId, 80);
  assert.equal(reply?.messageThreadId, 4);
  assert.equal(reply?.deleteAfterMs, 60_000);
  assert.match(reply?.text ?? "", /周报/);
  assert.match(reply?.text ?? "", /https:\/\/t\.me\/storebot\?start=abcdefgj/);
  assert.equal(reply?.keyboard?.[0]?.[0]?.url, "https://t.me/storebot?start=abcdefgj");
  assert.equal(reply?.keyboard?.[0]?.[0]?.text, "打开「周报素材包」");
  const anonymous = step(
    saved.data,
    update({
      update_id: 34,
      message: {
        message_id: 84,
        chat: { id: -1009, type: "supergroup", title: "讨论" },
        from: { id: 1087968824, is_bot: true, first_name: "Group", username: "GroupAnonymousBot" },
        sender_chat: { id: -1009, type: "supergroup", title: "讨论" },
        text: "abcdefgj",
      },
    }),
    now,
    nextCode,
  );
  assert.equal(anonymous.decision.replies[0]?.keyboard?.[0]?.[0]?.url, "https://t.me/storebot?start=abcdefgj");
  const otherBot = step(
    saved.data,
    update({
      update_id: 35,
      message: {
        message_id: 85,
        chat: { id: -1009, type: "supergroup" },
        from: { id: 50, is_bot: true, username: "otherbot" },
        text: "abcdefgj",
      },
    }),
    now,
    nextCode,
  );
  assert.equal(otherBot.decision.replies.length, 0);
  const comment = step(
    saved.data,
    update({
      update_id: 32,
      message: {
        message_id: 82,
        chat: { id: -1009, type: "supergroup", title: "评论" },
        from: { id: 8, first_name: "周衡" },
        text: "口令 abcdefgj",
        reply_to_message: { message_id: 55, is_automatic_forward: true, sender_chat: { id: -1001, type: "channel", title: "频道" } },
      },
    }),
    now,
    nextCode,
  );
  const commentReply = comment.decision.replies[0];
  assert.equal(commentReply?.replyToMessageId, 82);
  assert.equal(commentReply?.messageThreadId, 55);
  assert.equal(commentReply?.keyboard?.[0]?.[0]?.url, "https://t.me/storebot?start=abcdefgj");
  const mirrored = step(
    saved.data,
    update({
      update_id: 33,
      message: {
        message_id: 83,
        chat: { id: -1009, type: "supergroup" },
        is_automatic_forward: true,
        text: "abcdefgj",
        sender_chat: { id: -1001, type: "channel", title: "频道" },
      },
    }),
    now,
    nextCode,
  );
  assert.equal(mirrored.decision.replies.length, 0);
  const hidden = step(
    { ...saved.data, shareLinks: false },
    update({
      update_id: 31,
      message: {
        message_id: 81,
        chat: { id: -1009, type: "supergroup" },
        from: { id: 8, first_name: "周衡" },
        text: "abcdefgj",
      },
    }),
    now,
    nextCode,
  );
  assert.match(hidden.decision.replies[0]?.text ?? "", /分享已关闭/);
  const missing = step(
    saved.data,
    update({
      update_id: 32,
      message: {
        message_id: 82,
        chat: { id: -1009, type: "group" },
        from: { id: 8, first_name: "周衡" },
        text: "abcdefgh",
      },
    }),
    now,
    nextCode,
  );
  assert.match(missing.decision.replies[0]?.text ?? "", /没有这个口令/);
});

test("sends the link as plain text when the group button reply is rejected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-"));
  try {
    const now = "2026-10-09T00:00:00.000Z";
    const nextCode = codes();
    const saved = finishPack(step(baseData(), privateFile(1, 10), now, nextCode).data, "周报素材包", now, nextCode);
    const repo = createVaultRepository(dir);
    await repo.update(() => saved.data);
    const calls: Array<{ text: string; keyboard: boolean; reply?: number; thread?: number }> = [];
    let attempt = 0;
    const io: VaultIO = {
      async copyMessage() {
        return 1;
      },
      async sendMessage(_chatId, text, keyboard, _menu, _bar, replyTo) {
        calls.push({
          text,
          keyboard: Boolean(keyboard?.length),
          reply: replyTo?.messageId,
          thread: replyTo?.threadId,
        });
        attempt += 1;
        if (attempt === 1) throw new Error("message to be replied not found");
        return 70;
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
    await applyVaultUpdate(
      update({
        update_id: 40,
        message: {
          message_id: 80,
          message_thread_id: 4,
          chat: { id: -1009, type: "supergroup" },
          from: { id: 8, first_name: "周衡" },
          text: "abcdefgj",
        },
      }),
      repo,
      io,
      { now, nextCode },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.reply, 80);
    assert.equal(calls[0]?.thread, 4);
    assert.equal(calls[1]?.keyboard, false);
    assert.equal(calls[1]?.reply, undefined);
    assert.equal(calls[1]?.thread, undefined);
    assert.match(calls[1]?.text ?? "", /https:\/\/t\.me\/storebot\?start=abcdefgj/);
    assert.equal(calls.some((item) => item.text.includes("没处理成")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not store the same message twice", () => {
  const nextCode = codes();
  const first = step(baseData(), privateFile(1, 10), "2026-10-09T00:00:00.000Z", nextCode);
  const second = step(first.data, privateFile(2, 10), "2026-10-09T00:01:00.000Z", nextCode);
  assert.equal(second.data.packs[0]?.files.length, 1);
  assert.match(second.decision.replies[0]?.text ?? "", /已经收过了/);
});

test("only an admin can store once a folder exists", () => {
  const nextCode = codes();
  const now = "2026-10-09T00:00:00.000Z";
  const saved = finishPack(step(baseData(), privateFile(1, 10), now, nextCode).data, "周报素材包", now, nextCode);
  const incoming = {
    message_id: 30,
    chat: { id: 8, type: "private" },
    from: { id: 8, first_name: "周衡" },
    document: { file_id: "file-30", file_name: "外来.pdf", file_size: 20, mime_type: "application/pdf" },
  };
  const stranger = step(saved.data, update({ update_id: 30, message: incoming }), now, nextCode);
  assert.match(stranger.decision.replies[0]?.text ?? "", /才能存储/);
  assert.match(stranger.decision.replies[0]?.text ?? "", /用户编号是 8/);
  assert.equal(stranger.decision.replies[0]?.guest, true);
  assert.equal(stranger.data.packs.length, 1);
  assert.equal(stranger.data.packs[0]?.status, "ready");
  const menu = step(saved.data, textMessage(31, 31, "📩存储", 8), now, nextCode);
  assert.match(menu.decision.replies[0]?.text ?? "", /才能存储/);
  const hello = step(saved.data, textMessage(32, 32, "/start", 8), now, nextCode);
  assert.equal(hello.decision.replies[0]?.guest, true);
  assert.match(hello.decision.replies[0]?.text ?? "", /把口令发过来/);
  assert.match(hello.decision.replies[0]?.text ?? "", /用户编号是 8/);
  assert.doesNotMatch(hello.decision.replies[0]?.text ?? "", /取消并退出/);
  const owner = step(saved.data, privateFile(33, 33, "再存.pdf"), now, nextCode);
  assert.equal(owner.data.packs.some((pack) => pack.status === "collecting" && pack.ownerId === "7"), true);
  const unset = step(baseData({ ownerId: undefined }), privateFile(36, 36), now, nextCode);
  assert.match(unset.decision.replies[0]?.text ?? "", /才能存储/);
  assert.equal(unset.data.packs.length, 0);
  const locked = { ...saved.data, ownerId: "9", adminIds: ["8"] };
  const blocked = step(locked, privateFile(34, 34), now, nextCode);
  assert.match(blocked.decision.replies[0]?.text ?? "", /才能存储/);
  assert.equal(blocked.data.packs.filter((pack) => pack.status === "ready").length, 1);
  const allowed = step(locked, update({ update_id: 35, message: { ...incoming, message_id: 35 } }), now, nextCode);
  assert.equal(allowed.data.packs.some((pack) => pack.ownerId === "8" && pack.status === "collecting"), true);
});

test("keeps each person's packs private when sharing is off", () => {
  const nextCode = codes();
  const saved = finishPack(
    step(baseData({ shareLinks: false }), privateFile(1, 10), "2026-10-09T00:00:00.000Z", nextCode).data,
    "周报素材包",
    "2026-10-09T00:00:00.000Z",
    nextCode,
  );
  const stranger = step(
    saved.data,
    textMessage(20, 20, "/get abcdefgj", 8),
    "2026-10-09T00:02:00.000Z",
    nextCode,
  );
  assert.equal(stranger.decision.deliver, undefined);
  assert.match(stranger.decision.replies[0]?.text ?? "", /只有打包的人/);
  const owner = step(saved.data, textMessage(21, 21, "/get abcdefgj"), "2026-10-09T00:03:00.000Z", nextCode);
  assert.equal(owner.decision.deliver?.code, "abcdefgj");
});

test("lets a shared link retrieve the whole pack and only the owner delete it", () => {
  const nextCode = codes();
  const saved = finishPack(
    step(baseData(), privateFile(1, 10), "2026-10-09T00:00:00.000Z", nextCode).data,
    "周报素材包",
    "2026-10-09T00:00:00.000Z",
    nextCode,
  );
  const shared = step(saved.data, textMessage(20, 20, "/start abcdefgj", 8), "2026-10-09T00:02:00.000Z", nextCode);
  assert.equal(shared.decision.deliver?.chatId, "8");
  const removed = step(saved.data, press(21, "y:abcdefgj", 8), "2026-10-09T00:03:00.000Z", nextCode);
  assert.equal(removed.data.packs.filter((pack) => pack.status === "ready").length, 1);
  assert.match(removed.decision.callbackText ?? "", /只能删除/);
  const owner = step(saved.data, textMessage(22, 22, "/del abcdefgj"), "2026-10-09T00:04:00.000Z", nextCode);
  assert.equal(owner.data.packs.filter((pack) => pack.status === "ready").length, 0);
  assert.equal(owner.decision.replies[0]?.text.includes("已删除"), true);
});

test("pages ready packs and searches by the pack name", () => {
  let data = baseData();
  const nextCode = codes();
  for (let index = 0; index < 6; index += 1) {
    const collected = step(data, privateFile(index + 1, index + 1, `文件${index}.pdf`), `2026-10-09T00:0${index}:00.000Z`, nextCode);
    const named = finishPack(collected.data, `笔记素材${index}`, `2026-10-09T00:0${index}:00.000Z`, nextCode, 100 + index * 2);
    data = named.data;
  }
  assert.equal(data.packs.filter((pack) => pack.status === "ready").length, 6);
  const listed = step(data, textMessage(40, 40, "/list 2"), "2026-10-09T00:10:00.000Z", nextCode);
  assert.match(listed.decision.replies[0]?.text ?? "", /第 2\/2 页/);
  assert.equal(listed.decision.replies[0]?.keyboard?.at(-1)?.some((button) => button.callback_data === "l:1"), true);
  const found = step(data, textMessage(41, 41, "/search 笔记1"), "2026-10-09T00:11:00.000Z", nextCode);
  assert.match(found.decision.replies[0]?.text ?? "", /笔记1/);
  assert.doesNotMatch(found.decision.replies[0]?.text ?? "", /笔记2/);
});

test("menu offers home, store, get, and folder management", () => {
  assert.deepEqual(
    botCommands.map((item) => [item.command, item.description]),
    [
      ["start", MENU.home],
      ["put", MENU.store],
      ["get", MENU.get],
      ["folder", MENU.folders],
    ],
  );
  const nextCode = codes();
  const now = "2026-10-09T00:00:00.000Z";
  const started = step(baseData(), textMessage(1, 1, "🏠首页"), now, nextCode);
  assert.equal(started.decision.replies[0]?.menu, true);
  assert.match(started.decision.replies[0]?.text ?? "", /管理文件夹/);

  const stored = step(baseData(), textMessage(2, 2, "📩存储"), now, nextCode);
  assert.match(stored.decision.replies[0]?.text ?? "", /选择存储方式/);
  assert.equal(stored.decision.replies[0]?.keyboard?.[0]?.[0]?.callback_data, "w:new");
  assert.equal(stored.data.packs.length, 0);
  const opened = step(stored.data, press(3, "w:new"), now, nextCode);
  assert.equal(opened.data.packs[0]?.status, "collecting");
  assert.equal(opened.data.packs[0]?.files.length, 0);
  assert.equal(opened.decision.replies[0]?.bar, "finish");
  assert.match(opened.decision.replies[0]?.text ?? "", /请发送你要存储的文件/);

  const collecting = step(baseData(), privateFile(3, 3), now, nextCode);
  const named = finishPack(collecting.data, "周报素材包", now, nextCode, 4);
  const folders = step(named.data, textMessage(8, 8, "查看文件夹（打包好的）"), now, nextCode);
  assert.match(folders.decision.replies[0]?.text ?? "", /周报/);
  assert.equal(folders.data.packs[0]?.status, "ready");

  const asked = step(named.data, textMessage(9, 9, "搜索关键词"), now, nextCode);
  assert.equal(asked.data.prompts[0]?.kind, "search");
  assert.match(asked.decision.replies[0]?.text ?? "", /关键词/);
  const found = step(asked.data, textMessage(10, 10, "周报"), now, nextCode);
  assert.match(found.decision.replies[0]?.text ?? "", /周报/);
  assert.equal(found.data.prompts.length, 0);
  assert.equal(found.data.packs.length, 1);
});

test("other people can browse shared packs and see the files inside", () => {
  const nextCode = codes();
  const now = "2026-10-09T00:00:00.000Z";
  const saved = finishPack(
    step(baseData(), privateFile(1, 10, "报告.pdf"), now, nextCode).data,
    "周报素材包",
    now,
    nextCode,
  );
  const guest = step(saved.data, textMessage(20, 20, "查看文件夹（打包好的）", 8), now, nextCode);
  assert.match(guest.decision.replies[0]?.text ?? "", /周报/);
  assert.match(guest.decision.replies[0]?.text ?? "", /报告\.pdf/);
  const buttons = guest.decision.replies[0]?.keyboard?.flat() ?? [];
  assert.equal(buttons.some((button) => button.callback_data === "v:abcdefgj"), true);
  assert.equal(buttons.some((button) => button.callback_data === "g:abcdefgj"), true);
  assert.equal(buttons.some((button) => button.callback_data === "d:abcdefgj"), false);
  const detail = step(saved.data, press(21, "v:abcdefgj", 8), now, nextCode);
  assert.match(detail.decision.replies[0]?.text ?? "", /报告\.pdf/);
  assert.match(detail.decision.replies[0]?.text ?? "", /2 KB/);
  const found = step(saved.data, textMessage(22, 22, "/search 报告", 8), now, nextCode);
  assert.match(found.decision.replies[0]?.text ?? "", /周报/);
  const hidden = step({ ...saved.data, shareLinks: false }, textMessage(23, 23, "/folders", 8), now, nextCode);
  assert.doesNotMatch(hidden.decision.replies[0]?.text ?? "", /周报/);
  assert.match(hidden.decision.replies[0]?.text ?? "", /只显示你自己/);
  const owner = step({ ...saved.data, shareLinks: false }, textMessage(24, 24, "/folders"), now, nextCode);
  assert.match(owner.decision.replies[0]?.text ?? "", /周报/);
  assert.equal(
    owner.decision.replies[0]?.keyboard?.flat().some((button) => button.callback_data === "d:abcdefgj"),
    true,
  );
});

test("a menu button does not become the folder name", () => {
  const nextCode = codes();
  const now = "2026-10-09T00:00:00.000Z";
  const collecting = step(baseData(), privateFile(1, 10), now, nextCode);
  const naming = step(collecting.data, press(2, "e"), now, nextCode);
  assert.equal(naming.data.packs[0]?.status, "naming");
  const folders = step(naming.data, textMessage(3, 11, "查看文件夹（打包好的）"), now, nextCode);
  assert.equal(folders.data.packs[0]?.status, "naming");
  assert.equal(folders.data.packs[0]?.code, undefined);
  assert.match(folders.decision.replies[0]?.text ?? "", /还没有打包好的文件夹/);
});

test("appends files to a folder and renames it", () => {
  const nextCode = codes();
  const now = "2026-10-09T00:00:00.000Z";
  const named = finishPack(step(baseData(), privateFile(1, 10, "报告.pdf"), now, nextCode).data, "周报素材包", now, nextCode, 6);
  const adding = step(named.data, press(7, "a:abcdefgj"), now, nextCode);
  assert.equal(adding.data.packs[0]?.status, "collecting");
  assert.equal(adding.data.packs[0]?.code, "abcdefgj");
  assert.equal(adding.data.packs[0]?.appendFrom, 1);
  const more = step(adding.data, privateFile(8, 20, "附录.pdf"), now, nextCode);
  assert.equal(more.data.packs[0]?.files.length, 2);
  assert.equal(more.data.packs[0]?.code, "abcdefgj");
  const cancelled = step(more.data, textMessage(9, 21, "❌取消并退出"), now, nextCode);
  assert.equal(cancelled.data.packs[0]?.status, "ready");
  assert.equal(cancelled.data.packs[0]?.files.length, 1);
  const again = step(cancelled.data, press(10, "a:abcdefgj"), now, nextCode);
  const kept = step(step(again.data, privateFile(11, 22, "附录.pdf"), now, nextCode).data, textMessage(12, 23, "✅确认"), now, nextCode);
  assert.equal(kept.data.packs[0]?.status, "ready");
  assert.equal(kept.data.packs[0]?.files.length, 2);
  assert.match(kept.decision.replies[0]?.text ?? "", /文件数：2/);
  const renaming = step(kept.data, press(13, "n:abcdefgj"), now, nextCode);
  assert.equal(renaming.data.prompts[0]?.kind, "rename");
  const renamed = step(renaming.data, textMessage(14, 24, "月报素材包"), now, nextCode);
  assert.equal(renamed.data.packs[0]?.name, "月报素材包");
  assert.equal(renamed.data.prompts.length, 0);
  assert.match(renamed.decision.replies[0]?.text ?? "", /月报/);
});

test("cancel drops the open group before it has a code", () => {
  const nextCode = codes();
  const collected = step(baseData(), privateFile(1, 10), "2026-10-09T00:00:00.000Z", nextCode);
  const dropped = step(collected.data, textMessage(2, 11, "/cancel"), "2026-10-09T00:01:00.000Z", nextCode);
  assert.equal(dropped.data.packs.length, 0);
  assert.match(dropped.decision.replies[0]?.text ?? "", /已取消这一组/);
});

test("remembers a channel without storing its posts as files", () => {
  const reduced = step(
    baseData(),
    update({
      update_id: 1,
      my_chat_member: { chat: { id: -100123, type: "channel", title: "仓库" } },
    }),
    "2026-10-09T00:00:00.000Z",
    codes(),
  );
  assert.equal(reduced.data.packs.length, 0);
  assert.equal(reduced.data.seenChannels[0]?.id, "-100123");
  assert.equal(reduced.data.seenChannels[0]?.title, "仓库");
  const posted = step(
    reduced.data,
    update({
      update_id: 2,
      channel_post: {
        message_id: 4,
        chat: { id: -100123, type: "channel", title: "仓库" },
        text: "不要当成用户文件",
      },
    }),
    "2026-10-09T00:01:00.000Z",
    codes(),
  );
  assert.equal(posted.data.packs.length, 0);
});

test("stops a person at the pack limit", () => {
  const packs = Array.from({ length: VAULT_LIMITS.maxPacksPerUser }, (_, index) => readyPack(index));
  const reduced = step(baseData({ packs }), privateFile(1, 9000), "2026-10-09T00:00:00.000Z", codes());
  assert.equal(reduced.data.packs.length, VAULT_LIMITS.maxPacksPerUser);
  assert.match(reduced.decision.replies[0]?.text ?? "", /太多/);
});

test("copies a collected file into the storage channel before it is named", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-"));
  try {
    const repo = createVaultRepository(dir);
    await repo.update(() => baseData({ channelId: "-100555", channelTitle: "仓库" }));
    const sent: string[] = [];
    const io = fakeIo(sent, async () => 42);
    await applyVaultUpdate(privateFile(5, 10), repo, io, { now: "2026-10-09T00:00:00.000Z", nextCode: codes() });
    const saved = await repo.load();
    assert.equal(saved.offset, 6);
    assert.equal(saved.packs[0]?.status, "collecting");
    assert.equal(saved.packs[0]?.code, undefined);
    assert.equal(saved.packs[0]?.files[0]?.channelMessageId, 42);
    assert.equal(saved.packs[0]?.files[0]?.channelId, "-100555");
    assert.match(sent[0] ?? "", /第1个文件/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps the open group when the channel copy fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-"));
  try {
    const repo = createVaultRepository(dir);
    await repo.update(() => baseData({ channelId: "-100555" }));
    const sent: string[] = [];
    await applyVaultUpdate(privateFile(3, 8), repo, fakeIo(sent, async () => {
      throw new Error("没有权限");
    }), { now: "2026-10-09T00:00:00.000Z", nextCode: codes() });
    const saved = await repo.load();
    assert.equal(saved.packs.length, 1);
    assert.equal(saved.packs[0]?.status, "collecting");
    assert.equal(saved.packs[0]?.files[0]?.channelMessageId, undefined);
    assert.match(sent[0] ?? "", /还没放进仓库频道/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status never returns the raw token", () => {
  const status = toStatus(baseData({ token: TOKEN, enabled: true, packs: [readyPack(0)] }), true);
  const body = JSON.stringify(status);
  assert.equal(status.connected, true);
  assert.equal(status.running, true);
  assert.equal(status.packCount, 1);
  assert.equal(status.tokenHint, "123456789:••••Dsaw");
  assert.equal(body.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALD"), false);
});

test("chooses channel copy before a file id from another bot", () => {
  const item = storedFile();
  assert.equal(retrievalPlan(item, "2"), "channel");
  assert.equal(retrievalPlan({ ...item, channelId: undefined, channelMessageId: undefined }, "2"), "unavailable");
  assert.equal(retrievalPlan({ ...item, channelId: undefined, channelMessageId: undefined }, "1"), "file");
});

test("splits a retrieved pack into albums of ten", () => {
  const photos = Array.from({ length: 12 }, (_, index) => storedFile(index + 1, "99"));
  photos.forEach((file, index) => {
    file.kind = index === 10 ? "video" : "photo";
    file.fileId = `p${index}`;
  });
  const document = { ...storedFile(30, "99"), kind: "document" as const, fileId: "doc" };
  const document2 = { ...storedFile(31, "99"), kind: "document" as const, fileId: "doc2" };
  const voice = { ...storedFile(32, "99"), kind: "voice" as const, fileId: "voice" };
  const foreign = { ...storedFile(33, "1"), kind: "photo" as const, fileId: "other" };
  const batches = deliveryBatches([...photos, document, document2, voice, foreign], "99");
  assert.equal(batches[0]?.mode, "album");
  assert.equal(batches[0]?.mode === "album" ? batches[0].files.length : 0, 10);
  assert.equal(batches[1]?.mode, "album");
  assert.equal(batches[1]?.mode === "album" ? batches[1].files.length : 0, 2);
  assert.equal(batches[2]?.mode, "album");
  assert.equal(batches[3]?.mode, "single");
  assert.equal(batches[3]?.mode === "single" ? batches[3].file.kind : "", "voice");
  assert.equal(batches[4]?.mode === "single" ? batches[4].file.botId : "", "1");
});

test("packs a folder into one album even when the files arrived separately", () => {
  const album = (group: string, ids: number[]) =>
    ids.map((messageId) => ({
      ...storedFile(messageId, "99"),
      kind: "photo" as const,
      fileId: `${group}-${messageId}`,
      mediaGroupId: group,
      size: 1000,
      channelId: undefined,
      channelMessageId: undefined,
    }));
  const huge = {
    ...storedFile(5, "99"),
    kind: "video" as const,
    fileId: "big",
    mediaGroupId: "g1",
    size: 60 * 1024 * 1024,
    channelId: undefined,
    channelMessageId: undefined,
  };
  const batches = deliveryBatches([...album("g1", [1, 2, 3, 4]), huge, ...album("g2", [10, 11, 12])], "99");
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.mode, "album");
  assert.equal(batches[0]?.mode === "album" ? batches[0].files.length : 0, 8);
  assert.equal(retrievalPlan(huge, "99"), "file");
});

test("sends retrieval albums of ten and falls back one by one", async () => {
  const sent: string[] = [];
  const groups: { count: number; caption?: string }[] = [];
  const files = Array.from({ length: 11 }, (_, index) => ({
    ...storedFile(index + 1, "99"),
    kind: "document" as const,
    fileId: `d${index}`,
    channelId: undefined,
    channelMessageId: undefined,
  }));
  const client = {
    async sendMessage(_chatId: string, text: string) {
      sent.push(text);
    },
    async sendMediaGroup(_chatId: string, media: { media: string; caption?: string }[]) {
      groups.push({ count: media.length, caption: media[0]?.caption });
    },
    async copyMessage() {
      throw new Error("没有频道");
    },
    async sendFile() {
      sent.push("file");
    },
  };
  await deliverPack(client as unknown as BotClient, "7", { ...readyPack(0), name: "短剧", files }, "99");
  assert.deepEqual(groups, [{ count: 10, caption: "第 1/2 组，10 个" }]);
  assert.match(sent[0] ?? "", /按 10 个一组发出/);
  assert.match(sent.join("\n"), /第 2\/2 组，1 个/);
  assert.equal(sent.filter((line) => line === "file").length, 1);

  sent.length = 0;
  client.sendMediaGroup = async () => {
    throw new Error("这一组发不出去");
  };
  await deliverPack(client as unknown as BotClient, "7", { ...readyPack(0), name: "短剧", files: files.slice(0, 2) }, "99");
  assert.equal(sent.filter((line) => line === "file").length, 2);
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
  await deliverItem(client as unknown as BotClient, "7", storedFile(1, "99"), "99");
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

test("round-trips the vault file and ignores the old per-file list", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-"));
  try {
    await writeFile(
      path.join(dir, "vault.json"),
      JSON.stringify({ token: TOKEN, enabled: true, shareLinks: false, items: [{ code: "old" }] }),
    );
    const repo = createVaultRepository(dir);
    const loaded = await repo.load();
    assert.equal(loaded.token, TOKEN);
    assert.equal(loaded.shareLinks, false);
    assert.equal(loaded.enabled, true);
    assert.deepEqual(loaded.packs, []);
    await repo.update((current) => ({ ...current, packs: [readyPack(0)] }));
    const again = await repo.load();
    assert.equal(again.packs[0]?.code, "abcdefgj");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function readyPack(index: number): VaultPack {
  return {
    id: `code${index}`,
    code: CODES[index] ?? `code${index}`.slice(0, 8).padEnd(8, "a"),
    status: "ready",
    ownerId: "7",
    ownerName: "林夏",
    name: `旧${index}`,
    files: [storedFile(index + 1)],
    createdAt: "2026-10-08T00:00:00.000Z",
    readyAt: "2026-10-08T00:00:00.000Z",
  };
}

function storedFile(messageId = 1, botId = "1"): VaultFile {
  return {
    botId,
    kind: "document",
    name: "a.pdf",
    fileId: "abc",
    chatId: "7",
    messageId,
    channelId: "-1001",
    channelMessageId: 9,
  };
}

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

const SECOND = "987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

function hangingClients() {
  return (token: string) => {
    const id = Number(token.split(":")[0]);
    return {
      async getMe() {
        return { id, is_bot: true, first_name: "存", username: `b${id}` };
      },
      async deleteWebhook() {
        return true;
      },
      async setCommands() {
        return true;
      },
      async getUpdates(_offset: number, signal: AbortSignal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return [];
      },
      async deleteMessage() {
        return true;
      },
    } as unknown as BotClient;
  };
}

test("keeps a second bot token beside the first", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-fleet-"));
  const fleet = createFleet(dir);
  const clientFor = hangingClients();
  try {
    const first = await connectVault({ token: TOKEN }, fleet, clientFor);
    assert.equal(first.status.botCount, 1);
    assert.equal(first.status.maxBots, 10000);
    const second = await connectVault({ token: SECOND }, fleet, clientFor);
    assert.equal(second.status.botCount, 2);
    assert.equal(second.status.runningCount, 2);
    assert.equal(second.bots.map((bot) => bot.botId).sort().join(","), "123456789,987654321");
    const body = JSON.stringify(second);
    assert.equal(body.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALD"), false);
    assert.equal(body.includes("BBHdqTcvCH1vGWJxfSeofSAs0K5PALD"), false);
    const index = await readFile(path.join(dir, "fleet.json"), "utf8");
    assert.equal(index.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALD"), false);
    assert.equal(index.includes("BBHdqTcvCH1vGWJxfSeofSAs0K5PALD"), false);

    await fleet.repo("123456789").update((data) => ({
      ...data,
      packs: [
        ...data.packs,
        {
          id: "p",
          status: "ready",
          code: "abcdefgj",
          ownerId: "1",
          ownerName: "甲",
          files: [],
          createdAt: "2026-10-11T00:00:00.000Z",
        },
      ],
    }));
    const viewed = await vaultView("", 1, fleet);
    assert.equal(viewed.items.filter((item) => item.botId === "123456789").length, 1);
    assert.equal(viewed.items.filter((item) => item.botId === "987654321").length, 0);
    assert.equal((await fleet.repo("987654321").load()).packs.length, 0);

    const paused = await pauseVault({ botId: "123456789" }, fleet);
    assert.equal(paused.bots.find((bot) => bot.botId === "123456789")?.running, false);
    assert.equal(paused.bots.find((bot) => bot.botId === "987654321")?.running, true);
    assert.equal(paused.status.botCount, 2);
  } finally {
    await pauseVault({ botId: "123456789" }, fleet).catch(() => undefined);
    await pauseVault({ botId: "987654321" }, fleet).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("adopts an existing vault without putting the token in the index", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-legacy-"));
  try {
    await writeFile(
      path.join(dir, "vault.json"),
      JSON.stringify({ ...emptyVault(), token: TOKEN, enabled: false, botUsername: "storebot" }),
    );
    const fleet = createFleet(dir);
    await fleet.prepare();
    const saved = await fleet.repo("123456789").load();
    assert.equal(saved.token, TOKEN);
    assert.equal(saved.botUsername, "storebot");
    const index = await readFile(path.join(dir, "fleet.json"), "utf8");
    assert.equal(index.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALD"), false);
    assert.equal(index.includes("123456789"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses the 10001st bot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-cap-"));
  try {
    const bots = Array.from({ length: VAULT_LIMITS.maxBots }, (_, index) => ({
      id: String(300000 + index),
      active: true,
      packCount: 0,
      enabled: false,
      shareLinks: true,
    }));
    await writeFile(path.join(dir, "fleet.json"), JSON.stringify({ bots }));
    const fleet = createFleet(dir);
    let called = false;
    await assert.rejects(
      () =>
        connectVault({ token: TOKEN }, fleet, () => {
          called = true;
          throw new Error("不应去连 Telegram");
        }),
      (error: unknown) => {
        assert.match(error instanceof Error ? error.message : "", /最多接入 10000/);
        return true;
      },
    );
    assert.equal(called, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

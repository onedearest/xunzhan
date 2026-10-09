import assert from "node:assert/strict";
import test from "node:test";
import { parseBotToken } from "./bot-token";
import { telegramLoginUrl } from "./login-link";

test("accepts a BotFather token and trims it", () => {
  const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
  assert.equal(parseBotToken(`  ${token}\n`), token);
});

test("rejects tokens that are not from BotFather", () => {
  assert.equal(parseBotToken(""), null);
  assert.equal(parseBotToken("not-a-token"), null);
  assert.equal(parseBotToken("123:short"), null);
  assert.equal(parseBotToken("abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"), null);
});

test("builds a scan link without padding", () => {
  const url = telegramLoginUrl(Buffer.from("hello-xunzhan"));
  const token = url.slice("tg://login?token=".length);
  assert.equal(url.startsWith("tg://login?token="), true);
  assert.equal(token.includes("="), false);
  assert.equal(token.includes("+"), false);
  assert.equal(token.includes("/"), false);
});

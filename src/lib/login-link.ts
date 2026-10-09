export function telegramLoginUrl(token: Buffer): string {
  const encoded = token.toString("base64url");
  if (!encoded) throw new Error("二维码数据无效");
  return `tg://login?token=${encoded}`;
}

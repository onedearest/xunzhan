const BOT_TOKEN = /^(\d{6,16}):([A-Za-z0-9_-]{20,64})$/;

export function parseBotToken(input: string): string | null {
  const token = input.trim();
  const match = BOT_TOKEN.exec(token);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

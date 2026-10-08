import { errors } from "teleproto";

const known: Record<string, string> = {
  PHONE_CODE_INVALID: "验证码不正确",
  PHONE_CODE_EXPIRED: "验证码已过期，请重新获取",
  PHONE_CODE_EMPTY: "请填写验证码",
  PHONE_NUMBER_INVALID: "手机号格式不正确，请带国家码，例如 +8613800138000",
  PHONE_NUMBER_BANNED: "这个手机号已被 Telegram 限制",
  PHONE_NUMBER_FLOOD: "获取验证码太频繁，请稍后再试",
  PASSWORD_HASH_INVALID: "两步验证密码不正确",
  SESSION_PASSWORD_NEEDED: "需要两步验证密码",
  CHAT_WRITE_FORBIDDEN: "没有在这个群发言的权限",
  CHAT_SEND_PLAIN_FORBIDDEN: "这个群不允许发文字",
  USER_BANNED_IN_CHANNEL: "账号在该群被限制发言",
  CHANNEL_PRIVATE: "无法访问这个群",
  PEER_ID_INVALID: "找不到这个群，请刷新列表",
  AUTH_KEY_UNREGISTERED: "登录已失效，请重新登录",
  SESSION_REVOKED: "登录已失效，请重新登录",
  FROZEN_METHOD_INVALID: "这个账号已被 Telegram 冻结，暂时不能发消息",
};

export function explain(error: unknown): string {
  if (error instanceof errors.FloodWaitError) {
    return `Telegram 要求等待 ${error.seconds} 秒后再发`;
  }
  if (error instanceof errors.SlowModeWaitError) {
    return `这个群开启了慢速模式，需等待 ${error.seconds} 秒`;
  }
  const code =
    error &&
    typeof error === "object" &&
    "errorMessage" in error &&
    typeof error.errorMessage === "string"
      ? error.errorMessage
      : "";
  if (code.startsWith("FLOOD_WAIT_")) {
    return `Telegram 要求等待 ${code.slice("FLOOD_WAIT_".length)} 秒后再发`;
  }
  if (known[code]) return known[code];
  if (error instanceof Error && error.message) return error.message;
  if (code) return `Telegram 返回 ${code}`;
  return "出了点问题，请重试";
}

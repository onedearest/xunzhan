import { errorResponse, json, readBody } from "@/lib/http";
import { resendLoginCode } from "@/lib/telegram";

export async function POST(request: Request) {
  try {
    const body = (await readBody(request)) as { loginId?: unknown };
    if (typeof body.loginId !== "string") return json({ error: "登录已过期，请重新获取验证码" }, 400);
    return json(await resendLoginCode(body.loginId));
  } catch (error) {
    return errorResponse(error);
  }
}

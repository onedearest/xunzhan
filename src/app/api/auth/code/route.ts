import { errorResponse, json, readBody } from "@/lib/http";
import { submitCode } from "@/lib/telegram";

export async function POST(request: Request) {
  try {
    const body = (await readBody(request)) as { loginId?: unknown; code?: unknown };
    if (typeof body.loginId !== "string" || typeof body.code !== "string") {
      return json({ error: "请填写验证码" }, 400);
    }
    return json(await submitCode(body.loginId, body.code));
  } catch (error) {
    return errorResponse(error);
  }
}

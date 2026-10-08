import { errorResponse, json, readBody } from "@/lib/http";
import { submitPassword } from "@/lib/telegram";

export async function POST(request: Request) {
  try {
    const body = (await readBody(request)) as { loginId?: unknown; password?: unknown };
    if (typeof body.loginId !== "string" || typeof body.password !== "string") {
      return json({ error: "请填写两步验证密码" }, 400);
    }
    return json(await submitPassword(body.loginId, body.password));
  } catch (error) {
    return errorResponse(error);
  }
}

import { errorResponse, json, readBody } from "@/lib/http";
import { startBotLogin } from "@/lib/telegram";

export async function POST(request: Request) {
  try {
    const body = (await readBody(request)) as { token?: unknown };
    if (typeof body.token !== "string") return json({ error: "请填写机器人令牌" }, 400);
    return json(await startBotLogin(body.token));
  } catch (error) {
    return errorResponse(error);
  }
}

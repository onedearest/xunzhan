import { errorResponse, json, readBody } from "@/lib/http";
import { startLogin } from "@/lib/telegram";

export async function POST(request: Request) {
  try {
    const body = (await readBody(request)) as { phone?: unknown };
    if (typeof body.phone !== "string") return json({ error: "请填写手机号" }, 400);
    return json(await startLogin(body.phone));
  } catch (error) {
    return errorResponse(error);
  }
}

import { errorResponse, json, readBody } from "@/lib/http";
import { cancelLogin } from "@/lib/telegram";

export async function POST(request: Request) {
  try {
    const body = (await readBody(request)) as { loginId?: unknown };
    if (typeof body.loginId === "string") await cancelLogin(body.loginId);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

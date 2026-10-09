import { errorResponse, json } from "@/lib/http";
import { pollQrLogin, startQrLogin } from "@/lib/telegram";

export async function POST() {
  try {
    return json(await startQrLogin());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const loginId = new URL(request.url).searchParams.get("loginId");
    if (!loginId) return json({ error: "请重新打开扫码" }, 400);
    return json(await pollQrLogin(loginId));
  } catch (error) {
    return errorResponse(error);
  }
}

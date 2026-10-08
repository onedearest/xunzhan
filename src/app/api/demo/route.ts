import { listAccounts } from "@/lib/accounts";
import { errorResponse, json, readBody } from "@/lib/http";
import { saveConfig } from "@/lib/store";

export async function POST(request: Request) {
  try {
    const body = (await readBody(request)) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return json({ error: "缺少演示开关" }, 400);
    await saveConfig({ demo: body.enabled });
    return json({ demo: body.enabled, accounts: await listAccounts() });
  } catch (error) {
    return errorResponse(error);
  }
}

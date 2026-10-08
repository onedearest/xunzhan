import { settingsView } from "@/lib/accounts";
import { errorResponse, json, readBody } from "@/lib/http";
import { parseCredentials } from "@/lib/policy";
import { saveConfig } from "@/lib/store";

export async function PUT(request: Request) {
  try {
    const body = (await readBody(request)) as { apiId?: unknown; apiHash?: unknown };
    const parsed = parseCredentials(body.apiId, body.apiHash);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    await saveConfig({ apiId: parsed.apiId, apiHash: parsed.apiHash });
    return json({ settings: await settingsView() });
  } catch (error) {
    return errorResponse(error);
  }
}

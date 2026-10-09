import { errorResponse, json, readBody } from "@/lib/http";
import { connectVault, vaultView } from "@/lib/vault/service";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") || "1");
    const q = url.searchParams.get("q") || "";
    return json(await vaultView(q, Number.isFinite(page) ? page : 1));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await readBody(request)) as {
      token?: unknown;
      channelId?: unknown;
      shareLinks?: unknown;
    };
    return json(await connectVault(body));
  } catch (error) {
    return errorResponse(error);
  }
}

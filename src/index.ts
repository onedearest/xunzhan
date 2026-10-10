import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HttpError } from "./http";
import { connectVault, deleteVaultItem, forgetVault, pauseVault, resumeVault, vaultView } from "./vault/service";
import { homePage } from "./page";

const port = Number(process.env.PORT || 43128);
const host = process.env.HOST || "127.0.0.1";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  const message = error instanceof Error && error.message ? error.message : "出了点问题，请重试";
  return json({ error: message }, 400);
}

async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;
  try {
    if (pathname === "/" && method === "GET") {
      return new Response(homePage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (pathname === "/api/vault" && method === "GET") {
      const page = Number(url.searchParams.get("page") || "1");
      const q = url.searchParams.get("q") || "";
      return json(await vaultView(q, Number.isFinite(page) ? page : 1));
    }
    if (pathname === "/api/vault" && method === "PUT") {
      const body = (await request.json()) as { token?: unknown; channelId?: unknown; shareLinks?: unknown };
      return json(await connectVault(body));
    }
    if (pathname === "/api/vault/pause" && method === "POST") return json(await pauseVault());
    if (pathname === "/api/vault/forget" && method === "POST") return json(await forgetVault());
    const item = pathname.match(/^\/api\/vault\/items\/([^/]+)$/);
    if (item && method === "DELETE") return json(await deleteVaultItem(decodeURIComponent(item[1])));
    return new Response("没有这个页面", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (error) {
    return fail(error);
  }
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function toRequest(req: IncomingMessage) {
  const body = await readBody(req);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  const method = req.method || "GET";
  return new Request(`http://${host}:${port}${req.url || "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" || body.length === 0 ? undefined : body,
  });
}

async function sendResponse(res: ServerResponse, response: Response) {
  const payload = Buffer.from(await response.arrayBuffer());
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "content-length") return;
    res.setHeader(key, value);
  });
  res.setHeader("content-length", String(payload.length));
  res.end(payload);
}

const server = createServer(async (req, res) => {
  try {
    await sendResponse(res, await dispatch(await toRequest(req)));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(error instanceof Error ? error.message : "出了点问题");
  }
});

server.listen(port, host, () => {
  console.log(`storage-bot http://${host}:${port}`);
  void resumeVault();
});

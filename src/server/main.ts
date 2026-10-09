import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { DELETE as deleteAccount } from "../app/api/accounts/[id]/route";
import { GET as listChatsRoute } from "../app/api/accounts/[id]/chats/route";
import { GET as listPostsRoute } from "../app/api/accounts/[id]/posts/route";
import { POST as cancelLogin } from "../app/api/auth/cancel/route";
import { POST as submitCode } from "../app/api/auth/code/route";
import { POST as submitPassword } from "../app/api/auth/password/route";
import { POST as resendCode } from "../app/api/auth/resend/route";
import { POST as startLogin } from "../app/api/auth/start/route";
import { GET as bootstrap } from "../app/api/bootstrap/route";
import { POST as setDemo } from "../app/api/demo/route";
import { GET as getJobRoute } from "../app/api/jobs/[id]/route";
import { POST as stopJobRoute } from "../app/api/jobs/[id]/stop/route";
import { GET as listJobsRoute, POST as createJobRoute } from "../app/api/jobs/route";
import { PUT as saveSettings } from "../app/api/settings/route";

const port = Number(process.env.XUNZHAN_PORT || 43731);
const uiRoot = path.resolve(process.env.XUNZHAN_UI || path.join(__dirname, "ui"));

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function dispatch(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  if (pathname === "/api/bootstrap" && method === "GET") return bootstrap();
  if (pathname === "/api/demo" && method === "POST") return setDemo(request);
  if (pathname === "/api/settings" && method === "PUT") return saveSettings(request);
  if (pathname === "/api/auth/start" && method === "POST") return startLogin(request);
  if (pathname === "/api/auth/code" && method === "POST") return submitCode(request);
  if (pathname === "/api/auth/password" && method === "POST") return submitPassword(request);
  if (pathname === "/api/auth/resend" && method === "POST") return resendCode(request);
  if (pathname === "/api/auth/cancel" && method === "POST") return cancelLogin(request);
  if (pathname === "/api/jobs" && method === "GET") return listJobsRoute();
  if (pathname === "/api/jobs" && method === "POST") return createJobRoute(request);

  const posts = pathname.match(/^\/api\/accounts\/([^/]+)\/posts$/);
  if (posts && method === "GET") return listPostsRoute(request, params(posts[1]));
  const chats = pathname.match(/^\/api\/accounts\/([^/]+)\/chats$/);
  if (chats && method === "GET") return listChatsRoute(request, params(chats[1]));
  const account = pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (account && method === "DELETE") return deleteAccount(request, params(account[1]));
  const stop = pathname.match(/^\/api\/jobs\/([^/]+)\/stop$/);
  if (stop && method === "POST") return stopJobRoute(request, params(stop[1]));
  const job = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (job && method === "GET") return getJobRoute(request, params(job[1]));
  return null;
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
  return new Request(`http://127.0.0.1:${port}${req.url || "/"}`, {
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

async function sendFile(res: ServerResponse, pathname: string) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(uiRoot, relative);
  if (target !== uiRoot && !target.startsWith(`${uiRoot}${path.sep}`)) {
    res.statusCode = 403;
    res.end("禁止访问");
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    const type = types[path.extname(target)] || "application/octet-stream";
    res.statusCode = 200;
    res.setHeader("content-type", type);
    res.setHeader("content-length", String(info.size));
    createReadStream(target).pipe(res);
  } catch {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("没有这个页面");
  }
}

const server = createServer(async (req, res) => {
  try {
    const request = await toRequest(req);
    const handled = await dispatch(request);
    if (handled) {
      await sendResponse(res, handled);
      return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && request.url) {
      await sendFile(res, new URL(request.url).pathname);
      return;
    }
    res.statusCode = 404;
    res.end("没有这个页面");
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(error instanceof Error ? error.message : "出了点问题");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`讯栈已在 http://127.0.0.1:${port}`);
});

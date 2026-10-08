import { explain } from "./errors";

const headers = { "cache-control": "no-store" };

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers });
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  const message = explain(error);
  const status = message === "出了点问题，请重试" ? 500 : 400;
  return json({ error: message }, status);
}

export async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "请求格式不正确");
  }
}

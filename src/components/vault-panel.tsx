"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatSize } from "@/lib/vault/format";
import type { VaultPackPublic, VaultStatus } from "@/lib/vault/types";

type VaultView = {
  status: VaultStatus;
  items: VaultPackPublic[];
  page: number;
  pages: number;
  total: number;
};

const steps = [
  "在 Telegram 打开 @BotFather，发送 /newbot，按提示起名，复制它发来的令牌。",
  "把令牌贴到下面，点「开始接收」。讯栈会一直在这台机器上收消息。",
  "打开机器人，点菜单里的「存储」，把文件连续发给它。它们收进同一条消息，超过 10 个会翻页。",
  "收完点底部的「确认」，再发一个名称。之后可以追加文件或修改名称。查看时 10 个一页，取回时也按 10 个一组发出。",
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error("连不上工作台服务");
  }
  const data = (await response.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!response.ok) throw new Error(data?.error || "请求失败");
  return data as T;
}

function formatWhen(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function VaultPanel({ onClose, homeHref }: { onClose?: () => void; homeHref?: string }) {
  const [view, setView] = useState<VaultView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [channelId, setChannelId] = useState("");
  const [shareLinks, setShareLinks] = useState(true);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const touched = useRef(false);
  const queryRef = useRef(query);
  const pageRef = useRef(page);

  const applyView = useCallback((data: VaultView) => {
    setView(data);
    setLoadError(null);
    if (!touched.current) {
      setChannelId(data.status.channelId ?? "");
      setShareLinks(data.status.shareLinks);
    }
    return data;
  }, []);

  const load = useCallback(
    async (nextQuery: string, nextPage: number) => {
      const params = new URLSearchParams({ q: nextQuery, page: String(nextPage) });
      return applyView(await api<VaultView>(`/api/vault?${params}`));
    },
    [applyView],
  );

  useEffect(() => {
    queryRef.current = query;
    pageRef.current = page;
  }, [query, page]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ q: query, page: String(page) });
    void api<VaultView>(`/api/vault?${params}`)
      .then((data) => {
        if (!cancelled) applyView(data);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "没有读到仓库");
      });
    const timer = setInterval(() => {
      const next = new URLSearchParams({ q: query, page: String(page) });
      void api<VaultView>(`/api/vault?${next}`)
        .then((data) => {
          if (!cancelled) applyView(data);
        })
        .catch(() => undefined);
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [applyView, page, query]);

  function markTouched() {
    touched.current = true;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy("save");
    try {
      const data = await api<VaultView>("/api/vault", {
        method: "PUT",
        body: JSON.stringify({
          token: token.trim() || undefined,
          channelId,
          shareLinks,
        }),
      });
      touched.current = false;
      setToken("");
      setChannelId(data.status.channelId ?? "");
      setShareLinks(data.status.shareLinks);
      setPage(1);
      setFormError(null);
      setView(await load(queryRef.current, 1));
      toast.success(data.status.botUsername ? `已接上 @${data.status.botUsername}` : "已开始接收");
    } catch (error) {
      const message = error instanceof Error ? error.message : "没有接上";
      setFormError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  async function run(name: string, path: string) {
    setBusy(name);
    try {
      const data = await api<VaultView>(path, { method: "POST" });
      touched.current = false;
      setChannelId(data.status.channelId ?? "");
      setShareLinks(data.status.shareLinks);
      setView(await load(queryRef.current, pageRef.current));
      toast.success(name === "pause" ? "已暂停接收" : "已移除令牌，已保存的编号还在");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没有完成");
    } finally {
      setBusy(null);
    }
  }

  async function removeItem(code: string) {
    setBusy(code);
    try {
      await api<VaultView>(`/api/vault/items/${encodeURIComponent(code)}`, { method: "DELETE" });
      setPendingDelete(null);
      const data = await load(queryRef.current, pageRef.current);
      if (data.page !== pageRef.current) setPage(data.page);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没有删掉");
    } finally {
      setBusy(null);
    }
  }

  const status = view?.status;
  const running = Boolean(status?.running);
  const connected = Boolean(status?.connected);

  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-3xl gap-6 px-4 py-5 lg:px-8 lg:py-8">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-medium">存储机器人</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              贴上 @BotFather 的令牌就能用。文件先收成一组，点确认并写上名称之后，才生成一个编号和一条链接。之后还能追加文件、修改名称。文件本身留在 Telegram 上。
            </p>
          </div>
          {onClose || homeHref ? (
            <Button
              variant="outline"
              onClick={() => {
                if (onClose) onClose();
                else if (homeHref) window.location.href = homeHref;
              }}
            >
              返回
            </Button>
          ) : null}
        </header>

        <ol className="grid gap-3 rounded-lg border border-border bg-card p-4 text-sm leading-6">
          {steps.map((step, index) => (
            <li key={step} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs text-primary">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={running ? "default" : "secondary"}>{running ? "正在接收" : connected ? "已暂停" : "未接入"}</Badge>
            {status?.botUsername ? (
              <a
                className="text-sm text-primary underline-offset-4 hover:underline"
                href={`https://t.me/${status.botUsername}`}
                target="_blank"
                rel="noreferrer"
              >
                打开 @{status.botUsername}
              </a>
            ) : null}
            {status?.tokenHint ? <span className="text-xs text-muted-foreground">{status.tokenHint}</span> : null}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            {status ? `文件夹 ${status.packCount} 个` : "正在读取…"}
            {status?.channelTitle ? ` · 仓库频道 ${status.channelTitle}` : " · 还没绑定仓库频道"}
            {status?.shareLinks ? " · 编号链接可以转给别人" : " · 只有本人能取回"}
          </p>
          {status?.lastError ? <p className="mt-2 text-sm text-destructive">{status.lastError}</p> : null}
          {loadError ? <p className="mt-2 text-sm text-destructive">{loadError}</p> : null}
          {!connected && status?.botUsername ? (
            <p className="mt-2 text-sm text-muted-foreground">上次是 @{status.botUsername}。令牌已移除，以前的编号还在这份记录里。</p>
          ) : null}
        </section>

        <form className="grid gap-4 rounded-lg border border-border bg-card p-4" onSubmit={(event) => void save(event)}>
          <div className="grid gap-2">
            <Label htmlFor="vault-token">机器人令牌</Label>
            <Input
              id="vault-token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={connected ? "已保存。要换机器人再贴新令牌" : "123456789:ABC…"}
              autoComplete="off"
              spellCheck={false}
              className="h-10"
            />
            <p className="text-xs leading-5 text-muted-foreground">
              这和「登录账号」里的机器人不是一回事。登录账号是拿机器人去看会话；这里是让它接收别人发来的文件。
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="vault-channel">仓库频道，可以先不填</Label>
            <Input
              id="vault-channel"
              value={channelId}
              onChange={(event) => {
                markTouched();
                setChannelId(event.target.value);
              }}
              placeholder="-1001234567890 或 @频道用户名"
              autoComplete="off"
              spellCheck={false}
              className="h-10"
            />
            <p className="text-xs leading-5 text-muted-foreground">
              常见做法是再建一个私密频道，把机器人设为管理员并允许发消息。文件会复制进频道，用户删掉和机器人的聊天也能取回。把机器人加进频道后，编号会出现在下面。
            </p>
            {status?.seenChannels.length ? (
              <div className="flex flex-wrap gap-2">
                {status.seenChannels.map((channel) => (
                  <button
                    key={channel.id}
                    type="button"
                    className="rounded-md border border-border px-2 py-1 text-left text-xs hover:bg-muted"
                    onClick={() => {
                      markTouched();
                      setChannelId(channel.id);
                    }}
                  >
                    <span className="block font-medium">{channel.title}</span>
                    <span className="text-muted-foreground">{channel.id}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <label className="flex items-start gap-2 text-sm leading-5">
            <Checkbox
              className="mt-0.5"
              checked={shareLinks}
              onCheckedChange={(checked) => {
                markTouched();
                setShareLinks(checked === true);
              }}
            />
            <span>允许别人查看文件包并用链接取回。关掉之后，只有打包的人能在文件夹里看到，也只有本人能取。</span>
          </label>
          {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="h-10" disabled={busy !== null || (!connected && !token.trim())}>
              {busy === "save" ? <Loader2 className="animate-spin" /> : null}
              {connected ? "保存并接收" : "开始接收"}
            </Button>
            {connected ? (
              <Button
                type="button"
                variant="outline"
                className="h-10"
                disabled={busy !== null}
                onClick={() => void run("pause", "/api/vault/pause")}
              >
                {busy === "pause" ? <Loader2 className="animate-spin" /> : null}
                暂停
              </Button>
            ) : null}
            {connected ? (
              <Button
                type="button"
                variant="ghost"
                className="h-10"
                disabled={busy !== null}
                onClick={() => void run("forget", "/api/vault/forget")}
              >
                移除令牌
              </Button>
            ) : null}
          </div>
        </form>

        <section className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-medium">文件夹</h2>
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="搜索关键词、编号或发送人"
              className="h-9 max-w-64"
              aria-label="搜索文件夹"
            />
          </div>
          {!view ? (
            <p className="text-sm text-muted-foreground">正在读取…</p>
          ) : view.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              {query ? "没有匹配的文件夹。" : "还没有打包好的文件夹。在 Telegram 里点「存储」，把文件发给机器人，确认并写上名称之后，会出现在这里。"}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {view.items.map((item) => (
                <li key={item.code} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{item.name}</span>
                      <Badge variant="outline">{item.fileCount} 个文件</Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {item.code}
                      {` · ${item.ownerName}`}
                      {item.ownerUsername ? ` @${item.ownerUsername}` : ""}
                      {` · ${formatWhen(item.createdAt)}`}
                    </p>
                    {item.link ? (
                      <a className="mt-1 block truncate text-sm text-primary underline-offset-4 hover:underline" href={item.link}>
                        {item.link}
                      </a>
                    ) : null}
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {item.files.map((file) => (file.size ? `${file.name} · ${formatSize(file.size)}` : file.name)).join("、")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant={pendingDelete === item.code ? "destructive" : "ghost"}
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      if (pendingDelete === item.code) void removeItem(item.code);
                      else setPendingDelete(item.code);
                    }}
                  >
                    {busy === item.code ? <Loader2 className="animate-spin" /> : null}
                    {pendingDelete === item.code ? "确认删除" : "删除"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {view && view.pages > 1 ? (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                第 {view.page}/{view.pages} 页，共 {view.total} 个
              </span>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                  上一页
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= view.pages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          ) : null}
          <p className="text-xs leading-5 text-muted-foreground">
            这里能看到所有人发给这个机器人的文件。令牌和记录都在本机的 data 目录里，不要把这个页面暴露到公网。
          </p>
        </section>
      </div>
    </main>
  );
}

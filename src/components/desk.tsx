"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronsUpDown,
  CircleAlert,
  Loader2,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Send,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { LIMITS, jobSummary } from "@/lib/policy";
import type {
  AccountPublic,
  Bootstrap,
  ChatKind,
  ChatPublic,
  Job,
  PostPublic,
  SettingsView,
} from "@/lib/types";

type DeskMode = "send" | "browse";

type ChatState = {
  status: "loading" | "ready" | "error";
  chats: ChatPublic[];
  error?: string;
};

const kindLabel: Record<ChatKind, string> = {
  group: "群",
  supergroup: "超级群",
  channel: "频道",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new Error("连不上工作台服务");
  }
  const data = (await response.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!response.ok) throw new Error(data?.error || "请求失败");
  return data as T;
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `大约 ${seconds} 秒`;
  return `大约 ${Math.ceil(seconds / 60)} 分钟`;
}

function queueLabel(count: number, intervalSec: number, scheduled: boolean) {
  if (count <= 0) return "先在左侧勾选";
  const prefix = scheduled ? "到点后轮流发完，" : "轮流发完，";
  if (count === 1) return `${prefix}只有一条，不会再等间隔`;
  return `${prefix}${formatDuration((count - 1) * intervalSec)}`;
}

function activeJob(jobs: Job[]) {
  return jobs.find((item) => item.status === "running" || item.status === "scheduled") ?? null;
}

function formatWhen(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function Desk() {
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsView>({
    apiId: null,
    apiHash: "",
    hasHash: false,
    demo: false,
  });
  const [accounts, setAccounts] = useState<AccountPublic[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [chats, setChats] = useState<Record<string, ChatState>>({});
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [intervalSec, setIntervalSec] = useState(LIMITS.minIntervalSec);
  const [scheduledLocal, setScheduledLocal] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [mode, setMode] = useState<DeskMode>("send");
  const [browseId, setBrowseId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const previousJob = useRef<string | null>(null);

  const applyBootstrap = useCallback((data: Bootstrap) => {
    setSettings(data.settings);
    setAccounts(data.accounts);
    setHistory(data.jobs.filter((item) => item.status !== "running" && item.status !== "scheduled"));
    setJob(activeJob(data.jobs));
    setActiveId((current) => {
      if (current && data.accounts.some((account) => account.id === current)) return current;
      return data.accounts[0]?.id ?? null;
    });
  }, []);

  const reload = useCallback(async () => {
    const data = await api<Bootstrap>("/api/bootstrap");
    applyBootstrap(data);
    return data;
  }, [applyBootstrap]);

  useEffect(() => {
    let cancelled = false;
    void api<Bootstrap>("/api/bootstrap")
      .then((data) => {
        if (cancelled) return;
        applyBootstrap(data);
        if (data.settings.demo && data.accounts.every((account) => account.demo)) {
          setIntervalSec(2);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setBootError(error instanceof Error ? error.message : "打不开工作台");
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyBootstrap]);

  const loadChats = useCallback(async (id: string) => {
    setChats((current) => ({
      ...current,
      [id]: { status: "loading", chats: current[id]?.chats ?? [] },
    }));
    try {
      const data = await api<{ chats: ChatPublic[] }>(
        `/api/accounts/${encodeURIComponent(id)}/chats`,
      );
      setChats((current) => ({ ...current, [id]: { status: "ready", chats: data.chats } }));
      setSelected((current) => ({
        ...current,
        [id]: (current[id] ?? []).filter((chatId) =>
          data.chats.some((chat) => chat.id === chatId && chat.canPost),
        ),
      }));
    } catch (error) {
      setChats((current) => ({
        ...current,
        [id]: {
          status: "error",
          chats: [],
          error: error instanceof Error ? error.message : "群列表加载失败",
        },
      }));
    }
  }, []);

  useEffect(() => {
    if (!activeId || chats[activeId]) return;
    void loadChats(activeId);
  }, [activeId, chats, loadChats]);

  const watchedJobId =
    job?.status === "running" || job?.status === "scheduled" ? job.id : null;
  useEffect(() => {
    if (!watchedJobId) return;
    let stop = false;
    const timer = setInterval(() => {
      void api<{ job: Job }>(`/api/jobs/${watchedJobId}`)
        .then((data) => {
          if (!stop) setJob(data.job);
        })
        .catch(() => undefined);
    }, 700);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [watchedJobId]);

  useEffect(() => {
    if (!job) return;
    const marker = `${job.id}:${job.status}`;
    const previous = previousJob.current;
    previousJob.current = marker;
    if (previous !== `${job.id}:running` || job.status === "running" || job.status === "scheduled") {
      return;
    }
    const summary = jobSummary(job);
    if (job.status === "stopped") toast("发送已停止");
    else if (summary.error) toast.warning(`发出 ${summary.ok} 条，失败 ${summary.error} 条`);
    else toast.success(`已发到 ${summary.ok} 个群`);
    setHistory((current) => [job, ...current.filter((item) => item.id !== job.id)].slice(0, 8));
  }, [job]);

  const active = accounts.find((account) => account.id === activeId) ?? null;
  const chatState = activeId ? chats[activeId] : undefined;
  const visibleChats = useMemo(() => {
    const list = (chatState?.chats ?? []).filter((chat) =>
      mode === "browse" ? chat.kind === "channel" : true,
    );
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((chat) =>
      `${chat.title} ${chat.username ?? ""}`.toLowerCase().includes(needle),
    );
  }, [chatState, query, mode]);

  const selectedAccounts = accounts.filter((account) => (selected[account.id]?.length ?? 0) > 0);
  const selectedCount = selectedAccounts.reduce(
    (total, account) => total + (selected[account.id]?.length ?? 0),
    0,
  );
  const demoOnly =
    selectedAccounts.length > 0 && selectedAccounts.every((account) => account.demo);
  const minInterval = demoOnly ? LIMITS.demoMinIntervalSec : LIMITS.minIntervalSec;
  const running = job?.status === "running" || job?.status === "scheduled";
  const browseChat =
    mode === "browse" && activeId
      ? (chatState?.chats.find((chat) => chat.id === browseId && chat.kind === "channel") ?? null)
      : null;

  useEffect(() => {
    if (intervalSec < minInterval) setIntervalSec(minInterval);
  }, [intervalSec, minInterval]);

  function toggleChat(accountId: string, chatId: string) {
    setSelected((current) => {
      const list = current[accountId] ?? [];
      const next = list.includes(chatId)
        ? list.filter((id) => id !== chatId)
        : [...list, chatId];
      return { ...current, [accountId]: next };
    });
  }

  function selectVisible() {
    if (!activeId) return;
    const ids = visibleChats.filter((chat) => chat.canPost).map((chat) => chat.id);
    setSelected((current) => ({ ...current, [activeId]: ids }));
  }

  async function enableDemo(enabled: boolean) {
    setDemoBusy(true);
    try {
      await api("/api/demo", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      const data = await reload();
      if (enabled && data.accounts.every((account) => account.demo)) setIntervalSec(2);
      if (!enabled) {
        setSelected((current) => {
          const next = { ...current };
          for (const key of Object.keys(next)) {
            if (key.startsWith("demo-")) delete next[key];
          }
          return next;
        });
        setChats((current) => {
          const next = { ...current };
          for (const key of Object.keys(next)) {
            if (key.startsWith("demo-")) delete next[key];
          }
          return next;
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "演示模式切换失败");
    } finally {
      setDemoBusy(false);
    }
  }

  async function removeAccount(account: AccountPublic) {
    try {
      await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      setLeavingId(null);
      await reload();
      toast.success(account.demo ? "已关闭演示账号" : `已退出 ${account.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "退出失败");
    }
  }

  async function send() {
    setSending(true);
    try {
      const selections = accounts
        .map((account) => ({ accountId: account.id, chatIds: selected[account.id] ?? [] }))
        .filter((selection) => selection.chatIds.length > 0);
      let scheduledAt: string | null = null;
      if (scheduledLocal) {
        const when = new Date(scheduledLocal);
        if (Number.isNaN(when.getTime())) {
          toast.error("发送时间不正确");
          return;
        }
        scheduledAt = when.toISOString();
      }
      const data = await api<{ job: Job }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          message,
          intervalSec,
          confirmed,
          scheduledAt,
          selections,
        }),
      });
      setJob(data.job);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没有发出去");
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!job) return;
    try {
      const data = await api<{ job: Job }>(`/api/jobs/${job.id}/stop`, { method: "POST" });
      setJob(data.job);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "停止失败");
    }
  }

  function openAdd() {
    if (!settings.hasHash) {
      setSettingsOpen(true);
      toast("先保存 my.telegram.org 的应用凭证");
      return;
    }
    setLoginOpen(true);
  }

  if (booting) {
    return (
      <main className="desk-canvas grid min-h-dvh place-items-center px-6">
        <p className="text-sm text-muted-foreground">正在打开工作台…</p>
      </main>
    );
  }

  if (bootError) {
    return (
      <main className="desk-canvas grid min-h-dvh place-items-center px-6">
        <div className="max-w-sm text-center">
          <p className="font-heading text-2xl">工作台没有打开</p>
          <p className="mt-2 text-sm text-muted-foreground">{bootError}</p>
          <Button className="mt-5" onClick={() => window.location.reload()}>
            重试
          </Button>
        </div>
      </main>
    );
  }

  const rail = (
    <AccountRail
      accounts={accounts}
      activeId={activeId}
      selected={selected}
      demo={settings.demo}
      demoBusy={demoBusy}
      onSelect={(id) => {
        setActiveId(id);
        setQuery("");
        setNavOpen(false);
        setLeavingId(null);
      }}
      onAdd={openAdd}
      onSettings={() => setSettingsOpen(true)}
      onDemo={() => void enableDemo(!settings.demo)}
    />
  );

  return (
    <div className="desk-canvas flex h-dvh max-h-dvh overflow-hidden">
      <aside className="hidden h-dvh max-h-dvh min-h-0 w-[272px] shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex lg:flex-col">
        {rail}
      </aside>
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent
          side="left"
          className="flex h-dvh w-[280px] max-w-[86vw] flex-col overflow-hidden bg-sidebar p-0 text-sidebar-foreground sm:max-w-none"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>账号</SheetTitle>
            <SheetDescription>切换已登录的 Telegram 账号</SheetDescription>
          </SheetHeader>
          {rail}
        </SheetContent>
      </Sheet>

      {accounts.length === 0 ? (
        <Onboarding
          settings={settings}
          demoBusy={demoBusy}
          onOpenNav={() => setNavOpen(true)}
          onSaved={(next) => setSettings(next)}
          onAdd={openAdd}
          onDemo={() => void enableDemo(true)}
        />
      ) : (
        <div className="grid min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[minmax(0,1fr)]">
          <section className="flex min-h-0 flex-col lg:border-r lg:border-border">
            <header className="flex items-center gap-3 border-b border-border px-4 py-3 lg:px-6">
              <Button
                variant="outline"
                size="icon"
                className="lg:hidden"
                onClick={() => setNavOpen(true)}
                aria-label="打开账号列表"
              >
                <Menu />
              </Button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-medium">{active?.name ?? "选择账号"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {active ? active.phone : "登录后才能看到群"}
                  {active?.username ? ` · @${active.username}` : ""}
                  {active?.demo ? " · 演示" : ""}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!activeId || chatState?.status === "loading"}
                onClick={() => activeId && void loadChats(activeId)}
              >
                <RefreshCw />
                刷新
              </Button>
              {active ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    leavingId === active.id ? void removeAccount(active) : setLeavingId(active.id)
                  }
                >
                  {leavingId === active.id ? "确认退出" : active.demo ? "关闭演示" : "退出"}
                </Button>
              ) : null}
            </header>

            <div className="space-y-2 border-b border-border px-4 py-3 lg:px-6">
              <div className="flex items-center gap-2">
              <div className="flex shrink-0 rounded-lg border border-border p-0.5">
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1 text-xs ${mode === "send" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                  onClick={() => setMode("send")}
                >
                  群发
                </button>
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1 text-xs ${mode === "browse" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                  onClick={() => setMode("browse")}
                >
                  浏览
                </button>
              </div>
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={mode === "browse" ? "搜索频道" : "搜索群名或用户名"}
                  className="h-9 pl-8"
                  aria-label={mode === "browse" ? "搜索频道" : "搜索群"}
                />
              </div>
              </div>
              {mode === "send" ? (
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={selectVisible}>
                    全选可发
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => activeId && setSelected((current) => ({ ...current, [activeId]: [] }))}
                  >
                    清空
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 lg:px-4">
              <ChatList
                mode={mode}
                state={chatState}
                chats={visibleChats}
                selected={activeId ? (selected[activeId] ?? []) : []}
                browsingId={browseChat?.id ?? null}
                job={job}
                accountId={activeId}
                onToggle={(chatId) => activeId && toggleChat(activeId, chatId)}
                onBrowse={setBrowseId}
                onRetry={() => activeId && void loadChats(activeId)}
              />
            </div>
          </section>

          {mode === "browse" ? (
            <Reader accountId={activeId} chat={browseChat} />
          ) : (
            <Composer
              message={message}
              intervalSec={intervalSec}
              minInterval={minInterval}
              confirmed={confirmed}
              selectedCount={selectedCount}
              accountCount={selectedAccounts.length}
              scheduledLocal={scheduledLocal}
              estimate={queueLabel(selectedCount, intervalSec, Boolean(scheduledLocal))}
              running={running}
              sending={sending}
              job={job}
              history={history}
              onMessage={setMessage}
              onInterval={setIntervalSec}
              onScheduled={setScheduledLocal}
              onConfirmed={setConfirmed}
              onSend={() => void send()}
              onStop={() => void stop()}
              onClearJob={() => setJob(null)}
              onOpenJob={setJob}
            />
          )}
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onOpenChange={setSettingsOpen}
        onSaved={setSettings}
      />
      <LoginDialog
        open={loginOpen}
        onOpenChange={setLoginOpen}
        onReady={(account) => {
          setAccounts((current) => [
            account,
            ...current.filter((item) => item.id !== account.id),
          ]);
          setActiveId(account.id);
          setChats((current) => {
            const next = { ...current };
            delete next[account.id];
            return next;
          });
          toast.success(`已登录 ${account.name}`);
        }}
      />
    </div>
  );
}

function AccountRail({
  accounts,
  activeId,
  selected,
  demo,
  demoBusy,
  onSelect,
  onAdd,
  onSettings,
  onDemo,
}: {
  accounts: AccountPublic[];
  activeId: string | null;
  selected: Record<string, string[]>;
  demo: boolean;
  demoBusy: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSettings: () => void;
  onDemo: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-4 py-5">
        <span className="grid size-9 place-items-center rounded-md bg-[#f4efe4] font-heading text-lg text-[#1d4a3d]">
          讯
        </span>
        <div>
          <p className="font-heading text-xl leading-none text-[#f4efe4]">讯栈</p>
          <p className="mt-1 text-[11px] tracking-[0.16em] text-[#d9d0c0] uppercase">
            Dispatch desk
          </p>
        </div>
      </div>
      <p className="px-4 pb-2 text-xs text-[#b7ad9e]">账号</p>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2">
        {accounts.length === 0 ? (
          <p className="px-2 py-6 text-sm text-[#b7ad9e]">还没有登录的账号。</p>
        ) : (
          accounts.map((account) => {
            const count = selected[account.id]?.length ?? 0;
            const current = account.id === activeId;
            return (
              <button
                key={account.id}
                type="button"
                onClick={() => onSelect(account.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left ${
                  current ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-white/5"
                }`}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#315e50] text-sm text-[#f4efe4]">
                  {account.name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm">{account.name}</span>
                    {account.demo ? (
                      <span className="rounded bg-white/10 px-1 text-[10px]">演示</span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-[#b7ad9e]">{account.phone}</span>
                </span>
                {count > 0 ? (
                  <span className="rounded-full bg-[#f4efe4] px-1.5 text-xs text-[#1d4a3d]">
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
      <div className="shrink-0 space-y-2 border-t border-sidebar-border p-3">
        <Button
          variant="secondary"
          className="h-9 w-full bg-[#f4efe4] text-[#1c1915] hover:bg-[#efe6d4]"
          onClick={onAdd}
        >
          <Plus />
          添加账号
        </Button>
        <Button
          variant="ghost"
          className="w-full text-sidebar-foreground hover:bg-white/10 hover:text-sidebar-foreground"
          onClick={onSettings}
        >
          应用凭证
        </Button>
        <Button
          variant="ghost"
          className="w-full text-sidebar-foreground hover:bg-white/10 hover:text-sidebar-foreground"
          disabled={demoBusy}
          onClick={onDemo}
        >
          {demo ? "关闭演示" : "演示数据"}
        </Button>
      </div>
    </div>
  );
}

function ChatList({
  mode,
  state,
  chats,
  selected,
  browsingId,
  job,
  accountId,
  onToggle,
  onBrowse,
  onRetry,
}: {
  mode: DeskMode;
  state?: ChatState;
  chats: ChatPublic[];
  selected: string[];
  browsingId: string | null;
  job: Job | null;
  accountId: string | null;
  onToggle: (chatId: string) => void;
  onBrowse: (chatId: string) => void;
  onRetry: () => void;
}) {
  if (!state || (state.status === "loading" && state.chats.length === 0)) {
    return (
      <div className="space-y-2 p-2" aria-busy="true">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="h-16 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="grid min-h-64 place-items-center px-6 text-center">
        <div>
          <CircleAlert className="mx-auto size-5 text-destructive" />
          <p className="mt-3 text-sm">{state.error}</p>
          <Button className="mt-4" variant="outline" onClick={onRetry}>
            重试
          </Button>
        </div>
      </div>
    );
  }
  if (state.chats.length === 0) {
    return (
      <div className="grid min-h-64 place-items-center px-6 text-center">
        <div>
          <p className="font-medium">这个账号还没有群</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            这里只列出已经加入的群和频道。私聊不会出现，也不能从这里加群。
          </p>
        </div>
      </div>
    );
  }
  if (chats.length === 0) {
    return (
      <div className="grid min-h-64 place-items-center px-6 text-center">
        <p className="text-sm text-muted-foreground">
          {mode === "browse" ? "没有可浏览的频道" : "没有匹配的群"}
        </p>
      </div>
    );
  }

  if (mode === "browse") {
    return (
      <ul className="space-y-1">
        {chats.map((chat) => {
          const closed = Boolean(chat.reason?.includes("退出") || chat.reason?.includes("无权"));
          const on = chat.id === browsingId;
          return (
            <li key={chat.id}>
              <button
                type="button"
                disabled={closed}
                onClick={() => onBrowse(chat.id)}
                className={`flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left ${
                  closed ? "cursor-not-allowed opacity-60" : "hover:bg-card"
                } ${on ? "bg-card ring-1 ring-primary/30" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{chat.title}</span>
                    <Badge variant="outline">频道</Badge>
                    {!chat.canPost && !closed ? <Badge variant="secondary">只读</Badge> : null}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {chat.username ? `@${chat.username} · ` : ""}
                    {closed ? chat.reason : "打开后在右侧上下滚动，不会增加阅读数"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <ul className="space-y-1">
      {chats.map((chat) => {
        const on = selected.includes(chat.id);
        const delivery = job?.deliveries.find(
          (item) => item.accountId === accountId && item.chatId === chat.id,
        );
        return (
          <li key={chat.id}>
            <label
              className={`flex items-start gap-3 rounded-lg px-3 py-3 ${
                chat.canPost ? "cursor-pointer hover:bg-card" : "opacity-60"
              } ${on ? "bg-card ring-1 ring-primary/30" : ""}`}
            >
              <Checkbox
                className="mt-0.5"
                checked={on}
                disabled={!chat.canPost}
                onCheckedChange={() => onToggle(chat.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-medium">{chat.title}</span>
                  <Badge variant="outline">{kindLabel[chat.kind]}</Badge>
                  {chat.slowmode ? <Badge variant="secondary">慢速</Badge> : null}
                  {delivery ? <DeliveryBadge status={delivery.status} /> : null}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {chat.username ? `@${chat.username} · ` : ""}
                  {typeof chat.participantsCount === "number"
                    ? `${chat.participantsCount.toLocaleString("zh-CN")} 人`
                    : "成员数未知"}
                  {chat.reason ? ` · ${chat.reason}` : ""}
                  {delivery?.error ? ` · ${delivery.error}` : ""}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function DeliveryBadge({ status }: { status: Job["deliveries"][number]["status"] }) {
  if (status === "ok") return <Badge>已发</Badge>;
  if (status === "error") return <Badge variant="destructive">失败</Badge>;
  if (status === "sending") return <Badge variant="secondary">发送中</Badge>;
  if (status === "skipped") return <Badge variant="outline">已跳过</Badge>;
  return <Badge variant="outline">排队</Badge>;
}

function Reader({ accountId, chat }: { accountId: string | null; chat: ChatPublic | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const direction = useRef<1 | -1>(1);
  const requestId = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);
  const chatKey = accountId && chat ? `${accountId}:${chat.id}:${reloadToken}` : "";
  const [session, setSession] = useState<{
    key: string;
    posts: PostPublic[];
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
    auto: boolean;
  }>({ key: "", posts: [], status: "idle", error: null, auto: false });
  let view = session;
  if (session.key !== chatKey) {
    view = {
      key: chatKey,
      posts: [],
      status: chatKey ? "loading" : "idle",
      error: null,
      auto: false,
    };
    setSession(view);
  }
  const posts = view.posts;
  const status = view.status;
  const error = view.error;
  const auto = view.auto;

  useEffect(() => {
    direction.current = 1;
    if (scroller.current) scroller.current.scrollTop = 0;
    if (!chatKey || !accountId || !chat) return;
    const current = ++requestId.current;
    let cancelled = false;
    void api<{ posts: PostPublic[] }>(
      `/api/accounts/${encodeURIComponent(accountId)}/posts?chatId=${encodeURIComponent(chat.id)}`,
    )
      .then((data) => {
        if (cancelled || current !== requestId.current) return;
        setSession((currentSession) =>
          currentSession.key === chatKey
            ? { ...currentSession, posts: data.posts, status: "ready", error: null }
            : currentSession,
        );
      })
      .catch((reason: unknown) => {
        if (cancelled || current !== requestId.current) return;
        setSession((currentSession) =>
          currentSession.key === chatKey
            ? {
                ...currentSession,
                posts: [],
                status: "error",
                error: reason instanceof Error ? reason.message : "帖子没有加载出来",
              }
            : currentSession,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, chat, chatKey]);

  useEffect(() => {
    if (!auto) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const el = scroller.current;
      const delta = ((now - last) / 1000) * 72;
      last = now;
      if (el) {
        const max = el.scrollHeight - el.clientHeight;
        if (max > 4) {
          let next = el.scrollTop + delta * direction.current;
          if (next >= max) {
            next = max;
            direction.current = -1;
          } else if (next <= 0) {
            next = 0;
            direction.current = 1;
          }
          el.scrollTop = next;
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [auto]);

  return (
    <aside className="flex max-h-[52dvh] min-h-0 flex-col border-t border-border bg-card lg:max-h-none lg:border-t-0">
      <div className="border-b border-border px-4 py-4 lg:px-5">
        <p className="font-heading text-2xl leading-none">浏览频道</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {chat ? chat.title : "选一个已经加入的频道。"}
          自动浏览只在这个窗口里上下滑动，不标记已读，也不增加阅读数。
        </p>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 lg:px-5">
        {!chat ? (
          <div className="grid min-h-48 place-items-center text-center">
            <p className="text-sm text-muted-foreground">左侧点一个频道，这里会列出最近的帖子。</p>
          </div>
        ) : status === "loading" ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="h-20 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : status === "error" ? (
          <div className="grid min-h-48 place-items-center text-center">
            <div>
              <CircleAlert className="mx-auto size-5 text-destructive" />
              <p className="mt-3 text-sm">{error}</p>
              <Button className="mt-4" variant="outline" onClick={() => setReloadToken((value) => value + 1)}>
                重试
              </Button>
            </div>
          </div>
        ) : posts.length === 0 ? (
          <div className="grid min-h-48 place-items-center text-center">
            <p className="text-sm text-muted-foreground">这个频道最近没有文字或图片帖。</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {posts.map((post) => (
              <li key={post.id} className="rounded-lg border border-border bg-background px-3 py-3">
                <p className="text-sm leading-6 whitespace-pre-wrap">{post.text}</p>
                <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                  {formatWhen(post.date)}
                  {typeof post.views === "number" ? ` · 已有 ${post.views.toLocaleString("zh-CN")} 次阅读` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="shrink-0 border-t border-border px-4 py-3 lg:px-5">
        <Button
          className="h-10 w-full"
          variant={auto ? "destructive" : "default"}
          disabled={!chat || status !== "ready" || posts.length === 0}
          onClick={() => {
            direction.current = 1;
            setSession((current) => ({ ...current, auto: !current.auto }));
          }}
        >
          {auto ? <Square /> : <ChevronsUpDown />}
          {auto ? "停止滑动" : "自动上下浏览"}
        </Button>
      </div>
    </aside>
  );
}

function Composer({
  message,
  intervalSec,
  minInterval,
  confirmed,
  selectedCount,
  accountCount,
  scheduledLocal,
  estimate,
  running,
  sending,
  job,
  history,
  onMessage,
  onInterval,
  onScheduled,
  onConfirmed,
  onSend,
  onStop,
  onClearJob,
  onOpenJob,
}: {
  message: string;
  intervalSec: number;
  minInterval: number;
  confirmed: boolean;
  selectedCount: number;
  accountCount: number;
  scheduledLocal: string;
  estimate: string;
  running: boolean;
  sending: boolean;
  job: Job | null;
  history: Job[];
  onMessage: (value: string) => void;
  onInterval: (value: number) => void;
  onScheduled: (value: string) => void;
  onConfirmed: (value: boolean) => void;
  onSend: () => void;
  onStop: () => void;
  onClearJob: () => void;
  onOpenJob: (job: Job) => void;
}) {
  const summary = job ? jobSummary(job) : null;
  const progress = summary && summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  return (
    <aside className="flex max-h-[52dvh] min-h-0 flex-col border-t border-border bg-card lg:max-h-none lg:border-t-0">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 lg:px-5">
        <div>
          <p className="font-heading text-2xl leading-none">发出去</p>
          <p className="mt-2 text-sm text-muted-foreground">
            每个账号先发一条，再换下一个。全部轮过一遍，才发各自的下一条。每条之间都等这个间隔。
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="message">消息</Label>
          <Textarea
            id="message"
            value={message}
            disabled={running}
            onChange={(event) => onMessage(event.target.value)}
            placeholder="写给这些群的同一段话"
            className="min-h-32 resize-none"
            maxLength={LIMITS.maxMessageLength}
          />
          <p className="text-right text-xs text-muted-foreground tabular-nums">
            {message.trim().length}/{LIMITS.maxMessageLength}
          </p>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <Label htmlFor="interval">每条之间的间隔</Label>
            <span className="tabular-nums">{intervalSec} 秒</span>
          </div>
          <input
            id="interval"
            type="range"
            min={minInterval}
            max={LIMITS.maxIntervalSec}
            step={1}
            value={intervalSec}
            disabled={running}
            onChange={(event) => onInterval(Number(event.target.value))}
            className="w-full accent-[var(--primary)]"
          />
          <p className="text-xs text-muted-foreground">
            {minInterval === 1
              ? "演示数据可以把间隔调到 1 秒。真实账号最短 8 秒，账号之间也要等。"
              : `真实账号最短 ${LIMITS.minIntervalSec} 秒。每个账号最多 ${LIMITS.maxPerAccount} 个群，单次最多 ${LIMITS.maxTargets} 个，登录槽最多 ${LIMITS.maxAccounts} 个。`}
          </p>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="when">定时开始</Label>
            {scheduledLocal ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline"
                disabled={running}
                onClick={() => onScheduled("")}
              >
                改为立刻
              </button>
            ) : null}
          </div>
          <Input
            id="when"
            type="datetime-local"
            value={scheduledLocal}
            disabled={running}
            onChange={(event) => onScheduled(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            留空就马上开始。设定后，到点才轮流发送，最远 {LIMITS.maxScheduleDays} 天。关掉窗口会取消还没开始的定时。
          </p>
        </div>
        <label className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-3 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={confirmed}
            disabled={running}
            onCheckedChange={(checked) => onConfirmed(checked)}
          />
          <span>这些群是我管理，或已经允许我发布的。我不会用它给无关的群发广告。</span>
        </label>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-sm">
              {selectedCount > 0
                ? `${accountCount} 个账号 · ${selectedCount} 个群`
                : "还没有选择群"}
            </p>
            <p className="text-xs text-muted-foreground">{selectedCount > 0 ? estimate : "先在左侧勾选"}</p>
          </div>
        </div>
        {running ? (
          <Button variant="destructive" className="h-10 w-full" onClick={onStop}>
            <Square />
            {job?.status === "scheduled" ? "取消定时" : "停止发送"}
          </Button>
        ) : (
          <Button
            className="h-10 w-full"
            disabled={sending || !message.trim() || selectedCount === 0 || !confirmed}
            onClick={onSend}
          >
            {sending ? <Loader2 className="animate-spin" /> : <Send />}
            开始发送
          </Button>
        )}
        {job && summary ? (
          <div className="space-y-3 rounded-lg border border-border bg-background p-3" aria-live="polite">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">
                {job.status === "scheduled"
                  ? `等到 ${job.scheduledAt ? formatWhen(job.scheduledAt) : "设定时间"} 再开始`
                  : job.status === "running"
                  ? "正在轮流发送"
                  : job.status === "stopped"
                    ? "已停止"
                    : job.status === "failed"
                      ? "没有发出去"
                      : "这轮结束了"}
              </p>
              <button type="button" className="text-xs text-muted-foreground underline" onClick={onClearJob}>
                收起
              </button>
            </div>
            <Progress value={progress} className="w-full" />
            <p className="text-xs text-muted-foreground tabular-nums">
              成功 {summary.ok} · 失败 {summary.error} · 跳过 {summary.skipped} / {summary.total}
            </p>
            <ul className="max-h-40 space-y-1.5 overflow-y-auto text-xs">
              {job.deliveries.map((delivery) => (
                <li key={`${delivery.accountId}-${delivery.chatId}`} className="flex justify-between gap-3">
                  <span className="truncate">
                    {delivery.accountName} · {delivery.title}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {delivery.status === "ok"
                      ? "已发"
                      : delivery.status === "error"
                        ? delivery.error
                        : delivery.status === "sending"
                          ? "发送中"
                          : delivery.status === "skipped"
                            ? "已跳过"
                            : "排队"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {history.length > 0 ? (
          <div>
            <p className="mb-2 text-xs text-muted-foreground">最近的发送</p>
            <ul className="space-y-1">
              {history.slice(0, 4).map((item) => {
                const itemSummary = jobSummary(item);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                      onClick={() => onOpenJob(item)}
                    >
                      <span className="truncate">{item.message}</span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {itemSummary.ok}/{itemSummary.total} · {formatWhen(item.createdAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function Onboarding({
  settings,
  demoBusy,
  onOpenNav,
  onSaved,
  onAdd,
  onDemo,
}: {
  settings: SettingsView;
  demoBusy: boolean;
  onOpenNav: () => void;
  onSaved: (settings: SettingsView) => void;
  onAdd: () => void;
  onDemo: () => void;
}) {
  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 lg:hidden">
        <p className="font-heading text-xl">讯栈</p>
        <Button variant="outline" size="icon" onClick={onOpenNav} aria-label="打开菜单">
          <Menu />
        </Button>
      </div>
      <div className="mx-auto grid max-w-3xl gap-10 px-5 py-8 lg:px-10 lg:py-16">
        <div>
          <p className="text-xs tracking-[0.18em] text-primary uppercase">Dispatch desk</p>
          <h1 className="mt-3 max-w-xl font-heading text-4xl leading-tight text-balance sm:text-5xl">
            把一条消息，送到你负责的每一个群。
          </h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
            讯栈可以登录最多 {LIMITS.maxAccounts} 个 Telegram 账号。勾选已经加入的群，账号会轮流发言。它不会自动加群，也不会给陌生人发私信。
          </p>
        </div>
        <ol className="grid gap-3 sm:grid-cols-3">
          {[
            ["01", "填入应用凭证", "用 my.telegram.org 的 api_id 和 api_hash。"],
            ["02", "登录多个账号", "手机号、验证码，有两步验证就再填一次密码。"],
            ["03", "轮流发出", "一个账号发一条，再换下一个。每条之间最短 8 秒。"],
          ].map(([index, title, copy]) => (
            <li key={index} className="rounded-xl border border-border bg-card p-4">
              <p className="font-heading text-lg text-primary">{index}</p>
              <p className="mt-2 font-medium">{title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{copy}</p>
            </li>
          ))}
        </ol>
        <div className="rounded-xl border border-border bg-card p-5">
          {settings.hasHash ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">应用凭证已保存</p>
                <p className="mt-1 text-sm text-muted-foreground">api_id {settings.apiId}</p>
              </div>
              <Button className="h-10" onClick={onAdd}>
                <Plus />
                添加第一个账号
              </Button>
            </div>
          ) : (
            <CredentialForm settings={settings} onSaved={onSaved} />
          )}
          <div className="mt-4 border-t border-border pt-4">
            <Button variant="outline" disabled={demoBusy} onClick={onDemo}>
              {demoBusy ? <Loader2 className="animate-spin" /> : null}
              先用演示数据走一遍
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}

function CredentialForm({
  settings,
  onSaved,
}: {
  settings: SettingsView;
  onSaved: (settings: SettingsView) => void;
}) {
  const [apiId, setApiId] = useState(settings.apiId ? String(settings.apiId) : "");
  const [apiHash, setApiHash] = useState(settings.apiHash);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const data = await api<{ settings: SettingsView }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ apiId: Number(apiId), apiHash }),
      });
      onSaved(data.settings);
      toast.success("凭证已保存在这台服务器");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没有保存");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div>
        <p className="font-medium">应用凭证</p>
        <p className="mt-1 text-sm text-muted-foreground">
          打开{" "}
          <a
            className="underline"
            href="https://my.telegram.org"
            target="_blank"
            rel="noreferrer"
          >
            my.telegram.org
          </a>
          ，在 API development tools 里创建应用。凭证只写在服务器的 data 目录。
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="api-id">api_id</Label>
          <Input
            id="api-id"
            inputMode="numeric"
            value={apiId}
            onChange={(event) => setApiId(event.target.value)}
            placeholder="12345678"
            className="h-10"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="api-hash">api_hash</Label>
          <Input
            id="api-hash"
            value={apiHash}
            onChange={(event) => setApiHash(event.target.value)}
            placeholder="32 位十六进制"
            className="h-10"
            autoComplete="off"
          />
        </div>
      </div>
      <Button type="submit" className="h-10" disabled={saving}>
        {saving ? <Loader2 className="animate-spin" /> : null}
        保存凭证
      </Button>
    </form>
  );
}

function SettingsDialog({
  open,
  settings,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  settings: SettingsView;
  onOpenChange: (open: boolean) => void;
  onSaved: (settings: SettingsView) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>应用凭证</DialogTitle>
          <DialogDescription>每个第三方客户端都要有自己的 api_id 和 api_hash。</DialogDescription>
        </DialogHeader>
        <CredentialForm
          key={`${settings.apiId ?? ""}:${settings.apiHash}`}
          settings={settings}
          onSaved={(next) => {
            onSaved(next);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function LoginDialog({
  open,
  onOpenChange,
  onReady,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReady: (account: AccountPublic) => void;
}) {
  const [step, setStep] = useState<"phone" | "code" | "password">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [loginId, setLoginId] = useState<string | null>(null);
  const loginIdRef = useRef<string | null>(null);
  useEffect(() => {
    loginIdRef.current = loginId;
  }, [loginId]);
  const [hint, setHint] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const skipCancel = useRef(false);

  function reset() {
    setStep("phone");
    setCode("");
    setPassword("");
    setLoginId(null);
    setHint(undefined);
    setNotice("");
  }

  function handleOpen(next: boolean) {
    if (!next && !skipCancel.current && loginIdRef.current) {
      void api("/api/auth/cancel", {
        method: "POST",
        body: JSON.stringify({ loginId: loginIdRef.current }),
      }).catch(() => undefined);
    }
    if (!next) {
      skipCancel.current = false;
      reset();
    }
    onOpenChange(next);
  }

  async function start() {
    setBusy(true);
    try {
      const data = await api<{ loginId: string; message: string }>("/api/auth/start", {
        method: "POST",
        body: JSON.stringify({ phone }),
      });
      setLoginId(data.loginId);
      setNotice(data.message);
      setStep("code");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没有发出验证码");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    if (!loginId) return;
    setBusy(true);
    try {
      const data = await api<
        | { needPassword: true; hint?: string }
        | { needPassword: false; account: AccountPublic }
      >("/api/auth/code", {
        method: "POST",
        body: JSON.stringify({ loginId, code }),
      });
      if (data.needPassword) {
        setHint(data.hint);
        setStep("password");
        return;
      }
      skipCancel.current = true;
      loginIdRef.current = null;
      onReady(data.account);
      onOpenChange(false);
      reset();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword() {
    if (!loginId) return;
    setBusy(true);
    try {
      const data = await api<{ account: AccountPublic }>("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({ loginId, password }),
      });
      skipCancel.current = true;
      loginIdRef.current = null;
      onReady(data.account);
      onOpenChange(false);
      reset();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "密码不正确");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!loginId) return;
    setBusy(true);
    try {
      const data = await api<{ message: string }>("/api/auth/resend", {
        method: "POST",
        body: JSON.stringify({ loginId }),
      });
      setNotice(data.message);
      toast.success(data.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "没有重发");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {step === "phone" ? "添加账号" : step === "code" ? "填写验证码" : "两步验证"}
          </DialogTitle>
          <DialogDescription>
            {step === "phone"
              ? "使用带国家码的手机号。验证码会发到已登录的 Telegram，或通过短信。"
              : step === "code"
                ? notice || "填入刚刚收到的验证码。"
                : hint
                  ? `密码提示：${hint}`
                  : "这个账号开了两步验证。"}
          </DialogDescription>
        </DialogHeader>
        {step === "phone" ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="phone">手机号</Label>
              <Input
                id="phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+86 13800138000"
                autoComplete="tel"
                className="h-10"
              />
            </div>
            <DialogFooter>
              <Button type="submit" className="h-10" disabled={busy || !phone.trim()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                获取验证码
              </Button>
            </DialogFooter>
          </form>
        ) : null}
        {step === "code" ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCode();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="code">验证码</Label>
              <Input
                id="code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                className="h-10"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void resend()}>
                重发
              </Button>
              <Button type="submit" className="h-10" disabled={busy || !code.trim()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                登录
              </Button>
            </DialogFooter>
          </form>
        ) : null}
        {step === "password" ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPassword();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                className="h-10"
              />
            </div>
            <DialogFooter>
              <Button type="submit" className="h-10" disabled={busy || !password.trim()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                完成登录
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

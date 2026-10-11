export function homePage() {
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Storage bot</title>
  <style>
    body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #101114; color: #f4f4f5; }
    main { max-width: 640px; margin: 0 auto; padding: 28px 16px 48px; }
    h1 { font-size: 24px; font-weight: 560; margin: 0 0 8px; }
    p, li { color: #c4c4cc; }
    section, form, ol { border: 1px solid #2a2c33; border-radius: 10px; padding: 16px; margin: 16px 0; }
    label { display: block; margin: 12px 0 6px; }
    input[type="text"] { width: 100%; box-sizing: border-box; height: 40px; border-radius: 8px; border: 1px solid #3a3d46; background: #181a20; color: inherit; padding: 0 10px; }
    button { height: 38px; border-radius: 8px; border: 0; padding: 0 14px; background: #f4f4f5; color: #111; cursor: pointer; }
    button.ghost { background: transparent; color: #f4f4f5; border: 1px solid #3a3d46; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .err { color: #f0a8a8; }
    .ok { color: #b7e3c2; }
  </style>
</head>
<body>
<main>
  <h1>Storage bot</h1>
  <p>这台电脑最多接入 10000 个机器人。每个令牌分开收消息，文件夹也分开保存。贴上 @BotFather 的令牌即可，已经在收的机器人不会被换掉。</p>
  <ol>
    <li>在 @BotFather 发送 /newbot，复制整段令牌。</li>
    <li>贴到下面，点开始接收。这台机器要一直开着。</li>
    <li>打开机器人。底部是获取、首页、存储、管理文件夹。</li>
  </ol>
  <section id="status">正在读取…</section>
  <form id="form">
    <label for="token">机器人令牌</label>
    <input id="token" type="text" autocomplete="off" spellcheck="false" placeholder="123456789:ABC…" />
    <label for="channel">仓库频道，可以先不填</label>
    <input id="channel" type="text" autocomplete="off" spellcheck="false" placeholder="@频道 或 -100…" />
    <label><input id="share" type="checkbox" checked /> 允许别人用链接取回</label>
    <p id="error" class="err"></p>
    <div class="row">
      <button type="submit">接入这个机器人</button>
    </div>
  </form>
  <section>
    <h2>机器人</h2>
    <div id="bots"></div>
  </section>
  <section>
    <h2>文件夹</h2>
    <div id="list"></div>
  </section>
</main>
<script>
const statusEl = document.querySelector("#status");
const botsEl = document.querySelector("#bots");
const listEl = document.querySelector("#list");
const errorEl = document.querySelector("#error");
let botPage = 1;
async function api(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "没有完成");
  return data;
}
function button(label, className, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  if (className) node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}
function draw(data) {
  const status = data.status || {};
  const count = status.botCount ?? 0;
  const max = status.maxBots ?? 10000;
  const running = status.runningCount ?? (status.running ? 1 : 0);
  statusEl.textContent = "已接入 " + count + " / " + max + " 个机器人 · 正在接收 " + running + " 个 · 文件夹 " + (status.packCount ?? 0) + " 个" + (status.lastError ? " · " + status.lastError : "");
  botsEl.replaceChildren();
  const bots = data.bots || [];
  if (!bots.length) {
    const empty = document.createElement("p");
    empty.textContent = "还没有接入机器人。";
    botsEl.append(empty);
  }
  for (const bot of bots) {
    const line = document.createElement("p");
    const who = bot.botUsername ? "@" + bot.botUsername : bot.botId;
    line.textContent = who + " · 文件夹 " + bot.packCount + (bot.running ? " · 正在接收" : " · 已暂停") + (bot.lastError ? " · " + bot.lastError : "");
    const row = document.createElement("div");
    row.className = "row";
    row.append(button(bot.running ? "暂停" : "继续", "ghost", async () => {
      errorEl.textContent = "";
      try {
        if (bot.running) draw(await api("/api/vault/pause", { method: "POST", body: JSON.stringify({ botId: bot.botId }) }));
        else draw(await api("/api/vault", { method: "PUT", body: JSON.stringify({ botId: bot.botId }) }));
      } catch (error) {
        errorEl.textContent = error.message;
      }
    }));
    row.append(button("移除令牌", "ghost", async () => {
      errorEl.textContent = "";
      try {
        draw(await api("/api/vault/forget", { method: "POST", body: JSON.stringify({ botId: bot.botId }) }));
      } catch (error) {
        errorEl.textContent = error.message;
      }
    }));
    botsEl.append(line, row);
  }
  if ((data.pages || 1) > 1) {
    const nav = document.createElement("div");
    nav.className = "row";
    if (data.page > 1) nav.append(button("上一页", "ghost", () => { botPage = data.page - 1; load().catch((error) => { errorEl.textContent = error.message; }); }));
    if (data.page < data.pages) nav.append(button("下一页", "ghost", () => { botPage = data.page + 1; load().catch((error) => { errorEl.textContent = error.message; }); }));
    botsEl.append(nav);
  }
  listEl.replaceChildren();
  const items = data.items || [];
  if (!items.length) {
    const empty = document.createElement("p");
    empty.textContent = "还没有打包好的文件夹。";
    listEl.append(empty);
  } else {
    for (const item of items) {
      const line = document.createElement("p");
      const owner = bots.find((bot) => bot.botId === item.botId);
      const who = owner && owner.botUsername ? "@" + owner.botUsername + " · " : "";
      line.textContent = who + item.name + " · " + item.fileCount + " 个 · " + item.code;
      listEl.append(line);
    }
  }
}
async function load() {
  draw(await api("/api/vault?page=" + botPage));
}
document.querySelector("#form").addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.textContent = "";
  try {
    const channel = document.querySelector("#channel").value.trim();
    const data = await api("/api/vault", { method: "PUT", body: JSON.stringify({
      token: document.querySelector("#token").value.trim() || undefined,
      ...(channel ? { channelId: channel } : {}),
      shareLinks: document.querySelector("#share").checked
    }) });
    document.querySelector("#token").value = "";
    botPage = 1;
    draw(data);
  } catch (error) {
    errorEl.textContent = error.message;
  }
});
load().catch((error) => { statusEl.textContent = error.message; });
</script>
</body>
</html>`;
}

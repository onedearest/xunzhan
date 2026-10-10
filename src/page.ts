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
  <p>贴上 @BotFather 的令牌。在 Telegram 里点存储，先建文件夹，确认后发一个至少 5 个字符的名称，名称发出去就生成口令和链接。</p>
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
      <button type="submit">开始接收</button>
      <button class="ghost" id="pause" type="button">暂停</button>
      <button class="ghost" id="forget" type="button">移除令牌</button>
    </div>
  </form>
  <section>
    <h2>文件夹</h2>
    <div id="list"></div>
  </section>
</main>
<script>
const statusEl = document.querySelector("#status");
const listEl = document.querySelector("#list");
const errorEl = document.querySelector("#error");
async function api(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "没有完成");
  return data;
}
function draw(data) {
  const status = data.status || {};
  const running = status.running ? "正在接收" : status.connected ? "已暂停" : "未接入";
  statusEl.textContent = running + " · 文件夹 " + (status.packCount ?? 0) + " 个" + (status.botUsername ? " · @" + status.botUsername : "") + (status.lastError ? " · " + status.lastError : "");
  listEl.replaceChildren();
  const items = data.items || [];
  if (!items.length) {
    const empty = document.createElement("p");
    empty.textContent = "还没有打包好的文件夹。";
    listEl.append(empty);
  } else {
    for (const item of items) {
      const line = document.createElement("p");
      line.textContent = item.name + " · " + item.fileCount + " 个 · " + item.code;
      listEl.append(line);
    }
  }
}
async function load() {
  draw(await api("/api/vault"));
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
    draw(data);
  } catch (error) {
    errorEl.textContent = error.message;
  }
});
document.querySelector("#pause").onclick = async () => { errorEl.textContent = ""; draw(await api("/api/vault/pause", { method: "POST" })); };
document.querySelector("#forget").onclick = async () => { errorEl.textContent = ""; draw(await api("/api/vault/forget", { method: "POST" })); };
load().catch((error) => { statusEl.textContent = error.message; });
</script>
</body>
</html>`;
}

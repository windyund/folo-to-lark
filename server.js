// server.js —— Folo webhook → 飞书(Lark)机器人卡片 转换器(Railway 版)
//
// 作用:接收 Folo「Webhook」Action 的 POST,转成飞书自定义机器人要的卡片格式再转发。
// 无状态:不用轮询、不用去重(Folo 已替你判新)。
//
// 部署见同目录 README。需要的环境变量:
//   LARK_WEBHOOK  飞书自定义机器人 webhook 地址(必填)
//   LARK_SECRET   机器人开了「签名校验」才填,否则留空
//   PORT          Railway 会自动注入,本地不填默认 3000
//
// 仅依赖 Node 内置模块,无需 npm install 任何东西。

const http = require("http");
const crypto = require("crypto");

const LARK_WEBHOOK = process.env.LARK_WEBHOOK || "";
const LARK_SECRET  = process.env.LARK_SECRET || "";
const PORT         = process.env.PORT || 3000;

function stripTags(s) {
  return String(s == null ? "" : s).replace(/<[^>]+>/g, "").trim();
}

// ISO 时间转北京时间显示,如 2026-06-16 15:28
function toBeijing(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso == null ? "" : iso);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d).replace(/\//g, "-");
}

// 飞书自定义机器人签名:key = `${timestamp}\n${secret}`,对空串做 HMAC-SHA256,再 base64
function larkSign(timestamp) {
  const stringToSign = `${timestamp}\n${LARK_SECRET}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

// 从可能的字段里找 Folo 的 AI 总结(字段名不确定,多试几个)
function pickSummary(entry, payload) {
  const cands = [
    entry.aiSummary, entry.ai_summary, entry.summary, entry.summaryAi,
    payload.aiSummary, payload.ai_summary, payload.summary,
  ];
  for (const c of cands) {
    const s = stripTags(c);
    if (s) return s;
  }
  return "";
}

function buildText(entry, payload) {
  const body   = stripTags(entry.content || entry.description || entry.title) || "(无文本)";
  const link   = entry.url || entry.guid || "";
  const author = entry.author || "aleabitoreddit";
  const when   = toBeijing(entry.publishedAt);
  const summary = pickSummary(entry, payload);

  const mediaList = Array.isArray(entry.media) ? entry.media : [];
  const mediaUrls = mediaList
    .map((m) => (typeof m === "string" ? m : (m && (m.url || m.preview_image_url))))
    .filter(Boolean);

  const lines = [`📢 @${author} 发新帖了`];
  if (when) lines.push(`🕒 ${when}`);
  lines.push("");                      // 空行
  lines.push(body);
  if (summary) lines.push("", `🤖 AI 总结:${summary}`);
  if (mediaUrls.length) lines.push("", `🖼 媒体:${mediaUrls.join("  ")}`);
  if (link) lines.push("", `🔗 ${link}`);

  const msg = { msg_type: "text", content: { text: lines.join("\n") } };
  if (LARK_SECRET) {
    const ts = Math.floor(Date.now() / 1000);
    msg.timestamp = String(ts);
    msg.sign = larkSign(ts);
  }
  return msg;
}

async function forwardToLark(card) {
  const resp = await fetch(LARK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });
  return { status: resp.status, body: await resp.text() };
}

const server = http.createServer((req, res) => {
  // 健康检查 / 浏览器直接打开
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }
    // 临时:打印 Folo 真实 payload,用于确认 AI 总结在哪个字段。确认后可删。
    console.log("Folo payload:", JSON.stringify(payload));
    try {
      const entry = payload.entry || {};
      const result = await forwardToLark(buildText(entry, payload));
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body);
    } catch (e) {
      console.error("转发失败:", e);
      res.writeHead(502).end("forward failed");
    }
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`folo-to-lark listening on :${PORT}`)
);
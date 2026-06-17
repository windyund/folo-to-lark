// server.js —— Folo webhook → DeepSeek 翻译/总结 → 飞书(Lark) 转发 (Railway 版)
//
// 作用: 接收 Folo「Webhook」Action 的 POST, 用 DeepSeek 翻译、解读并映射 A 股, 再推送到飞书机器人。
// 无状态: 不用轮询、不用去重 (Folo 已替你判新)。
//
// 环境变量:
//   LARK_WEBHOOK       飞书自定义机器人 webhook 地址 (必填)
//   LARK_SECRET        机器人开了「签名校验」才填, 否则留空
//   DEEPSEEK_API_KEY   DeepSeek API Key (填了才做 AI 翻译/总结)
//   DEEPSEEK_MODEL     模型名, 默认 deepseek-chat
//   DEEPSEEK_BASE_URL  API 地址, 默认 https://api.deepseek.com
//   PORT               Railway 会自动注入, 本地不填默认 3000
//
// 仅依赖 Node 内置模块, 无需 npm install 任何东西。

const http = require("http");
const crypto = require("crypto");

const LARK_WEBHOOK      = process.env.LARK_WEBHOOK || "";
const LARK_SECRET       = process.env.LARK_SECRET || "";
const DEEPSEEK_API_KEY  = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL    = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const PORT              = process.env.PORT || 3000;

const AI_TIMEOUT_MS = 45_000;
const MAX_INPUT_CHARS = 6000;

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

function truncate(s, max = MAX_INPUT_CHARS) {
  const t = String(s || "");
  if (t.length <= max) return t;
  return t.slice(0, max) + "\n…(内容已截断)";
}

async function processWithDeepSeek(title, body) {
  if (!DEEPSEEK_API_KEY) return null;

  const userContent = [
    title ? `标题: ${title}` : "",
    `正文:\n${truncate(body)}`,
  ].filter(Boolean).join("\n\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "你是资深金融分析师，擅长从全球资讯中提炼产业与政策信号，并映射到中国 A 股上市公司。\n\n" +
              "用户会给你一条社交媒体帖子。请先理解其商业、行业或宏观含义，再延伸出可能受影响的 A 股标的。\n\n" +
              "输出 JSON，字段:\n" +
              '- "translation": 流畅的中文翻译; 若原文已是中文则给出润色后的中文\n' +
              '- "summary": 2-3 句话概括帖子核心信息, 及其对产业或市场的潜在影响\n' +
              '- "a_shares": 基于帖子内容列出 2-5 只可能相关的 A 股标的, 每只一行, 格式「公司名(代码) — 关联逻辑」; ' +
              "关联需有清晰逻辑链条, 勿牵强附会; 标的须为真实 A 股上市公司; " +
              "若帖子与 A 股无明显关联则写「暂无明确 A 股映射」并简要说明原因\n\n" +
              "注意: 只做信息延伸与逻辑分析, 不做买卖建议; a_shares 末尾单独一行写「⚠️ 仅供参考, 不构成投资建议」\n" +
              "只输出 JSON, 不要 markdown 代码块。",
          },
          { role: "user", content: userContent },
        ],
      }),
      signal: controller.signal,
    });

    const data = await resp.json();
    if (!resp.ok) {
      const err = data.error?.message || resp.statusText;
      throw new Error(`DeepSeek ${resp.status}: ${err}`);
    }

    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("DeepSeek 返回空内容");

    const parsed = JSON.parse(raw);
    return {
      translation: String(parsed.translation || "").trim(),
      summary: String(parsed.summary || "").trim(),
      aShares: String(parsed.a_shares || parsed.aShares || "").trim(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildText(entry, ai) {
  const title  = stripTags(entry.title);
  const body   = stripTags(entry.content || entry.description || entry.title) || "(无文本)";
  const link   = entry.url || entry.guid || "";
  const author = entry.author || "unknown";
  const when   = toBeijing(entry.publishedAt);

  const mediaList = Array.isArray(entry.media) ? entry.media : [];
  const mediaUrls = mediaList
    .map((m) => (typeof m === "string" ? m : (m && (m.url || m.preview_image_url))))
    .filter(Boolean);

  const lines = [`📢 @${author} 发新帖了`];
  if (when) lines.push(`🕒 ${when}`);
  if (title) lines.push("", `📌 ${title}`);
  lines.push("", "—— 原文 ——", body);

  if (ai?.translation) {
    lines.push("", "—— 中文翻译 ——", ai.translation);
  }
  if (ai?.summary) {
    lines.push("", "—— 要点解读 ——", ai.summary);
  }
  if (ai?.aShares) {
    lines.push("", "—— A 股映射 ——", ai.aShares);
  }

  if (mediaUrls.length) lines.push("", `🖼 媒体: ${mediaUrls.join("  ")}`);
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
  if (!LARK_WEBHOOK) {
    throw new Error("LARK_WEBHOOK 未配置");
  }
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
    try {
      const entry = payload.entry || {};
      const title = stripTags(entry.title);
      const body  = stripTags(entry.content || entry.description || entry.title);

      let ai = null;
      if (DEEPSEEK_API_KEY && body) {
        try {
          ai = await processWithDeepSeek(title, body);
          console.log("DeepSeek 完成:", entry.url || entry.guid || "(无链接)");
        } catch (e) {
          console.error("DeepSeek 失败, 仍转发原文:", e.message || e);
        }
      }

      const result = await forwardToLark(buildText(entry, ai));
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body);
    } catch (e) {
      console.error("转发失败:", e);
      res.writeHead(502).end("forward failed");
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`folo-to-lark listening on :${PORT}`);
  console.log(`Lark: ${LARK_WEBHOOK ? "configured" : "MISSING — set LARK_WEBHOOK"}`);
  console.log(`DeepSeek: ${DEEPSEEK_API_KEY ? `enabled (${DEEPSEEK_MODEL})` : "disabled — set DEEPSEEK_API_KEY"}`);
});

// Railway 重新部署时会发 SIGTERM 停旧容器, npm 会误报 error, 属正常现象
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
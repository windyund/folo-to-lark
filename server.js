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

// 飞书自定义机器人签名:key = `${timestamp}\n${secret}`,对空串做 HMAC-SHA256,再 base64
function larkSign(timestamp) {
  const stringToSign = `${timestamp}\n${LARK_SECRET}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

function buildCard(entry) {
  const text   = stripTags(entry.title || entry.description || entry.content) || "(无文本)";
  const link   = entry.url || entry.guid || "";
  const author = entry.author || "aleabitoreddit";
  const when   = entry.publishedAt || "";

  const card = {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: "blue",
        title: { tag: "plain_text", content: `@${author} 发新帖了` },
      },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: text } },
        { tag: "note", elements: [{ tag: "plain_text", content: String(when) }] },
      ],
    },
  };
  if (link) {
    card.card.elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: { tag: "plain_text", content: "在 X 上查看" },
        url: link,
        type: "primary",
      }],
    });
  }
  if (LARK_SECRET) {
    const ts = Math.floor(Date.now() / 1000);
    card.timestamp = String(ts);
    card.sign = larkSign(ts);
  }
  return card;
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
    try {
      const result = await forwardToLark(buildCard(payload.entry || {}));
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
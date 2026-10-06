// 部署链路验收探针：node scripts/probe.mjs <ws-url>
// 例：node scripts/probe.mjs ws://127.0.0.1:8787/ws/lobby?name=A
//     node scripts/probe.mjs "wss://你的域名/ws/lobby?name=A"
// 开两个连到同一房间的客户端，验证 hello / 广播 echo / 自动心跳 pong / leave 播报，全过 exit 0。
const url = process.argv[2];
if (!url) {
  console.error("用法：node scripts/probe.mjs <ws-url>（URL 里带 ?name= 就是昵称）");
  process.exit(2);
}

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? passed++ : failed++;
}

function connect(name) {
  const ws = new WebSocket(url);
  ws.name = name;
  ws.inbox = [];
  ws.addEventListener("message", (ev) => {
    if (ev.data === "pong") { ws.gotPong = true; return; }
    try { ws.inbox.push(JSON.parse(ev.data)); } catch { ws.inbox.push({ type: "?", raw: ev.data }); }
  });
  ws.addEventListener("close", () => { ws.closed = true; });
  return ws;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error("等不到 " + what);
}

let a, b;
try {
  a = connect("甲");
  await waitFor(() => a.inbox.some((m) => m.type === "hello"), 5000, "hello");
  const hello = a.inbox.find((m) => m.type === "hello");
  check("hello（含房间名与人数）", hello.room && hello.clients === 1, JSON.stringify(hello));

  b = connect("乙");
  await waitFor(() => b.inbox.some((m) => m.type === "hello"), 5000, "乙的 hello");
  const joinToB = b.inbox.find((m) => m.type === "presence" && m.kind === "join" && m.from === "甲");
  check("后来者收到先来者的 join 播报", !!joinToB);

  a.send(JSON.stringify({ type: "chat", turn: 0, text: "echo测试" }));
  const echoSelf = await waitFor(() => a.inbox.find((m) => m.type === "chat" && m.self), 5000, "甲的回声");
  check("echo 自收（self=true）", echoSelf.text === "echo测试", JSON.stringify(echoSelf));
  const echoOther = await waitFor(() => b.inbox.find((m) => m.type === "chat" && !m.self && m.from === "甲"), 5000, "乙收到广播");
  check("同房间他人收到广播", echoOther.text === "echo测试");

  a.send("ping");
  await waitFor(() => a.gotPong, 5000, "pong");
  check("自动心跳 ping→pong（不唤醒 DO）", true);

  a.close();
  const leave = await waitFor(() => b.inbox.find((m) => m.type === "presence" && m.kind === "leave" && m.from === "甲"), 5000, "leave 播报");
  check("断开后他人收到 leave 播报", leave.clients === 1, JSON.stringify(leave));
} catch (e) {
  check("流程中断", false, e.message);
} finally {
  try { a?.close(); } catch {}
  try { b?.close(); } catch {}
  await sleep(200);
}

console.log(`\n${passed} 通过 / ${failed} 失败 @ ${url}`);
process.exit(failed ? 1 : 0);

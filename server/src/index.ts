import { ROOM_CODE_LEN } from "../../shared/protocol";

export { Room } from "./room";

export interface Env {
  ROOM: DurableObjectNamespace;
}

// 房间码字母表：剔除易混淆的 I/L/O/0/1，念出来、手输都不歧义
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// 取模偏差修正：248 = 31 × 8，先拒绝采样到 0..247 再取模，字符表完全均匀
function genCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LEN; i++) code += CODE_ALPHABET[unbiasedByte() % CODE_ALPHABET.length];
  return code;
}

function unbiasedByte(): number {
  const bytes = new Uint8Array(1);
  do {
    crypto.getRandomValues(bytes);
  } while (bytes[0]! >= 248);
  return bytes[0]!;
}

/** 把 HTTP 面转发给对应 Room DO（DO 内只认 /init、/join、WS 升级三种入口） */
function forward(env: Env, code: string, path: string, body: unknown): Promise<Response> {
  const stub = env.ROOM.get(env.ROOM.idFromName(code));
  return stub.fetch(new Request(`https://room${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, now: Date.now() });
    }

    // 创建房间：生成随机码 → DO /init（已有账=码撞，换码重试）
    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const body = await request.json().catch(() => null);
      for (let attempt = 0; attempt < 5; attempt++) {
        const resp = await forward(env, genCode(), "/init", body);
        if (resp.status !== 409) return resp;
      }
      return Response.json({ error: "创建失败，请重试" }, { status: 500 });
    }

    // 加入房间（不存在/已满在 DO 内判，原样透传状态码）
    const join = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/join$/);
    if (join && request.method === "POST") {
      const body = await request.json().catch(() => null);
      return forward(env, join[1], "/join", body);
    }

    // WS 升级：token 在 query 上，认证在 DO 内、升级前完成（不验不上线）
    const ws = url.pathname.match(/^\/ws\/([A-Za-z0-9_-]{1,64})$/);
    if (ws) {
      if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
        return new Response("只有 WebSocket 升级请求走这里", { status: 426 });
      }
      return env.ROOM.get(env.ROOM.idFromName(ws[1])).fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

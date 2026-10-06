export { Room } from "./room";

export interface Env {
  ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, now: Date.now() });
    }
    const room = url.pathname.match(/^\/ws\/([A-Za-z0-9_-]{1,64})$/);
    if (room) {
      if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
        return new Response("只有 WebSocket 升级请求走这里", { status: 426 });
      }
      return env.ROOM.get(env.ROOM.idFromName(room[1])).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

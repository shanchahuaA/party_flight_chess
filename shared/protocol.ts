// WS 协议唯一真源（见 docs/脚手架约定.md）：client 与 server 共同导入，禁止各自手写消息类型。
// hello-world 阶段只有连接探针消息；游戏消息按 ADR-0001 的「上行=意图 / 下行=事实」原则在此扩展。
// 传输层心跳不走这里：DO 用 setWebSocketAutoResponse("ping"→"pong") 原样应答，不唤醒进程。

/** 客户端 → 服务端 */
export type Upstream =
  | { type: "chat"; turn: number; text: string };

/** 服务端 → 客户端 */
export type Downstream =
  | { type: "hello"; room: string; clients: number; now: number }
  | { type: "chat"; from: string; self: boolean; turn: number | null; text: string; now: number }
  | { type: "presence"; kind: "join" | "leave"; from: string; clients: number; now: number };

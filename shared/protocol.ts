// WS 协议唯一真源（见 docs/脚手架约定.md）：client 与 server 共同导入，禁止各自手写消息类型。
// M2-T3（#40）起为房间生命周期协议：上行只有房间动作（T5 起扩展对局意图），下行只有房间快照与通知。
// 传输层心跳不走这里：DO 用 setWebSocketAutoResponse("ping"→"pong") 原样应答，不唤醒进程。

/** 房间容量（8 人局，kernel 出生槽池同口径） */
export const MAX_SEATS = 8;
/** 昵称上限（两端口径一致；server 侧再截一道防直连） */
export const NICK_MAX = 12;
/** 房间码长度（易混淆字符已从字母表剔除，字母表住 server 入口） */
export const ROOM_CODE_LEN = 5;

/** 客户端 → 服务端（房间面；T5 起在此扩展对局意图，一律带 turn）。
 *  turn 豁免：房间生命周期消息（leave/dissolve）不带 turn——对局未开、无「过期操作」可言，
 *  动作合法性由 DO 按房间账即时校验（座位在不在/是不是房主），等效于 turn 的防过期职责。 */
export type Upstream =
  | { type: "leave" } // 主动离房：座位即刻释放、token 作废（断线≠离房——只关 WS 座位保留，可凭 token 归队）
  | { type: "dissolve" }; // 房主解散：全员请出、房间销毁

/** 座位的公开视图（座位互见：昵称/在线/房主标记；token 绝不下发） */
export interface RoomSeatView {
  seat: number;
  name: string;
  online: boolean;
  host: boolean;
}

/** 房间快照（连接建立与每次变更都推全量——胖消息口径，客户端整体覆盖零合并） */
export interface RoomSnapshot {
  code: string;
  /** 房主座位号（转移逻辑 T8 落；本票=创建者持标记，房主离房转给最早加入者） */
  hostSeat: number;
  phase: "lobby"; // T4 扩展 configured/playing 等
  seats: RoomSeatView[];
}

/** 服务端 → 客户端 */
export type Downstream =
  | { type: "room"; room: RoomSnapshot; you: number | null; now: number } // you=自己的座位号（null=观战/未落座，本票恒有座位）
  | { type: "replaced" } // 同 token 新连接顶掉旧连（双开防漂移）：旧连接收到即失效，以最新连接为准
  | { type: "dissolved" } // 房主解散/房间销毁：全员收到后回首页
  | { type: "error"; message: string }; // 上行动作被拒（非房主解散等）；轻提示用，快照随后强制对齐

/** POST /api/rooms 响应：创建即入座（创建者=房主=座位 0），token 客户端落 localStorage */
export interface CreateRoomResp {
  code: string;
  token: string;
  seat: number;
}

/** POST /api/rooms/:code/join 响应 */
export interface JoinRoomResp {
  token: string;
  seat: number;
}

/** HTTP API 错误响应体（400 昵称非法 / 404 房间不存在或已解散 / 409 已满·码撞） */
export interface ApiError {
  error: string;
}

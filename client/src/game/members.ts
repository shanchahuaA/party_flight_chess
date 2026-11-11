/**
 * 成员管理派生（M3-T6，#58 / G-07）：`(座位列, mySeat, hostSeat) → 成员行`。
 *
 * **谁能被请出**只有这一处真源，⚙ 成员管理节与大厅 🥾 同吃：
 *    - 非房主 → 整表 `canKick=false`（成员管理节本来也不显示，双保险不给越权按钮）；
 *    - 假人 → `canKick=false`（假人没有身份可拉黑，服务端也直接拒：GLOSSARY「踢人」）；
 *    - 自己 → `canKick=false`（服务端同样拒「不能踢自己」）；
 *    - 离线真人 → **可请出**（房主对掉线赖座者的处置面就是这个）。
 *
 * 确认浮层的状态机不在这里，住 `game/confirm.ts`（请出与解散共用同一套）。
 * 服务端任何 phase 都已受理 `kick`（协议零改动）；本模块只管「按钮与成员行」这一层。
 */
import type { RoomSeatView } from "../../../shared/protocol";

/** 派生所需的座位最小面（RoomSeatView 的结构子集——测试可直接造） */
export interface SeatLike {
  seat: number;
  name: string;
  online: boolean;
  bot: boolean;
  host: boolean;
}

/** 成员行：渲染层只照这个画，不再自己算任何判据 */
export interface MemberRow {
  seat: number;
  name: string;
  online: boolean;
  bot: boolean;
  /** 是我自己（行内标「（你）」且不给请出钮） */
  me: boolean;
  /** 房主标记（皇冠） */
  host: boolean;
  /** 是否出「请出」钮——本文件的唯一判据 */
  canKick: boolean;
}

export interface MemberView {
  seats: readonly SeatLike[];
  /** 我的座位号（`roomStore.mySeat`）；null=未落座/快照未到 */
  mySeat: number | null;
  /** 房主座位号（`snapshot.hostSeat`）；null=快照未到（调用方 `snapshot?.hostSeat ?? null`） */
  hostSeat: number | null;
}

/**
 * 我是不是房主（**唯一判据**：⚙ 面板、大厅、成员管理都吃这一份）。
 *
 * 两个入参都可为 null，但来源不同：
 * - `hostSeat`：协议里 `RoomSnapshot.hostSeat` 是**非空 `number`**（`shared/protocol.ts`），
 *   为 null 的唯一原因是**快照整体还没到**（`roomStore.snapshot` 是 `RoomSnapshot | null`）；
 * - `mySeat`：`roomStore.mySeat` 本身是 `number | null`（未落座/未连接）。
 *
 * 所以这里判「双方都已定且相等」——防的是「快照没到、我也还没落座」时 `null === null`
 * 蒙成房主（不是防 `hostSeat` 自己为 null 的协议态）。
 */
export function iAmHost(mySeat: number | null, hostSeat: number | null): boolean {
  return mySeat != null && hostSeat != null && mySeat === hostSeat;
}

/** 座位列 → 成员行（按座位号升序：与大厅座位列同序，快照乱序也不抖）。 */
export function memberRows(v: MemberView): MemberRow[] {
  const host = iAmHost(v.mySeat, v.hostSeat);
  return [...v.seats]
    .sort((a, b) => a.seat - b.seat)
    .map((s) => {
      const me = s.seat === v.mySeat;
      return {
        seat: s.seat,
        name: s.name,
        online: s.online,
        bot: s.bot,
        me,
        host: s.seat === v.hostSeat,
        canKick: host && !s.bot && !me,
      };
    });
}

/** 把 RoomSnapshot.seats（RoomSeatView[]）收窄成派生输入面（类型桥，零逻辑） */
export function seatsOf(seats: readonly RoomSeatView[]): SeatLike[] {
  return seats.map((s) => ({
    seat: s.seat,
    name: s.name,
    online: s.online,
    bot: s.bot,
    host: s.host,
  }));
}

<script setup lang="ts">
/**
 * 满屏棋盘 SVG（渲染层）：
 * - 静态层数据全取内核 BOARD（100 格路网/生态三区/街名/内园占位/支路投影），本组件不持规则。
 * - 棋子位置读内核玩家态；逐格动画 = CSS transform 过渡（内核 140ms 节拍的事实驱动）。
 */
import { computed } from "vue";
import { BOARD, BOARD_H, BOARD_W, STREET_TAGS, YARDS, branchTails, cellXY, type PlayerState } from "../../../kernel/src";
import { gameStore } from "../game/store";

const state = computed(() => {
  return gameStore.state.value;
});

const ZONE_FILL: Record<string, string> = {
  plain: "#38553f",
  snow: "#45688c",
  gobi: "#775e34",
};
const TYPE_ICON: Record<string, string> = { E: "🃏", I: "🎁", T: "⚠️" };
const TOKEN_COLORS = ["#e53935", "#f9a825", "#43a047", "#1e88e5", "#8e24aa", "#f4511e", "#d81b60", "#00897b"];

const TOK_OFFS: Array<readonly [number, number]> = [
  [-4, -4],
  [4, -4],
  [-4, 4],
  [4, 4],
];

// ---------- 静态层（建一次即可） ----------
const edges: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
for (const n of BOARD) {
  for (const l of n.links) {
    if (l < n.id) continue;
    const b = BOARD[l]!;
    edges.push({ x1: n.x, y1: n.y, x2: b.x, y2: b.y });
  }
}
const arrowCells = BOARD.filter((n, i) => n.street !== "J" && n.spawnIndex < 0 && i % 9 === 4).map((n) => {
  const next = n.links.map((id) => BOARD[id]!).find((m) => m.street === n.street) ?? BOARD[n.links[0]!]!;
  return { x: n.x, y: n.y, ang: (Math.atan2(next.y - n.y, next.x - n.x) * 180) / Math.PI };
});
// 街名路牌与内园地皮占位：真源在内核 board.ts（#17 review：渲染端不再手工拷贝）
const streetTags = STREET_TAGS.map(([name, c, r, ox, oy]) => ({ name, p: cellXY(c, r), ox, oy }));
const yards = YARDS.map((y) => {
  const c = cellXY(y.col, y.row);
  return { icon: y.icon ?? null, name: y.name ?? null, left: c.x - 10, top: c.y - 10, pw: y.w * 22, ph: y.h * 22 };
});

// ---------- 动态层 ----------
function tokenPoint(p: PlayerState): { x: number; y: number } {
  if (p.zone === "main") {
    const c = BOARD[p.pos]!;
    const o = TOK_OFFS[p.id % TOK_OFFS.length]!;
    return { x: c.x + o[0], y: c.y + o[1] };
  }
  const tail = branchTails[BOARD[p.spawnCell]!.spawnIndex]!;
  if (p.zone === "done") return { x: tail.flag.x, y: tail.flag.y };
  if (p.bpos <= 0) {
    // 支路门口 = 出生格本体
    const c = BOARD[p.spawnCell]!;
    const o = TOK_OFFS[p.id % TOK_OFFS.length]!;
    return { x: c.x + o[0], y: c.y + o[1] };
  }
  const bpos = Math.min(4, p.bpos);
  return tail.cells[bpos - 1]!;
}

const tokenViews = computed(() =>
  (state.value?.players ?? []).map((p) => {
    const pt = tokenPoint(p);
    return { p, x: pt.x, y: pt.y };
  }),
);

// ---------- 出生位归属（T2 起按人数落座）：家环/门前小路只画本局出生位 ----------
const ownerBySpawnCell = computed(() => {
  const map = new Map<number, number>();
  for (const p of state.value?.players ?? []) map.set(p.spawnCell, p.id);
  return map;
});

/** 本局各家的屋前小路（按出生格所属槽取支路投影，染玩家色） */
const activeTails = computed(() =>
  (state.value?.players ?? []).map((p) => ({
    tail: branchTails[BOARD[p.spawnCell]!.spawnIndex]!,
    color: TOKEN_COLORS[p.id % TOKEN_COLORS.length]!,
  })),
);

const ownerOfSpawn = (cellId: number): number | null => ownerBySpawnCell.value.get(cellId) ?? null;
/** 本格出生位的玩家色（无人落座 → null） */
const spawnOwnerColor = (cellId: number): string | null => {
  const o = ownerOfSpawn(cellId);
  return o === null ? null : TOKEN_COLORS[o % TOKEN_COLORS.length]!;
};
</script>

<template>
  <svg
    class="board"
    :viewBox="`0 0 ${BOARD_W} ${BOARD_H}`"
    preserveAspectRatio="xMidYMid meet"
    aria-label="庄园路网棋盘"
  >
    <defs>
      <radialGradient id="manorGrad" cx="50%" cy="42%" r="75%">
        <stop offset="0%" stop-color="#2e4053" />
        <stop offset="55%" stop-color="#25333f" />
        <stop offset="100%" stop-color="#1d2833" />
      </radialGradient>
    </defs>
    <rect :width="BOARD_W" :height="BOARD_H" rx="12" fill="url(#manorGrad)" />

    <!-- 内园地皮占位（本票只渲染不触发） -->
    <g v-for="(y, i) in yards" :key="`yard${i}`">
      <rect
        :x="y.left"
        :y="y.top"
        :width="y.pw"
        :height="y.ph"
        rx="8"
        fill="rgba(207,216,220,.09)"
        stroke="rgba(144,164,174,.4)"
        stroke-width="1"
        stroke-dasharray="5 4"
      />
      <text :x="y.left + y.pw / 2" :y="y.top + y.ph / 2 + 5" text-anchor="middle" font-size="17" opacity="0.9">{{ y.icon }}</text>
      <text
        v-if="y.name"
        :x="y.left + y.pw / 2"
        :y="y.top + y.ph / 2 + 21"
        text-anchor="middle"
        font-size="8.5"
        fill="#b0bec5"
      >{{ y.name }}</text>
    </g>

    <!-- 街缘石线 -->
    <line
      v-for="(e, i) in edges"
      :key="`e${i}`"
      :x1="e.x1"
      :y1="e.y1"
      :x2="e.x2"
      :y2="e.y2"
      stroke="#546e7a"
      stroke-width="23"
      stroke-linecap="round"
    />

    <!-- 方砖：生态区配色 + 类型角标；环岛=大圆盘 ✛；出生格=玩家色环「家」 -->
    <g v-for="n in BOARD" :key="`c${n.id}`">
      <template v-if="n.type === 'J'">
        <circle :cx="n.x" :cy="n.y" r="12.5" fill="#eceff1" stroke="#607d8b" stroke-width="2" />
        <text :x="n.x" :y="n.y + 4" text-anchor="middle" font-size="10" font-weight="800" fill="#546e7a">✛</text>
      </template>
      <template v-else>
        <rect
          :x="n.x - 10"
          :y="n.y - 10"
          width="20"
          height="20"
          rx="5.5"
          :fill="ZONE_FILL[n.zone]"
          stroke="#78909c"
          stroke-width="0.8"
        />
        <text v-if="TYPE_ICON[n.type]" :x="n.x" :y="n.y + 4" text-anchor="middle" font-size="10.5">{{ TYPE_ICON[n.type] }}</text>
        <!-- 出生位家环：只画本局落座的家（玩家色）；未落座槽不留户牌 -->
        <template v-if="spawnOwnerColor(n.id)">
          <circle :cx="n.x" :cy="n.y" r="8.5" fill="none" :stroke="spawnOwnerColor(n.id)!" stroke-width="2" />
          <text
            :x="n.x"
            :y="n.y + 3.5"
            text-anchor="middle"
            font-size="8"
            font-weight="900"
            :fill="spawnOwnerColor(n.id)!"
          >家</text>
        </template>
      </template>
    </g>

    <!-- 街名路牌 -->
    <text
      v-for="(t, i) in streetTags"
      :key="`tag${i}`"
      :x="t.p.x + t.ox"
      :y="t.p.y + t.oy + 3"
      text-anchor="middle"
      font-size="8"
      fill="#b0bec5"
    >{{ t.name }}</text>

    <!-- 行进箭头（氛围） -->
    <text
      v-for="(a, i) in arrowCells"
      :key="`ar${i}`"
      :x="a.x"
      :y="a.y + 3"
      text-anchor="middle"
      font-size="7"
      fill="rgba(176,190,197,.55)"
      :transform="`rotate(${a.ang.toFixed(1)}, ${a.x}, ${a.y})`"
    >▶</text>

    <!-- 屋前小路 + 终点旗：只画本局落座出生位（玩家色；T2 起按人数落座） -->
    <g v-for="(t, qi) in activeTails" :key="`tail${qi}`">
      <rect
        v-for="(c, ci) in t.tail.cells"
        :key="`t${qi}-${ci}`"
        :x="c.x - 8.5"
        :y="c.y - 8.5"
        width="17"
        height="17"
        rx="5"
        fill="#fff"
        :stroke="t.color"
        stroke-width="1.3"
        stroke-dasharray="2.5 2"
        opacity="0.92"
      />
      <text :x="t.tail.flag.x" :y="t.tail.flag.y + 5" text-anchor="middle" font-size="14">🏁</text>
    </g>

    <!-- 棋子 -->
    <g
      v-for="tv in tokenViews"
      :key="`tk${tv.p.id}`"
      class="tk"
      :class="{ glow: gameStore.isLit(tv.p.id) !== null }"
      :style="{ transform: `translate(${tv.x}px, ${tv.y}px)` }"
    >
      <circle v-if="tv.p.id === 0" r="11" fill="none" stroke="#90cbd8" stroke-width="1.5" stroke-dasharray="3 2.5" />
      <circle class="tkMain" r="8.5" :fill="TOKEN_COLORS[tv.p.id]" stroke="#fff" stroke-width="2" />
      <text class="tokenLbl" y="3.2" text-anchor="middle" font-size="9">
        {{ tv.p.id === 0 ? "你" : tv.p.name.replace("小", "") }}
      </text>
    </g>
  </svg>
</template>

<style scoped>
.board {
  width: 100%;
  height: 100%;
  display: block;
}
.board text {
  user-select: none;
}
.tk {
  transition: transform 0.13s linear;
}
.tk.glow .tkMain {
  animation: tkGlow 0.55s ease-in-out 2;
  stroke: #ffd54f;
}
@keyframes tkGlow {
  0%,
  100% {
    stroke-width: 2;
  }
  50% {
    stroke-width: 6;
  }
}
.tokenLbl {
  font-size: 9px;
  font-weight: 800;
  fill: #fff;
  pointer-events: none;
}
</style>

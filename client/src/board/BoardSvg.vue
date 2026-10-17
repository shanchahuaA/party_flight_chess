<script setup lang="ts">
/**
 * 满屏棋盘 SVG（渲染层）：
 * - 静态层数据全取内核 BOARD（100 格路网/生态三区/街名/内园占位/支路投影），本组件不持规则。
 * - 棋子位置读内核玩家态；逐格动画 = CSS transform 过渡（内核 140ms 节拍的事实驱动）。
 * - 世界恶意演出（#24 T6a）：木头预警阴影/塌陷区凹皮/滚石路径描边全从 state.malice 投影，
 *   三级联动复用「格背景 + 角标 + title」同一张画皮（描边呼吸/残迹压暗皆 CSS 类）。
 */
import { computed } from "vue";
import {
  BOARD,
  BOARD_H,
  BOARD_W,
  ITEM_CARD_BY_ID,
  STREET_TAGS,
  YARDS,
  branchTails,
  cellXY,
  itemLegalTargets,
  type PlayerState,
} from "../../../kernel/src";
import { gameStore } from "../game/store";
import { HP_TONE_COLOR, hpRatio, hpTone } from "../game/hp";

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

// ---------- 血条（#23 T5a，数值表 §5.3 常驻呈现）：自己=❤数字+微条；他人=微型血条 ----------
// 档位与色取共用件 game/hp（HUD pill 同吃一份）——本格只管几何与读数
const maxHp = computed(() => gameStore.kernel.value?.config.maxHp ?? 10);
const hpBarW = (p: PlayerState): string => (16 * hpRatio(p.hp, maxHp.value)).toFixed(2);
const hpFill = (p: PlayerState): string => HP_TONE_COLOR[hpTone(hpRatio(p.hp, maxHp.value))];

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

// ---------- 目标选择（T4a2 chooseOther）：合法亮/非法灰，点头像收口 ----------
/** targeting 中的合法目标集合（null=未在选择）；口径=内核 itemLegalTargets 单一份 */
const legalSet = computed<Set<number> | null>(() => {
  const cardId = gameStore.targeting.value;
  if (!cardId || !state.value) return null;
  return new Set(itemLegalTargets(state.value, 0, cardId));
});
function tokenClass(id: number): string {
  const p = state.value?.players[id];
  if (p?.dead) return "dead"; // 淘汰者（T5c）：不做 targeting 演出，变暗观战贴皮单走一份
  const s = legalSet.value;
  if (!s) return "";
  return s.has(id) ? "tg legal" : "tg dim";
}
/** 选中目标提交到内核：非法目标也照发（内核拒并播理由 toast，选择态保留可供换点） */
function onTokenClick(id: number): void {
  if (legalSet.value) gameStore.pickTarget(id);
}

// ---------- 场地型附着的角标（T4a ground）：踩上触发即消失；<title> 带归因提示 ----------
// 图标映射=壳层呈现皮：本批 2 张场地卡（数值表 T4b 落数后在此补行）；兜底改警示符不静默
const GROUND_ICON: Record<string, string> = { i03: "🍌", i17: "💣" };
const groundViews = computed(() => {
  const perCell = new Map<number, number>();
  return (state.value?.ground ?? []).map((g) => {
    // 同格多张横向错开一格径，免得叠死
    const n = perCell.get(g.cell) ?? 0;
    perCell.set(g.cell, n + 1);
    const c = BOARD[g.cell]!;
    const card = ITEM_CARD_BY_ID.get(g.cardId);
    const owner = state.value!.players[g.owner];
    return {
      x: c.x - 7.5 - n * 10,
      y: c.y - 7.5,
      icon: GROUND_ICON[g.cardId] ?? "⚠",
      title: `${card?.title ?? g.cardId} · ${g.owner === 0 ? "你" : (owner?.name ?? "?")} 布的`,
    };
  });
});

// ---------- 世界恶意演出（#24 T6a，数值表 §5.5）：state.malice 投影三级联动 ----------
// 木头=预警阴影（呼吸红晕+🪵 悬牌，下一世界回合砸落；到期清理即消失）；
// 塌陷=凹色底+🕳 角标（存续 2 世界回合，left 带进 title）；滚石=路径描边流动+🪨 石标（残迹回放两拍后静止）。
const malice = computed(() => state.value?.malice ?? { timber: null, sink: null, rock: null });
const timberViews = computed(() => (malice.value.timber ?? []).map((id) => BOARD[id]!));
const sinkViews = computed(() => (malice.value.sink?.cells ?? []).map((id) => BOARD[id]!));
const sinkLeft = computed(() => malice.value.sink?.left ?? 0);
const rockViews = computed(() => (malice.value.rock ?? []).map((id) => BOARD[id]!));
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

    <!-- 世界恶意 · 塌陷区图皮（#24 T6a）：凹色底+🕳 角标，踩进扣血；title 带剩余存续回合 -->
    <g v-for="(c, i) in sinkViews" :key="`sk${i}`" class="maliceSink">
      <rect :x="c.x - 10" :y="c.y - 10" width="20" height="20" rx="5.5" fill="rgba(8,10,8,.5)" stroke="#4e342e" stroke-width="1.2" stroke-dasharray="2.5 2" />
      <text :x="c.x" :y="c.y + 4" text-anchor="middle" font-size="9.5">🕳️</text>
      <title>🕳 塌陷区——踩进要扣血；还剩 {{ sinkLeft }} 个世界回合复原</title>
    </g>

    <!-- 世界恶意 · 木头预警阴影（#24 T6a）：呼吸红晕+🪵 悬牌——下一世界回合开始砸落，速离此格 -->
    <g v-for="(c, i) in timberViews" :key="`tw${i}`" class="maliceTimber">
      <rect :x="c.x - 10.5" :y="c.y - 10.5" width="21" height="21" rx="6" fill="rgba(239,83,80,.26)" stroke="#ef5350" stroke-width="1.5" class="warnPulse" />
      <text :x="c.x" :y="c.y - 12" text-anchor="middle" font-size="8.5">🪵</text>
      <title>🪵 大木头预警阴影——下一世界回合开始砸落，正在格上的人速离</title>
    </g>

    <!-- 世界恶意 · 滚石路径残迹（#24 T6a）：虚线描边流动两拍回放滚过路段，终点扛 🪨 石标 -->
    <g v-for="(c, i) in rockViews" :key="`rk${i}`" class="maliceRock">
      <rect :x="c.x - 10" :y="c.y - 10" width="20" height="20" rx="5.5" fill="none" stroke="#ffcc80" stroke-width="1.2" stroke-dasharray="3 2.5" class="rockFlow" />
      <template v-if="i === rockViews.length - 1">
        <text :x="c.x" :y="c.y - 12" text-anchor="middle" font-size="9">🪨</text>
      </template>
      <title>🪨 滚石刚滚过的路段（10 格，被追上者已判定）</title>
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

    <!-- 棋子（targeting 期：合法亮/非法灰，点头像收口；淘汰者变暗+☠锁标观战） -->
    <g
      v-for="tv in tokenViews"
      :key="`tk${tv.p.id}`"
      class="tk"
      :class="[tokenClass(tv.p.id), { glow: gameStore.isLit(tv.p.id) !== null }]"
      :style="{ transform: `translate(${tv.x}px, ${tv.y}px)` }"
      @click="onTokenClick(tv.p.id)"
    >
      <title v-if="tv.p.dead">☠ {{ tv.p.id === 0 ? "你已" : `${tv.p.name}已` }}出局——观战中（不再被指认）</title>
      <circle v-if="tv.p.id === 0" r="11" fill="none" stroke="#90cbd8" stroke-width="1.5" stroke-dasharray="3 2.5" />
      <circle class="tkMain" r="8.5" :fill="TOKEN_COLORS[tv.p.id]" stroke="#fff" stroke-width="2" />
      <text class="tokenLbl" y="3.2" text-anchor="middle" font-size="9">
        {{ tv.p.id === 0 ? "你" : tv.p.name.replace("小", "") }}
      </text>
      <!-- 血条（T5a 常驻）：底槽＋按血量占比的填充；自己头顶再加深 ❤ 读数；淘汰者头顶换成 ☠ 锁标 -->
      <g class="hpG">
        <rect x="-8" y="13" width="16" height="3" rx="1.5" fill="rgba(0,0,0,.5)" />
        <rect x="-8" y="13" :width="hpBarW(tv.p)" height="3" rx="1.5" :fill="hpFill(tv.p)" />
        <text v-if="tv.p.dead" x="0" y="-12.5" text-anchor="middle" class="hpNum hpDead" font-size="8">☠</text>
        <text v-else-if="tv.p.id === 0" x="0" y="-12.5" text-anchor="middle" class="hpNum" font-size="8">❤{{ tv.p.hp }}</text>
      </g>
    </g>

    <!-- 场地型角标：附着格右上角画皮（踩上触发即消失；同格多张横向错开） -->
    <g v-for="(g, i) in groundViews" :key="`gm${i}`" class="gm">
      <title>{{ g.title }}</title>
      <circle :cx="g.x" :cy="g.y" r="6.2" fill="#fffde7" stroke="#ff8f00" stroke-width="1.5" />
      <text :x="g.x" :y="g.y + 2.4" text-anchor="middle" font-size="6.4">{{ g.icon }}</text>
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
/* 血条（T5a）：全组不持行为——呈现件不抢棋子的点击（title 提示随之失效，读数在 HUD 与 ❤ 数字兜底） */
.hpG {
  pointer-events: none;
}
.hpNum {
  font-weight: 800;
  fill: #ffe082;
  stroke: #263238;
  stroke-width: 2;
  paint-order: stroke fill;
}
/* 观战贴皮（T5c）：淘汰 token 整体变暗（头上有 ☠ 锁标——hover title 提示）；不再列进 targeting 演出 */
.tk.dead {
  filter: grayscale(1);
  opacity: 0.55;
}
.tk.dead .tokenLbl {
  fill: #b0bec5;
}
.hpNum.hpDead {
  fill: #e57373;
}
/* 世界恶意（#24 T6a）：木头预警阴影呼吸描边；滚石=虚线路径流动两拍回放（dashoffset 前爬一周期×2，之后静止）；
   塌陷凹皮静态。三类都只承载演出，不抢棋盘点击。 */
.maliceTimber .warnPulse {
  animation: warnBlink 0.9s ease-in-out infinite;
}
@keyframes warnBlink {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 1;
  }
}
.maliceRock .rockFlow {
  animation: rockCrawl 1.1s linear 2;
}
@keyframes rockCrawl {
  to {
    stroke-dashoffset: -11; /* 虚线周期 3+2.5≈5.5，爬两周期=滚过路的回放感，然后静止成残迹 */
  }
}
.maliceTimber,
.maliceRock title {
  pointer-events: auto;
}
/* targeting 期头像语义：合法可选（亮+呼吸圈）/非法置灰；非 targeting 无行为 */
.tk.tg.legal {
  cursor: pointer;
}
.tk.tg.legal .tkMain {
  stroke: #ffd54f;
  animation: tkCall 0.85s ease-in-out infinite;
}
@keyframes tkCall {
  0%,
  100% {
    stroke-width: 2.5;
  }
  50% {
    stroke-width: 6;
  }
}
.tk.tg.dim {
  opacity: 0.3;
  filter: grayscale(0.65);
}
.gm {
  pointer-events: auto;
}
</style>

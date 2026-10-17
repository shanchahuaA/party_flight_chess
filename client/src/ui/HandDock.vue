<script setup lang="ts">
/**
 * 手牌横滑 + 半屏抽屉大卡（#31 T4a2 + #22 T4b1）：dock 上方一排可横滑缩略小卡，点开抽屉看大卡/打牌。
 * 全部事实驱动：手牌读内核 hand；打牌钮按 itemPlayGate 口径出没——已确认/罚停轮空一律
 * 只给 reason 不出钮（入口隐藏），淘汰观战整条隐藏（界面呈现定案 §六），通关席见 playDirect 注。
 * chooseOther 两段式：抽屉「去棋盘点目标」→ store.targeting 进入选择，BoardSvg 头像收口
 * （打出成功由 itemPlayed 事实收账、内核拒保持待选）；self/auto 系统直打、ground 一步直打；
 * 占位卡（tbd；狗笛=T6b）照 chooseOther 两段式走，打出即晒牌。
 * 违禁卡带视觉标识（只落在本人手牌视图，M2 按玩家切片下发时保持本人视图）。
 */
import { computed, ref, watchEffect } from "vue";
import {
  AXIS_NAMES,
  DOG_HP,
  DOG_TURNS,
  ECO_NAMES,
  ITEM_CARD_BY_ID,
  itemPlayGate,
  type CheckSpec,
  type DiceMod,
  type EffectPart,
  type ItemCard,
  type ItemRoute,
  type PlayGate,
  type PlayerState,
  type GameState,
  type WeatherSpec,
} from "../../../kernel/src";
import { gameStore } from "../game/store";
import BaseSheet from "./BaseSheet.vue";

const state = computed<GameState | null>(() => gameStore.state.value);
const me = computed<PlayerState | null>(() => state.value?.players[0] ?? null);

type HandView = { id: string; card: ItemCard };
const handViews = computed<HandView[]>(() =>
  (me.value?.hand ?? []).flatMap((c) => {
    const card = ITEM_CARD_BY_ID.get(c);
    return card ? [{ id: c, card }] : [];
  }),
);
/** 打牌入口条件：淘汰观战整条隐藏（手牌对局已无意义）；终局收场。等待区/罚停只藏抽屉里的打牌钮 */
const stripOn = computed(() => !!me.value && !me.value.dead && state.value?.phase !== "over" && handViews.value.length > 0);

const targeting = computed(() => gameStore.targeting.value);
/** targeting 安全闸：事实变了（窗收口/卡离手/进等待区/罚停轮空）自动退场不留死锁——
 *  直接复用 itemPlayGate 单口径，规则改这里零漂移 */
watchEffect(() => {
  const c = gameStore.targeting.value;
  if (!c) return;
  const s = state.value;
  if (!s || !ITEM_CARD_BY_ID.get(c) || !itemPlayGate(s, 0, c).ok) gameStore.cancelTargeting();
});

// ---------- 抽屉（半屏大卡） ----------
const drawerCard = ref<string | null>(null);
const drawerItem = computed<ItemCard | null>(() => (drawerCard.value ? (ITEM_CARD_BY_ID.get(drawerCard.value) ?? null) : null));
const gate = computed<PlayGate | null>(() => (drawerCard.value ? itemPlayGate(state.value!, 0, drawerCard.value) : null));

function openDrawer(cardId: string): void {
  drawerCard.value = cardId;
}
function closeDrawer(): void {
  drawerCard.value = null;
}
/** 打牌入口的隐藏粒度：等待区/罚停轮空/淘汰不出手；通关席按一页纸「仍可打卡整蛊」与内核
 *  itemPlayGate 同口径——self/ground 两类入口隐藏（gate 拒），chooseOther/auto 两类整蛊卡保留出钮（口子不锁，T4b1 扩）。 */
function playDirect(): void {
  if (!drawerCard.value || !gate.value?.ok) return;
  gameStore.playItem(drawerCard.value);
  closeDrawer();
}
/** chooseOther 两段式第一步：关抽屉进 targeting，棋盘头像收口（BoardSvg） */
function goTargeting(): void {
  if (!drawerCard.value || !gate.value?.ok) return;
  gameStore.startTargeting(drawerCard.value);
  closeDrawer();
}

// ---------- 卡面文字（原语 DSL → 机械真话；文案皮留战报 flavor） ----------
const ROUTE_TXT: Record<ItemRoute, string> = {
  self: "自用",
  chooseOther: "指向他人",
  auto: "自动指认",
  ground: "场地 · 搁脚下",
  ambient: "全场环境",
};

function modText(mods: DiceMod[]): string {
  const segs = mods.map((m) => {
    const k = m.mode === "flat" ? `+${m.v}` : m.mode === "cut" ? `面 −${m.v}` : m.mode === "floor" ? `保底 ${m.v}` : `升面 +${m.v}`;
    const src = m.src ? `${m.src} ` : "";
    return `${src}${k}`;
  });
  return `下次掷骰 ${segs.join("、")}`;
}
function partText(p: EffectPart): string {
  switch (p.type) {
    case "move":
      return `前进 ${p.v} 格`;
    case "back":
      return `退 ${p.v} 格`;
    case "skip":
      return `罚停 ${p.v} 回合`;
    case "hp":
      return p.v > 0 ? `回 ${p.v} 血` : `扣 ${-p.v} 血`;
    case "drawItem":
      return `摸 ${p.v} 张道具`;
    case "rollMod":
      return modText(p.mods);
    case "check":
      return checkText(p.spec);
    case "reroll":
      return "重掷本次走格骰（须已在路上）";
    case "swap":
      return "与指定玩家互换位置（双双须在主干道）";
    case "talisman":
      return "免疫下一次任何伤害（触发即消耗）";
    case "roundShield":
      return "下一回合免疫他人卡牌效果";
    case "clearGround":
      return `清掉当前格起前方 ${p.v} 格内的香蕉皮/地雷`;
    case "dogSpawn":
      return `系统在指定玩家相邻格生成 1 只标准野狗（${DOG_HP} 血/${DOG_TURNS} 世界回合寿命；撞上=强制遭遇战）`;
    default:
      return "无效果";
  }
}
function checkText(spec: CheckSpec): string {
  const axis = spec.axis ? AXIS_NAMES[spec.axis] : "前途";
  const dc = spec.dc != null ? ` DC${spec.dc}` : "";
  const fail = spec.onFail?.length ? spec.onFail.map(partText).join("，") : "安全无事";
  const pass = spec.onPass?.length ? `；通过 ${spec.onPass.map(partText).join("，")}` : "；通过 安全无事";
  return `${axis}判定${dc}：失败 ${fail}${pass}`;
}
/** 环境卡三行地形表 → 机械投影（按所在生态分行；每行摊平到「判定/上账」真话） */
const ECO_ORDER = ["plain", "snow", "gobi"] as const;
function weatherText(w: WeatherSpec): string[] {
  const lines: string[] = [];
  if (w.strike) {
    lines.push(`每回合开始随机劈 1 人回退：${ECO_ORDER.map((e) => `${ECO_NAMES[e]} ${w.strike![e]}`).join("／")}`);
  }
  if (w.slip) {
    for (const e of ECO_ORDER) {
      const row = w.slip[e];
      if (!row) continue;
      const pct = `${Math.round((row.guard / row.faces) * 100)}% 摔倒`;
      const fx = row.onFall.map(partText).join("，");
      lines.push(`${ECO_NAMES[e]}：判定 d${row.faces}≤${row.guard}（${pct}）→ ${fx}`);
    }
  }
  if (w.wind) {
    for (const e of ECO_ORDER) {
      const row = w.wind[e];
      if (!row) continue;
      if (row.walkMod) {
        const m = row.walkMod;
        lines.push(`${ECO_NAMES[e]}：下次走格骰 ${m.src ? `${m.src} ` : ""}${m.v < 0 ? `−${-m.v}` : `+${m.v}`}`);
      }
      if (row.check) {
        const pct = `${Math.round((row.check.guard / row.check.faces) * 100)}% 摔倒`;
        lines.push(`${ECO_NAMES[e]}：判定 d${row.check.faces}≤${row.check.guard}（${pct}）→ ${row.check.onFall.map(partText).join("，")}`);
      }
      if (row.checkMod) lines.push(`${ECO_NAMES[e]}：本回合所有检定 ${row.checkMod.v < 0 ? `−${-row.checkMod.v}` : `+${row.checkMod.v}`}`);
    }
  }
  return lines;
}
const drawerLines = computed<string[]>(() => {
  const c = drawerItem.value;
  if (!c) return [];
  if (c.route === "ground") return c.ground ? [checkText(c.ground.check)] : [];
  if (c.route === "ambient") return c.weather ? weatherText(c.weather) : [];
  return (c.parts ?? []).map(partText);
});
</script>

<template>
  <!-- targeting 任务条（情境任务槽：做完/取消即消失） -->
  <div v-if="targeting" class="tgBar">
    <span class="tgTxt">点棋盘上的目标头像 · 合法亮 / 非法灰</span>
    <button type="button" class="tgCancel" @click="gameStore.cancelTargeting()">取消</button>
  </div>

  <!-- 手牌横滑条 -->
  <div v-if="stripOn" class="strip" aria-label="手牌（可横滑）">
    <button
      v-for="(v, i) in handViews"
      :key="`${v.id}-${i}`"
      type="button"
      class="mini"
      :class="{ cb: v.card.contraband }"
      @click="openDrawer(v.id)"
    >
      <span v-if="v.card.contraband" class="cbDot">违</span>
      <span class="mTitle">{{ v.card.title }}</span>
      <span class="mRoute">{{ ROUTE_TXT[v.card.route] }}</span>
    </button>
  </div>

  <!-- 半屏抽屉：大卡面 + 打牌入口 -->
  <BaseSheet v-if="drawerItem" @close="closeDrawer">
    <div class="bigCard" :class="{ contraband: drawerItem!.contraband }">
      <div class="hd">
        <span class="tag">🎁 道具 · 第 {{ drawerItem!.no }} 张</span>
        <span v-if="drawerItem!.contraband" class="cbTag">🚫 违禁品</span>
      </div>
      <h3 class="title">{{ drawerItem!.title }}</h3>
      <p class="flavor">{{ drawerItem!.flavor }}</p>
      <div class="routeChip">{{ ROUTE_TXT[drawerItem!.route] }}</div>
      <ul class="lines">
        <li v-for="(l, i) in drawerLines" :key="i">{{ l }}</li>
      </ul>
      <p v-if="drawerItem!.route === 'chooseOther'" class="hint">打出后指向对方；世界·即时：下一世界回合开始时结算。</p>
      <p v-if="drawerItem!.route === 'auto'" class="hint">不用选目标——系统按卡面规则自动指认（淘汰者/通关席跳过）；时机与他人卡同口径。</p>
      <p v-if="drawerItem!.route === 'ground'" class="hint">搁在脚下这格；下一踩上的人（含自己）触发判定，触发即消失。</p>
      <p v-if="drawerItem!.route === 'ambient'" class="hint">
        不用选目标——全桌气候 2 世界回合，各按所在地形行结算；《生物圈 3 号》：一场最多 1 个气候，后打顶掉旧气候（旧环境即时失效），打出者摸 1 张补偿。
      </p>

      <!-- 打牌入口：gate 不给过就不出钮（reason 落字） -->
      <div v-if="gate?.ok" class="actions">
        <button v-if="drawerItem!.route === 'chooseOther'" type="button" class="playBtn" @click="goTargeting">
          🎯 指向他人 · 去棋盘点目标
        </button>
        <button v-else type="button" class="playBtn" @click="playDirect">
          {{ drawerItem!.route === "ground" ? "⚠ 搁在脚下" : drawerItem!.route === "ambient" ? "🌪 掀起气候" : "▶ 打出" }}
        </button>
        <button type="button" class="ghostBtn" @click="closeDrawer">先不下</button>
      </div>
      <p v-else class="reason">⛔ {{ gate?.reason }}</p>
    </div>
  </BaseSheet>
</template>

<style scoped>
/* targeting 任务条：dock 上方情境位（与选路条同排） */
.tgBar {
  margin: 4px 10px 2px;
  background: #fff8e1;
  border: 1.5px solid #ffe082;
  color: #6d4c41;
  border-radius: 12px;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  animation: taskIn 0.2s ease-out;
  font-size: 12.5px;
  font-weight: 700;
}
.tgTxt {
  flex: 1;
}
.tgCancel {
  border: 0;
  background: #ff8a65;
  color: #fff;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  padding: 5px 12px;
}
@keyframes taskIn {
  from {
    transform: translateY(8px);
    opacity: 0;
  }
}

/* 手牌横滑条：dock 上方一排小卡 */
.strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 6px 12px 4px;
  scroll-snap-type: x proximity;
  scrollbar-width: none;
}
.strip::-webkit-scrollbar {
  display: none;
}
.mini {
  position: relative;
  flex: 0 0 auto;
  width: 64px;
  height: 78px;
  scroll-snap-align: start;
  border-radius: 10px;
  border: 1px solid #546e7a;
  background: linear-gradient(165deg, #2c3e4d, #263238);
  color: #eceff1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  padding: 6px 4px 6px;
  cursor: pointer;
}
.mini:active {
  transform: scale(0.96);
}
.mini.cb {
  border-color: #ef5350;
}
.mTitle {
  font-size: 11.5px;
  font-weight: 800;
  line-height: 1.25;
  max-width: 100%;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.mRoute {
  font-size: 9px;
  font-weight: 700;
  color: #90a4ae;
}
.cbDot {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #c62828;
  color: #fff;
  font-size: 8.5px;
  font-weight: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #ffcdd2;
}

/* 抽屉大卡 */
.bigCard {
  background: #263238;
  border: 1.5px solid #54a7d5;
  border-radius: 14px;
  padding: 13px 14px;
}
.bigCard.contraband {
  border-color: #ef5350;
}
.hd {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tag {
  font-size: 10.5px;
  font-weight: 800;
  color: #b3e5fc;
}
.cbTag {
  font-size: 10.5px;
  font-weight: 800;
  color: #ef9a9a;
  background: rgba(239, 83, 80, 0.14);
  border-radius: 999px;
  padding: 2px 8px;
}
.title {
  margin: 8px 0 3px;
  font-size: 19px;
  color: #ffe0b2;
  letter-spacing: 1px;
}
.flavor {
  margin: 0 0 9px;
  font-size: 12px;
  font-style: italic;
  color: #b0bec5;
  line-height: 1.55;
}
.routeChip {
  display: inline-block;
  font-size: 10.5px;
  font-weight: 800;
  color: #b3e5fc;
  border: 1px solid #54a7d5;
  border-radius: 999px;
  padding: 2.5px 9px;
  margin-bottom: 9px;
}
.lines {
  margin: 0 0 9px;
  padding: 9px 12px;
  background: rgba(84, 167, 213, 0.1);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.lines li {
  font-size: 12.5px;
  line-height: 1.5;
  list-style: none;
}
.lines li::before {
  content: "▸ ";
  color: #81d4fa;
}
.hint {
  margin: 0 0 10px;
  font-size: 10.5px;
  color: #78909c;
  line-height: 1.5;
}
.actions {
  display: flex;
  gap: 9px;
}
.playBtn {
  flex: 1;
  border: 0;
  border-radius: 12px;
  background: #ff9800;
  color: #fff;
  font-size: 14px;
  font-weight: 800;
  padding: 12px 8px;
}
.playBtn:active {
  transform: scale(0.98);
}
.ghostBtn {
  border: 1px solid #546e7a;
  background: transparent;
  color: #b0bec5;
  border-radius: 12px;
  font-size: 12.5px;
  font-weight: 700;
  padding: 12px 14px;
}
.reason {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: #ef9a9a;
  background: rgba(239, 83, 80, 0.1);
  border-radius: 10px;
  padding: 10px 12px;
  text-align: center;
}
</style>

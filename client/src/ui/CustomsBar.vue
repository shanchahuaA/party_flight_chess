<script setup lang="ts">
/**
 * 海关风云任务条组（#26 T7；界面呈现定案「情境任务槽」：警长查货窗=任务条组，报备/转让/查验按可用性点亮）。
 * dock 上方情境条——三个入口各开一个 BaseSheet：📦 报备转让 / 🔎 查验（警长）/ 🎁 交卡（罚没挂账时）。
 * 提交全走 customsShip / customsCheck / customsGive 意图；可用性按内核闸（customsShipGate/customsCheckGate）
 * 单口径判定——内核结算侧仍会复校，拒即 toast 不落半截账。
 * 信息面：警长/剩余查验/撤岗态/查验倒计时；报备单清单（明面报备=公开信息：谁→谁·报备货名）。
 * 报关单里「真货」不进壳层渲染（只走战报结果）——M1 保密口径与内核 state 注释一致（M2 按玩家切片下发）。
 */
import { computed, ref, watchEffect } from "vue";
import {
  CUSTOMS_CHECK_MS,
  ITEM_CARD_BY_ID,
  LEGIT_ITEM_CARDS,
  customsCheckGate,
  customsShipGate,
  type GameState,
  type ItemCard,
  type PlayGate,
  type PlayerState,
} from "../../../kernel/src";
import { gameStore } from "../game/store";
import BaseSheet from "./BaseSheet.vue";

const state = computed<GameState | null>(() => gameStore.state.value);
const me = computed<PlayerState | null>(() => state.value?.players[0] ?? null);
const customs = computed(() => state.value?.customs ?? null);

/** 倒计时按 beat 心跳逐秒刷新（deadline 是内核发的时间戳——口径同 CardChoice） */
const nowMs = computed(() => {
  void gameStore.beat.value;
  return gameStore.now();
});
const leftSec = (deadline: number): number => Math.max(0, Math.ceil((deadline - nowMs.value) / 1000));

const sheriffName = computed(() => (customs.value ? (state.value?.players[customs.value.sheriff]?.name ?? "？") : ""));
const imSheriff = computed(() => !!me.value && customs.value?.sheriff === me.value.id);
/** 窗内在场可操作（转让侧；与 customsShipGate 的转让方条件同口径） */
const canAct = computed(() => {
  const p = me.value;
  const c = customs.value;
  return !!p && !!c && state.value?.phase === "acting" && !p.dead && p.zone !== "done" && !p.confirmed && !p.skipped;
});
const handCards = computed<Array<{ id: string; card: ItemCard }>>(() =>
  (me.value?.hand ?? []).flatMap((id) => {
    const card = ITEM_CARD_BY_ID.get(id);
    return card ? [{ id, card }] : [];
  }),
);
/** 其他在场玩家（转让对象候选；终判在内核闸） */
const others = computed(() => (state.value?.players ?? []).filter((q) => q.id !== 0 && !q.dead && q.zone !== "done"));

const shipReady = computed(() => canAct.value && handCards.value.length > 0);
const checkReady = computed(() => canAct.value && imSheriff.value && !!customs.value && !customs.value.degraded && customs.value.checksLeft > 0);
const givePend = computed(() => (customs.value?.pending?.from === 0 ? customs.value.pending : null));

/** 剩余查验展示：撤岗/用尽/计数 三态 */
const checksLabel = computed(() => {
  const c = customs.value;
  if (!c) return "";
  if (c.degraded) return "已撤岗 · 自由转让";
  if (c.checksLeft <= 0) return "查验已用尽";
  return `查验 ${c.checksLeft} 次`;
});
const shipCount = computed(() => customs.value?.shipments.length ?? 0);

// ---------- 弹层状态机（一栏一表） ----------
const sheet = ref<"ship" | "check" | "give" | null>(null);
/** 安全闸：事实一变（收窗/挂账清了/资格没了）立即收表，不留死锁（口径同 HandDock 的 targeting 看门） */
watchEffect(() => {
  const s = sheet.value;
  const c = customs.value;
  if (!s) return;
  if (!c) {
    sheet.value = null;
    return;
  }
  if (s === "ship" && !shipReady.value) sheet.value = null;
  if (s === "check" && !checkReady.value) sheet.value = null;
  if (s === "give" && !givePend.value) sheet.value = null;
});

// ---------- 📦 报备转让表 ----------
const shipCard = ref<string | null>(null);
const shipTo = ref<number | null>(null);
const declared = ref<string | null>(null);
/** 报备名池=表一正货（内核 LEGIT_ITEM_CARDS 单一来源——明面校验与壳层候选同源不漂移） */
const LEGIT_CARDS = LEGIT_ITEM_CARDS;
/** 选卡时把「报备货名」默认成如实（正货）；违禁品没有可如实报的名——必须自己挑一个正货名（谎报） */
function pickShipCard(id: string): void {
  shipCard.value = id;
  declared.value = ITEM_CARD_BY_ID.get(id)?.contraband === true ? null : id;
}
const shipGateOf = (cardId: string, to: number): PlayGate => (state.value ? customsShipGate(state.value, 0, cardId, to) : { ok: false, reason: "未开局" });
function submitShip(): void {
  const c = customs.value;
  if (!c || !shipCard.value || shipTo.value == null || !declared.value) return;
  const n = c.shipments.length;
  gameStore.apply({ type: "customsShip", pid: 0, cardId: shipCard.value, to: shipTo.value, declared: declared.value });
  if (customs.value && customs.value.shipments.length > n) {
    sheet.value = null; // 成单即收（内核拒不发单——toast 已说明，表留着改）
    shipCard.value = null;
    shipTo.value = null;
    declared.value = null;
  }
}

// ---------- 🔎 查验表 ----------
const shipments = computed(() => customs.value?.shipments ?? []);
const checkGateOf = (shipment: number): PlayGate => (state.value ? customsCheckGate(state.value, 0, shipment) : { ok: false, reason: "未开局" });
/** 拒因文案（按钮 title；合法时空串） */
const checkReason = (shipment: number): string => {
  const g = checkGateOf(shipment);
  return g.ok ? "" : g.reason;
};
function submitCheck(id: number): void {
  const c = customs.value;
  if (!c) return;
  const before = c.checksLeft;
  gameStore.apply({ type: "customsCheck", pid: 0, shipment: id });
  if (customs.value && customs.value.checksLeft < before) sheet.value = null; // 查完即收（余次还能再开）
}

// ---------- 🎁 交卡表（罚没挂账） ----------
const giveCard = ref<string | null>(null);
function submitGive(): void {
  if (!giveCard.value) return;
  gameStore.apply({ type: "customsGive", pid: 0, cardId: giveCard.value });
  if (!customs.value?.pending) {
    sheet.value = null;
    giveCard.value = null;
  }
}
</script>

<template>
  <div v-if="customs" class="ccBar">
    <div class="ccHead">
      <span class="ccTitle">🚢 海关风云</span>
      <span class="ccWho">警长 {{ sheriffName }}</span>
      <span class="ccChecks" :class="{ gone: customs.degraded }">{{ checksLabel }}</span>
      <span v-if="imSheriff && !customs.degraded && customs.checksLeft > 0 && customs.armed" class="ccTimer">{{ leftSec(customs.checkDeadline) }}s</span>
      <span class="ccShips">报备 {{ shipCount }} 单</span>
    </div>
    <div class="ccRow">
      <button v-if="shipReady" type="button" class="ccBtn ship" @click="sheet = 'ship'">📦 报备转让</button>
      <button v-if="checkReady" type="button" class="ccBtn check" @click="sheet = 'check'">🔎 查验</button>
      <button v-if="givePend" type="button" class="ccBtn give" @click="sheet = 'give'">
        🎁 交 1 张给 {{ state?.players[givePend.to]?.name }}（{{ leftSec(givePend.deadline) }}s）
      </button>
      <span v-if="!shipReady && !checkReady && !givePend" class="ccHint">{{ customs.degraded ? "本窗只剩自由转让——警长已撤岗" : "窗内玩家间可报备转让（明面只许正货）" }}</span>
    </div>
  </div>

  <!-- 📦 报备转让：选卡 → 报备货名 → 交给谁 -->
  <BaseSheet v-if="sheet === 'ship'" @close="sheet = null">
    <div class="card">
      <div class="hd"><span class="tag">📦 报备转让</span><span class="sub">明面只许运正货；违禁品只能谎报</span></div>

      <p class="lbl">① 选 1 张手牌</p>
      <div class="chips">
        <button
          v-for="v in handCards"
          :key="v.id"
          type="button"
          class="chip"
          :class="{ on: shipCard === v.id, cb: v.card.contraband }"
          @click="pickShipCard(v.id)"
        >
          {{ v.card.contraband ? "🚫" : "" }}{{ v.card.title }}
        </button>
      </div>

      <p class="lbl">② 报备货名（正货清单——挑别人家的名=谎报）</p>
      <div class="chips names">
        <button
          v-for="c in LEGIT_CARDS"
          :key="c.id"
          type="button"
          class="chip sm"
          :class="{ on: declared === c.id, truth: shipCard === c.id }"
          :disabled="!shipCard"
          @click="declared = c.id"
        >
          {{ c.title }}<span v-if="shipCard === c.id" class="mark">如实</span>
        </button>
      </div>

      <p class="lbl">③ 交给谁</p>
      <div class="chips">
        <button
          v-for="q in others"
          :key="q.id"
          type="button"
          class="chip"
          :class="{ on: shipTo === q.id }"
          :disabled="!!shipCard && !shipGateOf(shipCard, q.id).ok"
          @click="shipTo = q.id"
        >
          {{ q.name }}
        </button>
      </div>
      <div class="acts">
        <button type="button" class="go" :disabled="!shipCard || shipTo == null || !declared" @click="submitShip">🚢 报备出单</button>
        <button type="button" class="ghost" @click="sheet = null">先不运</button>
      </div>
    </div>
  </BaseSheet>

  <!-- 🔎 查验：报备单清单 -->
  <BaseSheet v-if="sheet === 'check'" @close="sheet = null">
    <div class="card">
      <div class="hd">
        <span class="tag">🔎 查验报备</span>
        <span class="sub">命中谎报=罚卡；清白要赔卡（剩 {{ customs?.checksLeft }} 次）</span>
      </div>
      <p v-if="shipments.length === 0" class="empty">还没有人报备——等货上门，或 {{ Math.round(CUSTOMS_CHECK_MS / 1000) }} 秒不查就撤岗（自由转让）。</p>
      <div v-else class="ships">
        <div v-for="s in shipments" :key="s.id" class="shipRow" :class="{ done: s.checked }">
          <span class="shipWho">{{ state?.players[s.from]?.name }} → {{ state?.players[s.to]?.name }}</span>
          <span class="shipDecl">报备「{{ ITEM_CARD_BY_ID.get(s.declared)?.title }}」</span>
          <span v-if="s.checked" class="shipDone">已查过</span>
          <button v-else type="button" class="shipBtn" :disabled="!checkGateOf(s.id).ok" :title="checkReason(s.id)" @click="submitCheck(s.id)">
            查验
          </button>
        </div>
      </div>
      <div class="acts">
        <button type="button" class="ghost" @click="sheet = null">收起</button>
      </div>
    </div>
  </BaseSheet>

  <!-- 🎁 交卡（罚没挂账） -->
  <BaseSheet v-if="sheet === 'give' && givePend" @close="sheet = null">
    <div class="card">
      <div class="hd">
        <span class="tag">🎁 海关{{ givePend.reason === "caught" ? "罚没" : "赔账" }}</span>
        <span class="sub">{{ givePend.reason === "caught" ? "命中谎报——交 1 张给警长" : "查验清白——赔 1 张给报备人" }}（{{ leftSec(givePend.deadline) }}s，超时代选）</span>
      </div>
      <p class="lbl">选 1 张手牌交给 {{ state?.players[givePend.to]?.name }}</p>
      <div class="chips">
        <button v-for="v in handCards" :key="v.id" type="button" class="chip" :class="{ on: giveCard === v.id }" @click="giveCard = v.id">
          {{ v.card.title }}
        </button>
      </div>
      <div class="acts">
        <button type="button" class="go" :disabled="!giveCard" @click="submitGive">交出</button>
        <button type="button" class="ghost" @click="sheet = null">等超时代选</button>
      </div>
    </div>
  </BaseSheet>
</template>

<style scoped>
/* 情境任务条（dock 上方；与 HandDock 的 tgBar 同排布纪律） */
.ccBar {
  margin: 4px 10px 2px;
  background: #10222e;
  border: 1.5px solid #2f6d8f;
  border-radius: 12px;
  padding: 7px 12px 8px;
  animation: ccIn 0.2s ease-out;
}
@keyframes ccIn {
  from {
    transform: translateY(8px);
    opacity: 0;
  }
}
.ccHead {
  display: flex;
  align-items: baseline;
  gap: 9px;
  font-size: 12px;
  font-weight: 800;
  color: #b3e5fc;
}
.ccTitle {
  letter-spacing: 0.5px;
}
.ccWho {
  color: #ffe082;
}
.ccChecks {
  color: #81d4fa;
}
.ccChecks.gone {
  color: #ef9a9a;
}
.ccTimer {
  font-variant-numeric: tabular-nums;
  color: #ffab91;
}
.ccShips {
  margin-left: auto;
  color: #90a4ae;
  font-weight: 700;
}
.ccRow {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.ccBtn {
  border: 0;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 800;
  padding: 7px 13px;
  color: #fff;
}
.ccBtn.ship {
  background: #0277bd;
}
.ccBtn.check {
  background: #ad1457;
}
.ccBtn.give {
  background: #ef6c00;
  animation: btnPulse 1.1s ease-in-out infinite;
}
@keyframes btnPulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.05);
  }
}
.ccHint {
  font-size: 11.5px;
  color: #78909c;
}

/* 弹层内容 */
.card {
  background: #263238;
  border: 1.5px solid #2f6d8f;
  border-radius: 14px;
  padding: 13px 14px;
}
.hd {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tag {
  font-size: 13px;
  font-weight: 800;
  color: #ffe0b2;
}
.sub {
  font-size: 10.5px;
  font-weight: 700;
  color: #90a4ae;
}
.lbl {
  margin: 10px 0 5px;
  font-size: 11.5px;
  font-weight: 800;
  color: #b3e5fc;
}
.chips {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.chips.names {
  max-height: 118px;
  overflow-y: auto;
}
.chip {
  border: 1px solid #546e7a;
  background: #1c262e;
  color: #cfd8dc;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  padding: 6px 11px;
}
.chip.sm {
  font-size: 11px;
  padding: 4px 9px;
}
.chip.on {
  background: #0277bd;
  border-color: #81d4fa;
  color: #fff;
}
.chip.on.truth {
  background: #2e7d32;
  border-color: #a5d6a7;
}
.chip.cb {
  border-color: #ef5350;
}
.chip:disabled {
  opacity: 0.4;
}
.mark {
  font-size: 9px;
  margin-left: 3px;
  color: #c8e6c9;
}
.acts {
  display: flex;
  gap: 9px;
  margin-top: 12px;
}
.go {
  flex: 1;
  border: 0;
  border-radius: 12px;
  background: #0277bd;
  color: #fff;
  font-size: 14px;
  font-weight: 800;
  padding: 12px 8px;
}
.go:disabled {
  background: #37474f;
  color: #78909c;
}
.ghost {
  border: 1px solid #546e7a;
  background: transparent;
  color: #b0bec5;
  border-radius: 12px;
  font-size: 12.5px;
  font-weight: 700;
  padding: 12px 14px;
}
.empty {
  margin: 10px 0 0;
  font-size: 12px;
  color: #90a4ae;
}
.ships {
  margin-top: 10px;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.shipRow {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #1c262e;
  border: 1px solid #37474f;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 12px;
}
.shipRow.done {
  opacity: 0.55;
}
.shipWho {
  font-weight: 800;
  color: #cfd8dc;
}
.shipDecl {
  color: #ffe082;
}
.shipDone {
  margin-left: auto;
  color: #90a4ae;
  font-size: 11px;
}
.shipBtn {
  margin-left: auto;
  border: 0;
  border-radius: 999px;
  background: #ad1457;
  color: #fff;
  font-size: 11.5px;
  font-weight: 800;
  padding: 6px 12px;
}
.shipBtn:disabled {
  background: #37474f;
  color: #78909c;
}
</style>

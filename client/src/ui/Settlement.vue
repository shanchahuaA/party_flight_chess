<script lang="ts">
/** 呈现元数据导出（M2-T6）：RoomLobby 局间回看 sheet 复用同一套奖牌/战犯图标口径（单一真源） */
import type { CulpritReport } from "../../../kernel/src";

export const CULPRIT_META: Record<CulpritReport["kind"], { icon: string; label: string }> = {
  noCardsPlayed: { icon: "🛋", label: "全程划水" },
  healedToDeath: { icon: "💊", label: "治疗吞到死" },
  wrongCheck: { icon: "🔎", label: "查验查错人" },
};
export const MEDALS = ["🥇", "🥈", "🥉"];
</script>

<script setup lang="ts">
/**
 * 结算页（#28 T8b2 起，M3-T10 #62 升格为**局间主舞台**）。
 *
 * 数据源两路共用同一呈现层（Spec #52 实现决策 6）：
 * - 单机：`gameStore.state`（源一直在，phase=over 即可见）
 * - 联机：`roomStore.lastSettlement` 缓存（enterIntermission 时摘账）——服务端一翻 intermission
 *   就收对局壳，所以必须**先读缓存再收摊**，否则就是原来的「闪一两帧」。
 *
 * 形态要点（清单 S-01/05/06/08）：
 * - 结算页**留在屏上**直到自己点「回大厅」或房主开下一局（不再一闪而过）
 * - 动作区 sticky 吸底（8 人局 + 长找战犯也不用滚到底）
 * - 房主可在结算页直接「⚙ 改配置」→ 复用大厅同一个 ConfigPanel →「🎴 开下一局」
 * - 非房主见「等房主开下一局」＋当前配置摘要，无编辑钮
 */
import { computed, reactive, ref, watch } from "vue";
import { secretGoal } from "../../../kernel/src";
import type { SettlementResult, SettlementRow } from "../../../kernel/src";
import type { LobbyConfig } from "../../../shared/protocol";
import { gameStore } from "../game/store";
import { roomStore } from "../net/roomStore";
import {
  configSummary,
  DEFAULT_CONFIG_MODEL,
  fromLobbyConfig,
  toLobbyConfig,
} from "../game/lobbyConfig";
import BaseSheet from "./BaseSheet.vue";
import ConfigPanel, { type ConfigModel } from "./ConfigPanel.vue";

/** 联机局面（view=room）：结算数据走 lastSettlement 缓存，动作走房间面 */
const online = computed(() => roomStore.view.value === "room" && roomStore.code.value != null);
const amHost = computed(() => roomStore.snapshot.value?.hostSeat === roomStore.mySeat.value);
const roomPhase = computed(() => roomStore.snapshot.value?.phase ?? null);

/** 单机数据源 */
const soloState = computed(() => gameStore.state.value);
const soloSettlement = computed(() => soloState.value?.endgame?.settlement ?? null);
/** 联机数据源（缓存） */
const cached = computed(() => roomStore.lastSettlement.value);

/** 当前生效的结算账（两路收口到一份） */
const settlement = computed<SettlementResult | null>(() => {
  if (online.value) return cached.value?.settlement ?? null;
  return soloSettlement.value;
});
/** 名单来源（名字/暗牌解析）：联机用缓存里的终局态，单机用当前态 */
const roster = computed(() => (online.value ? (cached.value?.state ?? null) : soloState.value));

/**
 * 可见判据（#62 核心）：
 * - 单机：phase=over 且有结算
 * - 联机：**有缓存就显示**——即使房间已经翻 intermission、对局壳已收摊。
 *   但用户点过「回大厅」后要让位（returnedLobby）。
 */
const returnedLobby = ref(false);
const dismissed = ref(false);
const show = computed(() => {
  if (dismissed.value) return false;
  if (!settlement.value) return false;
  if (online.value) return !returnedLobby.value;
  return soloState.value?.phase === "over";
});

// 换局/新局：回到未收起状态（新一局结束时要能再弹）
watch(
  () => [gameStore.source.value, roomStore.lastSettlement.value] as const,
  () => {
    returnedLobby.value = false;
    dismissed.value = false;
  },
);

/** 排名序：总分降序、同分按 pid（与内核战报登顶行同口径） */
const ranked = computed<SettlementRow[]>(() => {
  const rows = settlement.value?.rows ?? [];
  return [...rows].sort((a, b) => b.total - a.total || a.pid - b.pid);
});

function name(pid: number): string {
  return roster.value?.players[pid]?.name ?? `玩家${pid}`;
}
function isMe(pid: number): boolean {
  return pid === 0;
}

/** 暗牌亮牌：各人开局面选定的那条目标（对局中的保密口径到结算即揭） */
function pickedGoal(row: SettlementRow) {
  const p = roster.value?.players[row.pid];
  const pick = p?.secretPick;
  if (!p || pick == null) return null;
  return secretGoal(p.secretOptions[pick]!);
}
function pickedAchieved(row: SettlementRow): boolean {
  const g = pickedGoal(row);
  return !!g && row.goalNos.includes(g.no);
}

// CULPRIT_META/MEDALS=模块顶导（上面 <script lang="ts"> 块）——呈现元数据单一真源，两种呈现同口径复用

function jumpTo(id: number): void {
  gameStore.openReport(id);
}
function reviewReport(): void {
  gameStore.openReport();
}
function restart(): void {
  gameStore.restart();
}

/** 回大厅（S-08）：
 *  - 联机：只收起结算浮层——下面的 RoomLobby 局间形态才是「大厅」（它显示上一局摘要与
 *    「回看战况」）。**绝不能调 backHome()**：那会断连并清掉 lastSettlement，大厅就成了空的。
 *  - 单机：弃局收摊回单机大厅。 */
function toLobby(): void {
  if (online.value) {
    returnedLobby.value = true;
    return;
  }
  dismissed.value = true;
  gameStore.toLobby();
}

// ── 房主局间改配置（S-06）：复用大厅同一个 ConfigPanel ──
const cfgOpen = ref(false);
const cfg = reactive<ConfigModel>({ ...DEFAULT_CONFIG_MODEL });
const roomCfg = computed<LobbyConfig | null>(() => roomStore.snapshot.value?.config ?? null);

watch(
  roomCfg,
  (c) => {
    if (!c) return;
    // 房主弹窗开着=编辑中，别被广播回拉
    if (amHost.value && cfgOpen.value) return;
    Object.assign(cfg, fromLobbyConfig(c));
  },
  { immediate: true },
);

function openCfg(): void {
  const c = roomCfg.value;
  if (c) Object.assign(cfg, fromLobbyConfig(c));
  cfgOpen.value = true;
}
/** 面板落定沿 → 上行 setConfig（服务端 lobbyGate 在 intermission 放行） */
function sendCfg(): void {
  if (!amHost.value) return;
  roomStore.setConfig(toLobbyConfig(cfg));
}
/** 开下一局（S-06）：房主专属；服务端 start 在 intermission 同闸放行 */
function startNext(): void {
  roomStore.startGame();
  returnedLobby.value = true; // 对局面接管，结算页退场
}
const summary = computed(() => configSummary(roomCfg.value));
</script>

<template>
  <div v-if="show" class="settlePage">
    <div class="panel">
      <header class="head">
        <h1>🏁 终局结算</h1>
        <p class="winner" v-if="ranked[0]">
          「{{ name(ranked[0].pid) }}」以 <b>{{ ranked[0].total }}</b> 分登顶
        </p>
        <!-- 群体失败盖章（T8a2 闸门 → T8b1 落账 → 本页呈现） -->
        <div v-if="settlement?.groupFail" class="stamp">💀 群体失败</div>
      </header>
      <p v-if="settlement?.groupFail" class="failNote">全员倒在最后一波——全员暗牌目标作废（含已达成），结算盖章进入找战犯。</p>

      <!-- 排名榜：总分降序；行内五项分项透明（与战报 score 行同源同值） -->
      <section class="board">
        <div
          v-for="(r, i) in ranked"
          :key="r.pid"
          class="row"
          :class="{ me: isMe(r.pid) }"
          :style="{ animationDelay: `${Math.min(i, 8) * 40}ms` }"
        >
          <div class="rankLine">
            <span class="medal">{{ MEDALS[i] ?? `#${i + 1}` }}</span>
            <span class="pname" :class="{ mine: isMe(r.pid) }">{{ name(r.pid) }}<i v-if="isMe(r.pid)">（我）</i></span>
            <span class="total">{{ r.total }}<small>分</small></span>
          </div>
          <div class="items">
            <span class="it">进度 +{{ r.progress }}</span>
            <span class="it">通关 +{{ r.finish }}<template v-if="r.finishRank">（第 {{ r.finishRank }} 位）</template></span>
            <span class="it">存活 +{{ r.survive }}</span>
            <span class="it">称号 +{{ r.titleScore }}<template v-if="r.goalNos.length">（{{ r.goalNos.length }} 条）</template></span>
            <span class="it">整蛊 +{{ r.grudgeScore }}（{{ r.grudgeCount }} 次）</span>
          </div>
          <!-- 称号亮牌：达成的逐条亮出；群体失败=作废章压顶 -->
          <div class="titles">
            <template v-if="r.goalsVoided">
              <span class="voided">🖋 称号作废</span>
            </template>
            <template v-else-if="r.goalNos.length">
              <span v-for="no in r.goalNos" :key="no" class="title" :class="{ lit: isMe(r.pid) }">{{ secretGoal(no).title }}</span>
            </template>
            <template v-else>
              <span class="noTitle">—</span>
            </template>
          </div>
          <!-- 暗牌亮牌：选定的那条目标与判定结果 -->
          <p class="dark" v-if="pickedGoal(r)">
            🎯 暗牌「{{ pickedGoal(r)!.title }}」
            <b v-if="r.goalsVoided" class="voidTxt">作废</b>
            <b v-else-if="pickedAchieved(r)" class="hitTxt">达成 ✓</b>
            <b v-else class="missTxt">未达成</b>
          </p>
        </div>
      </section>

      <!-- 找战犯（只给数据不做裁决——GLOSSARY）：证据条目点击溯源进战报 -->
      <section class="culprits">
        <h2>🧾 找战犯</h2>
        <p v-if="!settlement?.culprits.length" class="clean">查无战犯，皆大欢喜。</p>
        <div v-for="(c, i) in settlement?.culprits ?? []" :key="i" class="culprit">
          <div class="cHead">
            <span class="cIcon">{{ CULPRIT_META[c.kind].icon }}</span>
            <span class="cName">{{ name(c.pid) }}</span>
            <span class="cKind">{{ CULPRIT_META[c.kind].label }}</span>
          </div>
          <p class="cDetail">{{ c.detail }}</p>
          <div v-if="c.evidence.length" class="cEvi">
            <span class="eviLab">证据：</span>
            <button v-for="id in c.evidence" :key="id" class="eviLink" type="button" @click="jumpTo(id)">战报 #{{ id }}</button>
          </div>
          <div v-else class="cEvi"><span class="eviLab">整局无出手记录（缺席型，无处回看）</span></div>
        </div>
      </section>

      <!-- 动作区吸底（S-05）：8 人局 + 长找战犯也不用滚到底 -->
      <footer class="acts">
        <template v-if="online">
          <!-- 联机（S-06/S-08）：房主可改配置开下一局；非房主只见等待与摘要 -->
          <div class="onlineRow">
            <button v-if="amHost" class="cfgBtn" type="button" @click="openCfg">⚙ 改配置</button>
            <button v-if="amHost" class="again" type="button" @click="startNext">🎴 开下一局</button>
            <p v-else class="waitHost">等房主开下一局</p>
          </div>
          <p class="cfgLine">当前配置：{{ summary }}</p>
          <div class="actsRow">
            <button class="ghost" type="button" @click="reviewReport">📜 回看战报</button>
            <button class="ghost" type="button" @click="toLobby">🏠 回大厅</button>
          </div>
        </template>
        <template v-else>
          <!-- 单机（S-07 回归）：再来一局按上局配置换新种子直开 -->
          <button class="again" type="button" @click="restart">🔄 再来一局</button>
          <div class="actsRow">
            <button class="ghost" type="button" @click="reviewReport">📜 回看战报</button>
            <button class="ghost" type="button" @click="toLobby">🏠 回大厅</button>
          </div>
        </template>
      </footer>
    </div>

    <!-- 房主局间改配置（S-06）：与大厅同一个 ConfigPanel，不复制版式 -->
    <BaseSheet v-if="cfgOpen" @close="cfgOpen = false">
      <div class="cfgSheet">
        <h3 class="sheetTitle">⚙️ 局间改配置（房主）</h3>
        <p class="hint">改完点「🎴 开下一局」让全员进新局；数值在开局后冻结。</p>
        <ConfigPanel :model="cfg" :readonly="false" @change="sendCfg()" />
        <button class="close" type="button" @click="cfgOpen = false">收 起</button>
      </div>
    </BaseSheet>
  </div>
</template>

<style scoped>
.settlePage {
  position: fixed;
  inset: 0;
  z-index: 120; /* 压过 dock/战报带（90 档抽屉可再抬到 130 之上溯源） */
  background: rgba(16, 24, 32, 0.96);
  overflow-y: auto;
  padding: calc(16px + env(safe-area-inset-top)) 12px 0;
}
.panel {
  max-width: 560px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 动作区吸底留出的空间（避免最后一行被吸底条盖住） */
  padding-bottom: calc(112px + env(safe-area-inset-bottom));
}
.head {
  position: relative;
  text-align: center;
  padding-top: 6px;
}
.head h1 {
  font-size: 21px;
  margin: 0;
  color: #eceff1;
}
.winner {
  margin: 6px 0 0;
  font-size: 13px;
  color: #b0bec5;
}
.winner b {
  color: #ffd54f;
  font-size: 16px;
}
/* 群体失败章：斜盖红章+按压实效 */
.stamp {
  position: absolute;
  right: 4%;
  top: -4px;
  transform: rotate(-10deg);
  border: 3px double #ef5350;
  color: #ef5350;
  border-radius: 10px;
  padding: 5px 12px;
  font-size: 16px;
  font-weight: 900;
  letter-spacing: 2px;
  background: rgba(239, 83, 80, 0.1);
  animation: stampIn 0.4s cubic-bezier(0.2, 2.4, 0.4, 1) both;
}
@keyframes stampIn {
  from {
    transform: rotate(-10deg) scale(2.4);
    opacity: 0;
  }
  to {
    transform: rotate(-10deg) scale(1);
    opacity: 1;
  }
}
.failNote {
  margin: 0;
  text-align: center;
  font-size: 11.5px;
  color: #ef9a9a;
}
.board {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 结算名次逐行淡入（动效红线第 ③ 处：仅 CSS，≤300ms） */
.row {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(176, 190, 197, 0.25);
  border-radius: 14px;
  padding: 9px 11px;
  animation: rowIn 0.26s ease-out both;
}
@keyframes rowIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.row.me {
  border-color: #ef5350;
  background: rgba(239, 83, 80, 0.1);
}
.rankLine {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.medal {
  font-size: 15px;
  flex: 0 0 34px;
}
.pname {
  font-size: 14px;
  font-weight: 800;
  color: #eceff1;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pname i {
  font-style: normal;
  font-size: 11px;
  color: #ff8a80;
}
.total {
  font-size: 20px;
  font-weight: 900;
  color: #ffd54f;
}
.total small {
  font-size: 10px;
  font-weight: 400;
  color: #b0bec5;
  margin-left: 2px;
}
.items {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-top: 6px;
}
.it {
  font-size: 10.5px;
  color: #b0bec5;
  background: rgba(38, 50, 56, 0.7);
  border-radius: 999px;
  padding: 2px 8px;
}
.titles {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
  min-height: 22px;
  align-items: center;
}
/* 称号亮牌：达成条目逐条亮出；我的是金字亮牌 */
.title {
  font-size: 11.5px;
  font-weight: 700;
  color: #cfd8dc;
  background: rgba(38, 50, 56, 0.85);
  border: 1px solid #455a64;
  border-radius: 8px;
  padding: 3px 8px;
}
.title.lit {
  color: #ffe082;
  border-color: #ffb300;
  background: rgba(255, 179, 0, 0.12);
  box-shadow: 0 0 8px rgba(255, 179, 0, 0.35);
}
.voided {
  font-size: 11.5px;
  font-weight: 800;
  color: #ef5350;
  border: 1.5px dashed #ef5350;
  border-radius: 8px;
  padding: 2px 9px;
  transform: rotate(-2deg);
}
.noTitle {
  font-size: 11px;
  color: #546e7a;
}
.dark {
  margin: 7px 0 0;
  font-size: 11px;
  color: #90a4ae;
}
.dark b {
  font-weight: 800;
  margin-left: 4px;
}
.hitTxt {
  color: #66bb6a;
}
.missTxt {
  color: #90a4ae;
}
.voidTxt {
  color: #ef5350;
}
.culprits {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(176, 190, 197, 0.25);
  border-radius: 14px;
  padding: 10px 12px;
}
.culprits h2 {
  font-size: 13.5px;
  margin: 0 0 8px;
  color: #eceff1;
}
.clean {
  margin: 0;
  font-size: 12px;
  color: #90a4ae;
}
.culprit {
  border-top: 1px dashed rgba(176, 190, 197, 0.2);
  padding: 7px 0;
}
.culprit:first-of-type {
  border-top: 0;
  padding-top: 0;
}
.cHead {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.cIcon {
  font-size: 13px;
}
.cName {
  font-size: 12.5px;
  font-weight: 800;
  color: #eceff1;
}
.cKind {
  font-size: 10.5px;
  color: #ef9a9a;
  background: rgba(239, 83, 80, 0.12);
  border-radius: 999px;
  padding: 1px 8px;
}
.cDetail {
  margin: 4px 0 5px;
  font-size: 11.5px;
  color: #b0bec5;
  line-height: 1.5;
}
.cEvi {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.eviLab {
  font-size: 10.5px;
  color: #78909c;
}
.eviLink {
  border: 1px solid #455a64;
  background: #263238;
  color: #4fc3f7;
  border-radius: 999px;
  font-size: 10.5px;
  padding: 2px 9px;
  text-decoration: underline dotted;
}
/* 动作区吸底（S-05）：常驻屏底，内容滚动不影响可点 */
.acts {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  background: linear-gradient(to top, rgba(16, 24, 32, 0.99) 62%, rgba(16, 24, 32, 0));
  padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-width: 560px;
  margin: 0 auto;
  box-sizing: border-box;
}
.onlineRow {
  display: flex;
  gap: 8px;
  align-items: center;
}
.cfgBtn {
  flex: 0 0 auto;
  border: 1px solid #455a64;
  background: #263238;
  color: #cfd8dc;
  border-radius: 12px;
  padding: 12px 14px;
  font-size: 12.5px;
  font-weight: 700;
}
.waitHost {
  flex: 1;
  margin: 0;
  text-align: center;
  font-size: 12.5px;
  color: #90a4ae;
  padding: 12px;
  border: 1px dashed #455a64;
  border-radius: 12px;
}
.cfgLine {
  margin: 0;
  text-align: center;
  font-size: 10.5px;
  color: #78909c;
}
.again {
  flex: 1;
  border: 0;
  border-radius: 14px;
  background: #b71c1c;
  color: #fff;
  font-size: 15px;
  font-weight: 800;
  padding: 13px;
  box-shadow: 0 3px 10px rgba(183, 28, 28, 0.45);
}
.actsRow {
  display: flex;
  gap: 8px;
}
.ghost {
  flex: 1;
  border: 1px solid #455a64;
  background: #263238;
  color: #cfd8dc;
  border-radius: 12px;
  padding: 10px;
  font-size: 12.5px;
  font-weight: 700;
}
/* 局间配置 sheet（与大厅同一套 ConfigPanel） */
.cfgSheet {
  color: #eceff1;
}
.sheetTitle {
  margin: 0 0 4px;
  font-size: 15px;
}
.cfgSheet .hint {
  font-size: 11px;
  color: #90a4ae;
  margin: 0 0 8px;
}
.close {
  margin-top: 12px;
  width: 100%;
  border: 1px solid #455a64;
  background: #263238;
  color: #cfd8dc;
  border-radius: 12px;
  padding: 10px;
  font-size: 13px;
  font-weight: 700;
}
</style>

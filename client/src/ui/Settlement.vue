<script setup lang="ts">
/**
 * 结算页简版（#28 T8b2，完全体在 M3）：局终（phase over 且 T8b1 结算已落账）整页浮层盖账。
 * 数据全自 T8b1 判定核（state.endgame.settlement = 战报 score 条目同源，禁另算）：
 * 五项分项透明+总分排名／我达成的称号亮牌（暗牌一并亮出）／群体失败盖章／
 * 找战犯聚合呈现+证据条目点击溯源跳进战报抽屉（WorldMessage 定位闪光）；再来一局=同配置换新种子重开。
 */
import { computed } from "vue";
import { secretGoal } from "../../../kernel/src";
import type { CulpritReport, SettlementRow } from "../../../kernel/src";
import { gameStore } from "../game/store";

const state = computed(() => gameStore.state.value);
const settlement = computed(() => state.value?.endgame?.settlement ?? null);
const show = computed(() => state.value?.phase === "over" && !!settlement.value);

/** 排名序：总分降序、同分按 pid（与内核战报登顶行同口径） */
const ranked = computed<SettlementRow[]>(() => {
  const rows = settlement.value?.rows ?? [];
  return [...rows].sort((a, b) => b.total - a.total || a.pid - b.pid);
});

const MEDALS = ["🥇", "🥈", "🥉"];

function name(pid: number): string {
  return state.value?.players[pid]?.name ?? `玩家${pid}`;
}
function isMe(pid: number): boolean {
  return pid === 0;
}

/** 暗牌亮牌：各人开局面选定的那条目标（对局中的保密口径到结算即揭） */
function pickedGoal(row: SettlementRow) {
  const p = state.value?.players[row.pid];
  const pick = p?.secretPick;
  if (!p || pick == null) return null;
  return secretGoal(p.secretOptions[pick]!);
}
function pickedAchieved(row: SettlementRow): boolean {
  const g = pickedGoal(row);
  return !!g && row.goalNos.includes(g.no);
}

const CULPRIT_META: Record<CulpritReport["kind"], { icon: string; label: string }> = {
  noCardsPlayed: { icon: "🛋", label: "全程划水" },
  healedToDeath: { icon: "💊", label: "治疗吞到死" },
  wrongCheck: { icon: "🔎", label: "查验查错人" },
};

function jumpTo(id: number): void {
  gameStore.openReport(id);
}
function reviewReport(): void {
  gameStore.openReport();
}
function restart(): void {
  gameStore.restart();
}
function toLobby(): void {
  gameStore.toLobby();
}
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

      <footer class="acts">
        <button class="again" type="button" @click="restart">🔄 再来一局</button>
        <div class="actsRow">
          <button class="ghost" type="button" @click="reviewReport">📜 回看战报</button>
          <button class="ghost" type="button" @click="toLobby">⚙️ 回大厅调配置</button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.settlePage {
  position: fixed;
  inset: 0;
  z-index: 120; /* 压过 dock/战报带（90 档抽屉可再抬到 130 之上溯源） */
  background: rgba(16, 24, 32, 0.96);
  overflow-y: auto;
  padding: calc(16px + env(safe-area-inset-top)) 12px calc(20px + env(safe-area-inset-bottom));
}
.panel {
  max-width: 560px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.row {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(176, 190, 197, 0.25);
  border-radius: 14px;
  padding: 9px 11px;
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
.acts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 4px;
}
.again {
  width: 100%;
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
</style>

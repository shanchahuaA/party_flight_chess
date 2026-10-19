<script setup lang="ts">
/** HUD：回合进度 + 窗倒计时 / 休息计时（跳过）+ 🎯 我的暗牌弹层（战报叙事归 WorldMessage 让位带） */
import { computed, ref } from "vue";
import { BOARD, ECO_NAMES, secretGoal } from "../../../kernel/src";
import { gameStore } from "../game/store";
import { hpRatio, hpTone } from "../game/hp";
import BaseSheet from "./BaseSheet.vue";

const state = computed(() => {
  return gameStore.state.value;
});

const turnLabel = computed(() => {
  const s = state.value;
  if (!s) return "";
  const cap = gameStore.kernel.value?.config.turnCap ?? 15;
  if (s.phase === "drafting") return "开局 · 抽暗牌";
  if (s.phase !== "over" && s.endgame?.beast) return `🐉 最后一波 · 第 ${s.endgame.beast.wave} 波`;
  return s.phase === "over" ? "终局" : `回合 ${s.turn}/${cap}`;
});

// 倒计时按当前秒重算：beat 心跳驱动逐秒刷新
const countdown = computed(() => {
  void gameStore.beat.value;
  const s = state.value;
  if (!s) return "";
  const now = gameStore.now();
  if (s.phase === "acting") {
    const left = Math.max(0, Math.ceil((s.windowDeadline - now) / 1000));
    return `⏳ ${left}s`;
  }
  if (s.phase === "rest") {
    const left = Math.max(0, Math.ceil((s.restUntil - now) / 1000));
    return `⏸ 休息 ${left}s`;
  }
  return "";
});

// 轮班·限时（T9）：轮到谁=他的表在走（world·即时恒 null 不显示；读数共用 store getter）
const actorName = computed(() => gameStore.turnActorName);

const canSkip = computed(() => state.value?.phase === "rest");

function skip(): void {
  gameStore.apply({ type: "skipRest" });
}

// 我当前所在生态（提示生态区配色语义；T3 起挂生态特殊卡判定）
const myEco = computed(() => {
  const p = state.value?.players[0];
  if (!p) return "";
  if (p.zone !== "main") return p.zone === "done" ? "🏁 通关席" : "屋前小路";
  return ECO_NAMES[BOARD[p.pos]!.zone];
});

// 我的暗牌弹层（界面呈现定案：暗牌目标图标点开看自己的目标，不放设置里）
const showSecret = ref(false);
const myGoal = computed(() => {
  const p = gameStore.human;
  const pick = p?.secretPick;
  if (!p || pick == null) return null;
  return secretGoal(p.secretOptions[pick]!);
});

// 血量常驻 pill（#23 T5a，数值表 §5.3）：心形数字+微条，跟随自定义上限；档位判据走共用件 game/hp
const maxHp = computed(() => gameStore.kernel.value?.config.maxHp ?? 10);
const myHp = computed(() => state.value?.players[0]?.hp ?? 0);
const hpPct = computed(() => hpRatio(myHp.value, maxHp.value));
const hpToneCls = computed(() => hpTone(hpPct.value));
</script>

<template>
  <div class="hud">
    <div class="pill main">
      <span v-if="state?.phase !== 'over'">{{ turnLabel }}</span>
      <span v-else class="over">🏁 局长打满</span>
      <span class="sep">·</span>
      <!-- 轮班·限时（T9）：轮到谁的徽标（我的棒=金色点名） -->
      <span v-if="actorName" class="actor" :class="{ mine: state?.turnActor === 0 }"
        >轮到 {{ actorName }}</span
      >
      <span v-if="actorName" class="sep">·</span>
      <span>{{ countdown }}</span>
      <button v-if="canSkip" class="skip" @click="skip">跳过休息</button>
    </div>
    <div class="sp" />
    <!-- 血量常驻（T5a §5.3）：心形数字+微条；title 带完整读数 -->
    <div class="pill hp" :title="`血量 ${myHp}/${maxHp}`">
      <span class="face">❤ {{ myHp }}</span>
      <span class="bar"><i :class="hpToneCls" :style="{ width: `${Math.round(hpPct * 100)}%` }" /></span>
    </div>
    <button class="pill secret" type="button" @click="showSecret = true">🎯</button>

    <!-- 我的暗牌（仅本人视角；浮层原则：查看类不切页） -->
    <BaseSheet v-if="showSecret" @close="showSecret = false">
      <div class="secretSheet">
        <h3>🎯 我的暗牌目标</h3>
        <p class="shHint">对他人保密；终局亮牌判定（达成=称号+8 分，T8b 接入）。</p>
        <template v-if="myGoal">
          <div class="myGoalCard">
            <span class="t">{{ myGoal.title }}</span>
            <span class="n">{{ myGoal.note }}</span>
          </div>
        </template>
        <button class="close" type="button" @click="showSecret = false">收 起</button>
      </div>
    </BaseSheet>
  </div>
</template>

<style scoped>
.hud {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: calc(7px + env(safe-area-inset-top)) 10px 4px;
  min-height: 34px;
}
.pill {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid #cfd8dc;
  border-radius: 999px;
  padding: 4px 9px;
  font-size: 11.5px;
  font-weight: 700;
  color: #263238;
  white-space: nowrap;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
}
.pill .sep {
  color: #90a4ae;
  margin: 0 3px;
}
/* 轮班行动者徽标（T9）：我的棒金色点亮 */
.pill .actor {
  color: #00695c;
}
.pill .actor.mine {
  color: #b71c1c;
}
.pill .over {
  color: #c62828;
}
.pill.eco {
  background: rgba(38, 50, 56, 0.78);
  color: #e0f2f1;
  border-color: transparent;
}
/* 血量 pill（T5a）：心形数字+微条；三档色随占比切换 */
.pill.hp {
  display: flex;
  align-items: center;
  cursor: default;
}
.pill.hp .face {
  color: #c62828;
}
.pill.hp .bar {
  display: inline-block;
  width: 46px;
  height: 5px;
  margin-left: 5px;
  border-radius: 3px;
  background: rgba(38, 50, 56, 0.35);
  overflow: hidden;
}
.pill.hp .bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.25s ease;
}
.pill.hp .bar .ok {
  background: #66bb6a;
}
.pill.hp .bar .mid {
  background: #ffca28;
}
.pill.hp .bar .low {
  background: #ef5350;
}
.skip {
  margin-left: 6px;
  border: 0;
  background: #26a69a;
  color: #fff;
  border-radius: 999px;
  font-size: 10.5px;
  padding: 3px 8px;
  font-weight: 700;
}
.sp {
  flex: 1;
}
.pill.secret {
  background: rgba(38, 50, 56, 0.85);
  color: #ffd54f;
  border-color: transparent;
  font-size: 13px;
  padding: 4px 10px;
  cursor: pointer;
}
.secretSheet {
  color: #eceff1;
}
.secretSheet h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.shHint {
  font-size: 11px;
  color: #90a4ae;
  margin: 0 0 10px;
}
.myGoalCard {
  background: #263238;
  border: 1.5px solid #ef5350;
  border-radius: 12px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 12px;
}
.myGoalCard .t {
  font-size: 14.5px;
  font-weight: 800;
}
.myGoalCard .n {
  font-size: 12px;
  color: #b0bec5;
  line-height: 1.5;
}
.close {
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

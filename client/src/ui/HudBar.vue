<script setup lang="ts">
/** HUD：回合进度 + 窗倒计时 / 休息计时（跳过）+ 🎯 我的暗牌弹层（战报叙事归 WorldMessage 让位带） */
import { computed, ref } from "vue";
import { BOARD, ECO_NAMES, secretGoal } from "../../../kernel/src";
import { gameStore } from "../game/store";
import BaseSheet from "./BaseSheet.vue";

const state = computed(() => {
  return gameStore.state.value;
});

const turnLabel = computed(() => {
  const s = state.value;
  if (!s) return "";
  const cap = gameStore.kernel.value?.config.turnCap ?? 15;
  if (s.phase === "drafting") return "开局 · 抽暗牌";
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
</script>

<template>
  <div class="hud">
    <div class="pill main">
      <span v-if="state?.phase !== 'over'">{{ turnLabel }}</span>
      <span v-else class="over">🏁 局长打满</span>
      <span class="sep">·</span>
      <span>{{ countdown }}</span>
      <button v-if="canSkip" class="skip" @click="skip">跳过休息</button>
    </div>
    <div class="sp" />
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
.pill .over {
  color: #c62828;
}
.pill.eco {
  background: rgba(38, 50, 56, 0.78);
  color: #e0f2f1;
  border-color: transparent;
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

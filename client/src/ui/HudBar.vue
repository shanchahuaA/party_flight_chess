<script setup lang="ts">
/** HUD：回合进度 + 窗倒计时 / 休息计时（跳过）；最近战报一条（T1 简版） */
import { computed } from "vue";
import { BOARD, ECO_NAMES } from "../../../kernel/src";
import { gameStore } from "../game/store";

const state = computed(() => {
  return gameStore.state.value;
});
const lastMessage = computed(() => gameStore.lastMessage.value);

const turnLabel = computed(() => {
  const s = state.value;
  if (!s) return "";
  const cap = gameStore.kernel.value?.config.turnCap ?? 15;
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
    <div class="pill eco">{{ myEco }}</div>
    <div v-if="lastMessage" class="pill msg" :class="`k-${lastMessage.kind}`">
      {{ lastMessage.text }}
    </div>
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
.pill.msg {
  max-width: 46vw;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
  color: #37474f;
}
.pill.k-system {
  border-left: 3px solid #263238;
}
.pill.k-event {
  border-left: 3px solid #ff7043;
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
@media (max-width: 420px) {
  .pill.msg {
    display: none;
  }
}
</style>

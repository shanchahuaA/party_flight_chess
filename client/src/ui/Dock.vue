<script setup lang="ts">
/**
 * 底部 dock：掷骰大圆钮 + 确认结束长条（硬规格：掷骰与确认分离）。
 * 掷完立刻逐格走；确认之前一直可操作；确认后进等待区。
 */
import { computed } from "vue";
import type { PlayerState } from "../../../kernel/src";
import { gameStore } from "../game/store";
import HandDock from "./HandDock.vue";

const state = computed(() => {
  return gameStore.state.value;
});
const me = computed<PlayerState | null>(() => state.value?.players[0] ?? null);

const acting = computed(() => state.value?.phase === "acting");
const canRoll = computed(() => {
  const p = me.value;
  return acting.value && !!p && p.zone !== "done" && !p.dead && !p.rolled && !p.confirmed && !p.walk;
});
const rolled = computed(() => !!me.value?.rolled);
const confirmed = computed(() => !!me.value?.confirmed);
const done = computed(() => me.value?.zone === "done");

const face = computed(() => gameStore.lastFace.value);

function roll(): void {
  gameStore.apply({ type: "roll", pid: 0 });
}
function confirm(): void {
  gameStore.apply({ type: "confirm", pid: 0 });
}
</script>

<template>
  <div class="dock">
    <!-- 手牌横滑+抽屉+打牌（T4a2）：dock 固定钮上方的一排情境手牌（含 targeting 任务条） -->
    <HandDock />
    <div id="btnRow">
      <button id="rollBtn" :disabled="!canRoll" :class="{ armed: canRoll }" @click="roll">
        <span v-if="face !== null && rolled">🎲 {{ face }}</span>
        <span v-else>🎲<br />掷骰</span>
      </button>
      <button
        id="confirmBtn"
        :class="{ armed: (!!rolled || done) && !confirmed, waited: confirmed }"
        :disabled="!acting || confirmed || (!rolled && !done)"
        @click="confirm"
      >
        <template v-if="confirmed">⏳ 已确认 · 等待区</template>
        <template v-else-if="done">🏁 通关席 · 观局</template>
        <template v-else>✔ 确认结束</template>
      </button>
    </div>
  </div>
</template>

<style scoped>
.dock {
  padding: 6px 10px calc(8px + env(safe-area-inset-bottom));
}
#btnRow {
  display: flex;
  align-items: center;
  gap: 10px;
}
#rollBtn {
  width: 76px;
  height: 76px;
  border-radius: 50%;
  border: 0;
  background: var(--red, #e53935);
  color: #fff;
  font-size: 15px;
  font-weight: 800;
  line-height: 1.25;
  letter-spacing: 0.5px;
  box-shadow: 0 3px 10px rgba(229, 57, 53, 0.4);
  flex: 0 0 auto;
}
#rollBtn:disabled {
  background: #546e7a;
  color: #b0bec5;
  box-shadow: none;
}
#rollBtn.armed {
  animation: btnPulse 1.1s ease-in-out infinite;
}
@keyframes btnPulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.06);
  }
}
#confirmBtn {
  flex: 1;
  padding: 17px 10px;
  border: 0;
  border-radius: 14px;
  background: #37474f;
  color: #cfd8dc;
  font-size: 14.5px;
  font-weight: 800;
}
#confirmBtn.armed {
  background: #43a047;
  color: #fff;
  box-shadow: 0 3px 10px rgba(67, 160, 71, 0.4);
}
#confirmBtn.waited {
  background: #2b3640;
  color: #90a4ae;
}
#confirmBtn:disabled {
  opacity: 0.85;
}
</style>

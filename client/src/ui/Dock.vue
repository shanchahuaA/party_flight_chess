<script setup lang="ts">
/**
 * 底部 dock：掷骰大圆钮 + 确认结束长条（硬规格：掷骰与确认分离）。
 * 掷完立刻逐格走；确认之前一直可操作；确认后进等待区。
 * 年兽战（T8a2）：掷骰钮换砍击钮（伤害骰 strike）、确认条换战况条（波数+兽血）。
 */
import { computed } from "vue";
import { BEAST_DIE, strikeGate } from "../../../kernel/src";
import type { PlayerState } from "../../../kernel/src";
import { gameStore } from "../game/store";
import HandDock from "./HandDock.vue";
import CustomsBar from "./CustomsBar.vue";

const state = computed(() => {
  return gameStore.state.value;
});
const me = computed<PlayerState | null>(() => state.value?.players[0] ?? null);

const acting = computed(() => state.value?.phase === "acting");
const fight = computed(() => !!state.value?.endgame?.beast && acting.value); // 年兽战波窗（T8a2）
const dead = computed(() => !!me.value?.dead);
const canRoll = computed(() => {
  const p = me.value;
  return acting.value && !!p && p.zone !== "done" && !p.dead && !p.rolled && !p.confirmed && !p.walk;
});
const canStrike = computed(() => fight.value && !!me.value && strikeGate(state.value!, 0).ok);
const rolled = computed(() => !!me.value?.rolled);
const confirmed = computed(() => !!me.value?.confirmed);
const done = computed(() => me.value?.zone === "done");

const face = computed(() => gameStore.lastFace.value);
const beast = computed(() => state.value?.endgame?.beast ?? null);

function roll(): void {
  if (fight.value) {
    gameStore.apply({ type: "strike", pid: 0 });
    return;
  }
  gameStore.apply({ type: "roll", pid: 0 });
}
function confirm(): void {
  gameStore.apply({ type: "confirm", pid: 0 });
}
</script>

<template>
  <div class="dock">
    <!-- 海关风云任务条组（T7，抽到「黑市开张」时出现）：报备转让/查验/交卡按可用性点亮 -->
    <CustomsBar />
    <!-- 手牌横滑+抽屉+打牌（T4a2）：dock 固定钮上方的一排情境手牌（含 targeting 任务条） -->
    <HandDock />
    <div id="btnRow">
      <button id="rollBtn" :disabled="!(fight ? canStrike : canRoll)" :class="{ armed: fight ? canStrike : canRoll }" @click="roll">
        <span v-if="fight">🐉<br />砍击</span>
        <span v-else-if="face !== null && rolled">🎲 {{ face }}</span>
        <span v-else>🎲<br />掷骰</span>
      </button>
      <!-- 年兽战况条（T8a2）：非按钮的战况播报位（砍击钮才是动作位；id 与「确认结束」分开=语义各归各） -->
      <div
        v-if="fight"
        id="beastBar"
        :title="`年兽血条 ${beast?.hp}/${beast?.maxHp} · 伤害骰 1d${BEAST_DIE}`"
      >
        <template v-if="dead">☠ 已出局 · 隔岸观火</template>
        <template v-else-if="me?.skipped">😵 本波轮空 · 罚停中</template>
        <template v-else-if="rolled">🪓 已砍 {{ face ?? "" }} · 等队友…</template>
        <template v-else>🐉 第 {{ beast?.wave }} 波 · 年兽 {{ beast?.hp }}/{{ beast?.maxHp }}</template>
      </div>
      <button
        v-else
        id="confirmBtn"
        :class="{ armed: (!!rolled || done) && !confirmed && !dead, waited: confirmed, spectating: dead }"
        :disabled="!acting || confirmed || dead || (!rolled && !done)"
        @click="confirm"
      >
        <template v-if="dead">☠ 已出局 · 观战中</template>
        <template v-else-if="confirmed">⏳ 已确认 · 等待区</template>
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
/* 观战态（T5c）：出局后按钮定格成一排灰—不干扰看戏（观战横幅在 M3） */
#confirmBtn.spectating {
  background: #21262d;
  color: #78909c;
  letter-spacing: 1px;
}
/* 年兽战况条（T8a2）：确认条的位置换作战况播报（非交互位——砍击钮才是动作位） */
#beastBar {
  flex: 1;
  padding: 17px 10px;
  border-radius: 14px;
  background: #4e342e;
  color: #ffccbc;
  font-size: 14.5px;
  font-weight: 800;
  letter-spacing: 0.5px;
  text-align: center;
  user-select: none;
}
#confirmBtn:disabled {
  opacity: 0.85;
}
</style>

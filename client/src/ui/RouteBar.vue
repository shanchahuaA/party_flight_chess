<script setup lang="ts">
/**
 * 选路条（任务槽形态）：走到环岛有多条路时弹出，点选方向；
 * 10 秒超时自动直行（显示剩余秒）。只在真实多条路时出现（ask 才有值）。
 */
import { computed } from "vue";
import { gameStore } from "../game/store";

const state = computed(() => {
  return gameStore.state.value;
});
const ask = computed(() => state.value?.players[0]?.walk?.ask ?? null);

const leftSec = computed(() => {
  void gameStore.beat.value;
  const a = ask.value;
  if (!a) return 0;
  return Math.max(0, Math.ceil((a.deadline - gameStore.now()) / 1000));
});

function choose(i: number): void {
  gameStore.apply({ type: "chooseRoute", pid: 0, option: i });
}
</script>

<template>
  <div v-if="ask" class="routeBar">
    <div class="head">
      <b>🧭 环岛选路</b>
      <span class="cd">{{ leftSec }}s 后自动直行</span>
    </div>
    <div class="opts">
      <button v-for="(o, i) in ask.options" :key="o.to" class="opt" @click="choose(i)">
        {{ o.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.routeBar {
  margin: 4px 10px 2px;
  background: #fff8e1;
  border: 1.5px solid #ffe082;
  color: #6d4c41;
  border-radius: 12px;
  padding: 7px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  animation: taskIn 0.2s ease-out;
}
@keyframes taskIn {
  from {
    transform: translateY(8px);
    opacity: 0;
  }
}
.head {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 84px;
}
.head b {
  font-size: 12.5px;
}
.cd {
  font-size: 10px;
  font-weight: 700;
  color: #bf360c;
}
.opts {
  display: flex;
  gap: 7px;
  flex: 1;
}
.opt {
  flex: 1;
  border: 0;
  background: #ff8a65;
  color: #fff;
  font-size: 13px;
  font-weight: 800;
  border-radius: 10px;
  padding: 12px 6px;
}
.opt:active {
  transform: scale(0.97);
}
</style>

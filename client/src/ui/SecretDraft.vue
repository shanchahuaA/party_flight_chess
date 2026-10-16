<script setup lang="ts">
/** 开局暗牌浮层：抽 2 选 1（真人本人选；drafting 期覆盖游戏页，选完内核开第一窗） */
import { computed, ref } from "vue";
import { secretGoal } from "../../../kernel/src";
import { gameStore } from "../game/store";
import BaseSheet from "./BaseSheet.vue";

/** 裸 create（未选过牌）时真人选项即场景；drafting 且未选状态才弹 */
const pending = computed(() => {
  const s = gameStore.state.value;
  return !!s && s.phase === "drafting" && gameStore.human?.secretPick === null;
});

const picked = ref<number | null>(null);

function choose(i: 0 | 1): void {
  picked.value = i;
}
function confirm(): void {
  if (picked.value === null) return;
  gameStore.apply({ type: "chooseSecret", pid: 0, pick: picked.value });
  picked.value = null;
}
</script>

<template>
  <BaseSheet v-if="pending && gameStore.human" @close="() => {}">
    <div class="wrap">
      <h2>🎯 抽暗牌目标</h2>
      <p class="hint">从 2 条里选 1 条，对局中只有你自己看得见。</p>
      <div class="cards">
        <button
          v-for="(opt, i) in gameStore.human.secretOptions"
          :key="opt"
          type="button"
          class="goal"
          :class="{ on: picked === i }"
          @click="choose(i as 0 | 1)"
        >
          <span class="t">{{ secretGoal(opt).title }}</span>
          <span class="n">{{ secretGoal(opt).note }}</span>
        </button>
      </div>
      <button class="ok" type="button" :disabled="picked === null" @click="confirm">确认目标 · 开局</button>
    </div>
  </BaseSheet>
</template>

<style scoped>
.wrap h2 {
  margin: 0;
  font-size: 16px;
}
.hint {
  margin: 4px 0 10px;
  font-size: 11.5px;
  color: #90a4ae;
}
.cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.goal {
  border: 2px solid #455a64;
  background: #263238;
  color: #eceff1;
  border-radius: 12px;
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  text-align: center;
}
.goal.on {
  border-color: #ef5350;
  background: #37474f;
  box-shadow: 0 0 0 2px rgba(239, 83, 80, 0.3);
}
.t {
  font-size: 14px;
  font-weight: 800;
}
.n {
  font-size: 10.5px;
  color: #b0bec5;
  line-height: 1.45;
}
.ok {
  margin-top: 10px;
  width: 100%;
  border: 0;
  background: #b71c1c;
  color: #fff;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 800;
  padding: 12px;
}
.ok:disabled {
  background: #455a64;
  color: #78909c;
}
</style>

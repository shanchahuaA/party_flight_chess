<script setup lang="ts">
/** 游戏页（M1 T1）：满屏棋盘 + HUD + 选路条 + dock + toast */
import { computed, onBeforeUnmount, onMounted } from "vue";
import BoardSvg from "./board/BoardSvg.vue";
import Dock from "./ui/Dock.vue";
import HudBar from "./ui/HudBar.vue";
import RouteBar from "./ui/RouteBar.vue";
import { ensureBooted, gameStore } from "./game/store";

onMounted(() => {
  ensureBooted();
});
onBeforeUnmount(() => {
  gameStore.dispose();
});

const toast = computed(() => gameStore.toast.value);
</script>

<template>
  <div class="gamePage">
    <HudBar />
    <main class="boardWrap">
      <BoardSvg />
    </main>
    <RouteBar />
    <Dock />
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.gamePage {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #17222c;
}
.boardWrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  overflow: hidden;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: calc(150px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  background: rgba(38, 50, 56, 0.92);
  color: #fff;
  font-size: 12.5px;
  padding: 8px 14px;
  border-radius: 999px;
  z-index: 60;
  max-width: 82vw;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

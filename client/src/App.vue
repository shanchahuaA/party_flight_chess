<script setup lang="ts">
/** 应用壳（M2-T3 起三视图）：home=单机大厅/游戏页 → join=进房页 → room=房间大厅。
 *  单机链路原样（maybeBootFastPath 免大厅直达）；?room= 链接直跳进房页自动填码。 */
import { computed, onBeforeUnmount, onMounted } from "vue";
import { maybeBootFastPath } from "./game/store";
import { bootFromUrl, roomStore } from "./net/roomStore";
import Lobby from "./ui/Lobby.vue";
import JoinPage from "./ui/JoinPage.vue";
import RoomLobby from "./ui/RoomLobby.vue";
import BoardSvg from "./board/BoardSvg.vue";
import Dock from "./ui/Dock.vue";
import HudBar from "./ui/HudBar.vue";
import WorldMessage from "./ui/WorldMessage.vue";
import RouteBar from "./ui/RouteBar.vue";
import SecretDraft from "./ui/SecretDraft.vue";
import CardChoice from "./ui/CardChoice.vue";
import Settlement from "./ui/Settlement.vue";
import { gameStore } from "./game/store";

const view = computed(() => roomStore.view.value);
const started = computed(() => !!gameStore.source.value);
const roomToast = computed(() => roomStore.toast.value);

onMounted(() => {
  bootFromUrl();
  maybeBootFastPath();
});
onBeforeUnmount(() => {
  gameStore.dispose();
});

const toast = computed(() => gameStore.toast.value);
</script>

<template>
  <template v-if="view === 'home'">
    <Lobby v-if="!started" />
    <div v-else class="gamePage">
      <HudBar />
      <WorldMessage />
      <main class="boardWrap">
        <BoardSvg />
      </main>
      <RouteBar />
      <Dock />
      <SecretDraft />
      <CardChoice />
      <Settlement />
      <div v-if="toast" class="toast">{{ toast }}</div>
    </div>
  </template>
  <JoinPage v-else-if="view === 'join'" />
  <RoomLobby v-else />
  <!-- 房间 toast 全局渲染：离房/解散/被顶都伴随视图切换，渲染在页组件里会被卸载吃掉 -->
  <div v-if="roomToast" class="toast">{{ roomToast }}</div>
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
  z-index: 200; /* 错误提示压过一切浮层（抉择卡/战报抽屉之上） */
  max-width: 82vw;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

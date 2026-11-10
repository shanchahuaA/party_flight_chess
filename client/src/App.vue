<script setup lang="ts">
/** 应用壳（M2-T3 起三视图；M2-T6 对局分支）：home=单机大厅/游戏页 → join=进房页 → room=房间大厅。
 *  单机链路原样（maybeBootFastPath 免大厅直达）；?room= 链接直跳进房页自动填码。
 *  room 视图三分支（M2-T6，#43）：phase=lobby→RoomLobby；playing 且无源或 drafting→RoomLobby
 *  （大厅面收口，内嵌暗牌区）；playing（含 over 短窗，即 intermission 快照未到的缓存期）且源
 *  active→gamePage——与 home 复用同一段 board/HUD/dock/浮层模板（同一内联分支，不复制组件）；
 *  intermission 首现=源收摊（roomStore 钩子），视图自动翻回 RoomLobby 局间真形。 */
import { computed, onBeforeUnmount, onMounted } from "vue";
import { maybeBootFastPath } from "./game/store";
import { bindRoomProbe, bootFromUrl, roomStore } from "./net/roomStore";
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
import GuideSheet from "./ui/GuideSheet.vue";
import RecBar from "./ui/RecBar.vue";
import { gameStore } from "./game/store";
import { recLog } from "./net/recLog";

const view = computed(() => roomStore.view.value);
const started = computed(() => !!gameStore.source.value);
/** 测试记录器开闸（?rec=1；与 ?dev=1 互不依赖、可共存） */
const recOn = recLog.on;

/** 房间页的对局画面开闸（M2-T6）：phase=playing 且源活着且有对局面。drafting 期留在大厅
 *  （暗牌浮层内嵌那里）；state over（结算）先到=仍在 gamePage 上展出 Settlement（intermission
 *  快照随后到达即收摊翻页——两条到齐即收敛） */
const roomInGame = computed(() => {
  if (view.value !== "room") return false;
  const snap = roomStore.snapshot.value;
  const s = gameStore.state.value;
  return !!snap && snap.phase === "playing" && !!s && s.phase !== "drafting";
});
const gamePageOn = computed(() => (view.value === "home" && started.value) || roomInGame.value);
/** 观战形态（M3-T5 → #57 / G-06）：自己血尽出局——顶部横幅 + dock 整块消失（不是灰化留位）。
 *  暗牌/帮助/设置三钮仍留在 HUD（淘汰不免除已达成的事实与查看需求）。 */
const spectating = computed(() => !!gameStore.state.value?.players[0]?.dead);
/** gamePage 角落（联机面）：房主解散钮可见判据 */
const amHost = computed(() => roomStore.snapshot.value?.hostSeat === roomStore.mySeat.value);
const roomToast = computed(() => roomStore.toast.value);

onMounted(() => {
  bootFromUrl();
  bindRoomProbe();
  maybeBootFastPath();
});
onBeforeUnmount(() => {
  gameStore.dispose();
});

const toast = computed(() => gameStore.toast.value);
</script>

<template>
  <Lobby v-if="view === 'home' && !gamePageOn" />
  <JoinPage v-else-if="view === 'join'" />
  <RoomLobby v-else-if="view === 'room' && !gamePageOn" />
  <div v-else class="gamePage">
    <HudBar />
    <!-- 观战横幅（M3-T5 → #57 / G-06）：血尽出局后棋盘顶部明确告知「你在观战」，不是卡住 */
    <div v-if="spectating" class="spectateBanner">
      ☠ 观战中——你已血尽出局，可看棋盘与战报，🎯/📖/⚙ 仍可用
    </div>
    <WorldMessage />
    <main class="boardWrap">
      <BoardSvg />
    </main>
    <RouteBar />
    <!-- dock 整块消失（不是灰化留位）+ 手牌消失：观战者不占地盘，棋盘更宽 -->
    <Dock v-if="!spectating" />
    <SecretDraft />
    <CardChoice />
    <!-- 首次引导（M3-T4 → #56 / G-05）：自包含浮层，自动判据在组件内（第一局第一窗掷骰前） -->
    <GuideSheet />
    <Settlement />
    <!-- 联机对局面角落（M2-T8）：对局中 leave 服务端仍封禁（名册 boot 定死）；掉线治理=自动重连
         归队（棋子由系统暂时接管），纸面常识一句——房主解散保有，低调完备 -->
    <div v-if="view === 'room'" class="roomBar">
      <span class="note">对局中不可离席；掉线会自动重连归队（棋子由系统暂管）</span>
      <button v-if="amHost" type="button" @click="roomStore.dissolve()">💥 解散</button>
    </div>
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
  <!-- 房间横幅（M2-T8 全局化）：重连中/重连失败面跟着房间视图走（大厅页与对局面同一个位置断——
       渲在 App 层两页共用，RoomLobby 内不再重画）。有 token=自动重连还在跑，横幅只是状态播报 -->
  <div v-if="view === 'room' && roomStore.banner.value" class="roomBanner">
    <span>{{ roomStore.banner.value }}</span>
    <div class="bannerBtns">
      <button type="button" @click="roomStore.reconnect()">重新连接</button>
      <button type="button" @click="roomStore.backHome()">回首页</button>
    </div>
  </div>
  <!-- 房间 toast 全局渲染：离房/解散/被顶都伴随视图切换，渲染在页组件里会被卸载吃掉 -->
  <div v-if="roomToast" class="toast">{{ roomToast }}</div>
  <!-- 测试记录器悬浮条（M3 #51）：仅 ?rec=1 渲染——不带参数时这里连组件都不存在，零行为差异 -->
  <RecBar v-if="recOn" />
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
/* 观战横幅（M3-T5 → #57 / G-06）：棋盘顶部、HUD 与战报带之间——低饱和暗金，不抢棋盘 */
.spectateBanner {
  flex: 0 0 auto;
  margin: 3px 10px 0;
  padding: 6px 10px;
  background: rgba(74, 58, 18, 0.9);
  border: 1px solid #ffb300;
  border-radius: 10px;
  color: #ffd54f;
  font-size: 11.5px;
  font-weight: 800;
  text-align: center;
  letter-spacing: 0.5px;
}
/* 联机对局角落（M2-T6）：安全阀占位小字+房主解散（低调，不抢戏） */
.roomBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 12px calc(3px + env(safe-area-inset-bottom));
  flex: 0 0 auto;
}
.roomBar .note {
  font-size: 10px;
  color: #546e7a;
}
/* 房间断线横幅（M2-T8 全局化）：置顶醒目、两按钮同 RoomLobby 旧形态 */
.roomBanner {
  position: fixed;
  top: calc(8px + env(safe-area-inset-top));
  left: 12px;
  right: 12px;
  z-index: 220;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: #4e342e;
  border: 1px solid #bf360c;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 12.5px;
  color: #ffe0b2;
}
.roomBanner .bannerBtns {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}
.roomBanner .bannerBtns button {
  border: 1px solid #8d6e63;
  background: #3e2723;
  color: #ffe0b2;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 700;
}
.roomBar button {
  border: 1px solid #8e2418;
  background: rgba(142, 36, 24, 0.35);
  color: #ef9a9a;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 700;
  padding: 3px 10px;
  flex: 0 0 auto;
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

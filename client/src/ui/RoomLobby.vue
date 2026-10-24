<script setup lang="ts">
/**
 * 房间大厅（M2-T3 最小形态，#40）：房间码+邀请链接、座位互见（昵称/在线/房主）、离房/解散。
 * T4 大厅真形态在此页上接角色明选/暗牌/房主配置/开始按钮；对局开局接线在 T5/T6。
 */
import { computed } from "vue";
import { roomStore } from "../net/roomStore";
import { MAX_SEATS } from "../../../shared/protocol";

const snap = computed(() => roomStore.snapshot.value);
const amHost = computed(() => snap.value?.hostSeat === roomStore.mySeat.value);
const emptySeats = computed(() => (snap.value ? MAX_SEATS - snap.value.seats.length : 0));

function isMe(seat: number): boolean {
  return seat === roomStore.mySeat.value;
}
</script>

<template>
  <div class="roomLobby">
    <header class="head">
      <h1>🛖 房间大厅</h1>
      <p class="sub">人齐了房主就能开局（开局按钮在 T4 接上）</p>
    </header>

    <div v-if="roomStore.banner.value" class="banner">
      <span>{{ roomStore.banner.value }}</span>
      <div class="bannerBtns">
        <button type="button" @click="roomStore.reconnect()">重新连接</button>
        <button type="button" @click="roomStore.backHome()">回首页</button>
      </div>
    </div>

    <section class="card">
      <h2>📡 房间码</h2>
      <div class="codeRow">
        <span class="code">{{ roomStore.code.value }}</span>
        <button class="copy" type="button" @click="roomStore.copyInvite()">📋 复制邀请链接</button>
      </div>
      <p class="hint">朋友输码进房，或点链接直达（码已自动填好）。</p>
    </section>

    <section class="card">
      <h2>🪑 座位（{{ snap?.seats.length ?? 0 }}/{{ MAX_SEATS }}）</h2>
      <ul class="seats">
        <li v-for="s in snap?.seats ?? []" :key="s.seat" :class="{ off: !s.online }">
          <span class="no">{{ s.seat + 1 }}</span>
          <span class="name">{{ s.name }}<i v-if="isMe(s.seat)" class="me">（你）</i></span>
          <span v-if="s.host" class="crown">👑 房主</span>
          <span class="dot" :class="{ on: s.online }">{{ s.online ? "在线" : "离线" }}</span>
        </li>
      </ul>
      <p v-if="emptySeats > 0" class="hint">还差 {{ emptySeats }} 人到满座；离线的朋友随时凭原身份回来。</p>
    </section>

    <footer class="foot">
      <button v-if="amHost" class="danger" type="button" @click="roomStore.dissolve()">💥 解散房间</button>
      <button class="ghost" type="button" @click="roomStore.leave()">🚪 离房</button>
    </footer>
  </div>
</template>

<style scoped>
.roomLobby {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: calc(12px + env(safe-area-inset-top)) 12px calc(14px + env(safe-area-inset-bottom));
  background: #17222c;
  color: #eceff1;
}
.head h1 {
  font-size: 20px;
  margin: 4px 0 2px;
}
.sub {
  font-size: 11.5px;
  color: #b0bec5;
  margin: 0;
}
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: #4e342e;
  border: 1px solid #bf360c;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 12.5px;
}
.bannerBtns {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}
.bannerBtns button {
  border: 1px solid #8d6e63;
  background: #3e2723;
  color: #ffe0b2;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 700;
}
.card {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(176, 190, 197, 0.25);
  border-radius: 14px;
  padding: 10px 12px 12px;
}
.card h2 {
  font-size: 13.5px;
  margin: 0 0 8px;
}
.codeRow {
  display: flex;
  align-items: center;
  gap: 10px;
}
.code {
  font-size: 24px;
  font-weight: 900;
  letter-spacing: 0.25em;
  background: #263238;
  border: 1px dashed #78909c;
  border-radius: 10px;
  padding: 6px 10px 6px 14px;
}
.copy {
  border: 1px solid #455a64;
  background: #263238;
  color: #cfd8dc;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 12.5px;
  font-weight: 700;
}
.hint {
  font-size: 11px;
  color: #90a4ae;
  margin: 8px 0 0;
}
.seats {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.seats li {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #263238;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 13px;
}
.seats li.off {
  opacity: 0.55;
}
.no {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  background: #37474f;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 800;
  color: #b0bec5;
}
.name {
  flex: 1;
  font-weight: 700;
}
.me {
  font-style: normal;
  font-size: 11px;
  color: #ffb74d;
}
.crown {
  font-size: 11.5px;
  color: #ffd54f;
}
.dot {
  font-size: 10.5px;
  color: #90a4ae;
}
.dot.on {
  color: #81c784;
}
.foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 6px;
}
.danger {
  border: 0;
  border-radius: 12px;
  background: #8e2418;
  color: #ffebee;
  font-size: 14px;
  font-weight: 800;
  padding: 12px;
}
.ghost {
  border: 1px solid #455a64;
  background: #263238;
  color: #cfd8dc;
  border-radius: 12px;
  padding: 11px;
  font-size: 13.5px;
  font-weight: 700;
}
</style>

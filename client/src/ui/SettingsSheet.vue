<script setup lang="ts">
/**
 * 局中设置浮层（M3-T3，#55 / G-04；M3-T6，#58 补成员管理 + 二次确认）：HUD `⚙` 打开。
 *
 * 四件事（节显隐判据在 `game/settingsPanel.ts`，成员行判据在 `game/members.ts`——本组件只照单渲染）：
 * ① 🔊 音效开关——接 T2 的 `audio/shell.ts`（`sfxUi` / `enableSfx`），**不自己读 localStorage**
 * ② 📳 震动开关——同上（`enableVibrate`）；设备不支持 `navigator.vibrate` 时**整行隐藏**
 * ③ 房主（仅房间页）见「👥 成员管理」——真人逐行列出，「请出」走 `ConfirmSheet` 二次确认（G-07）；
 *    **假人行没有「请出」钮**（假人没有身份可拉黑，服务端也直接拒）
 * ④ 房主（仅房间页）见「💥 解散房间」——同样先二次确认（复核 #55 的误触面）
 *
 * 待解锁（G-17）：`sfxUi.needsUnlock` 且音效开着时出可点的「开启音效」，不许静默失败。
 * 数值冻结：**本面板不出现任何数值配置**（无滑条 / 无下拉 / 无配置面板组件）。
 * 动效红线：不带动画（本文件在 `motionRedline.test.ts` 的朴素区名单里）。
 */
import { computed, ref } from "vue";
import { enableSfx, enableVibrate, sfxUi, unlockSfx } from "../audio/shell";
import { roomStore } from "../net/roomStore";
import { settingsSections } from "../game/settingsPanel";
import { iAmHost, memberRows, seatsOf } from "../game/members";
import { dissolvePrompt, kickPrompt, type KickTarget } from "../game/confirm";
import { useConfirm, useDissolveConfirm } from "../game/useConfirm";
import BaseSheet from "./BaseSheet.vue";
import ConfirmSheet from "./ConfirmSheet.vue";

const emit = defineEmits<{ close: [] }>();

/** 联机房间页（单机对局没有成员管理/解散的概念） */
const inRoom = computed(() => roomStore.view.value === "room" && roomStore.code.value != null);
/** 房主判据：吃 `game/members` 的唯一真源（与成员行 canKick 同口径，不在此另写一份） */
const amHost = computed(() =>
  iAmHost(roomStore.mySeat.value, roomStore.snapshot.value?.hostSeat ?? null),
);

const sections = computed(() =>
  settingsSections({
    inRoom: inRoom.value,
    host: amHost.value,
    canVibrate: sfxUi.canVibrate,
    needsUnlock: sfxUi.needsUnlock,
    sfxEnabled: sfxUi.enabled,
  }),
);

/** 成员行（判据全在 game/members：假人/自己不出「请出」钮，非房主整表不可请出） */
const members = computed(() =>
  memberRows({
    seats: seatsOf(roomStore.snapshot.value?.seats ?? []),
    mySeat: roomStore.mySeat.value,
    hostSeat: roomStore.snapshot.value?.hostSeat ?? null,
  }),
);

/** 解锁失败的一句回话（不静默失败：告诉玩家再点一次即可） */
const unlockMsg = ref<string | null>(null);

function toggleSfx(): void {
  enableSfx(!sfxUi.enabled);
  unlockMsg.value = null;
}

function toggleVibrate(): void {
  enableVibrate(!sfxUi.vibrateOn);
}

async function tryUnlock(): Promise<void> {
  const ok = await unlockSfx();
  unlockMsg.value = ok ? null : "浏览器还没允许出声——再点一次「开启音效」";
}

/** 请出（G-07）：点「请出」**只开确认浮层**，确认后才发 kick（状态机住 game/confirm） */
const {
  pending: kickPending,
  ask: askKick,
  confirm: confirmKick,
  cancel: cancelKick,
} = useConfirm<KickTarget>((t) => roomStore.kick(t.seat));

/** 解散（复核 #55）：同样先二次确认——代价是解散全房
 *  （薄封装 `useDissolveConfirm`，与大厅页脚/对局面角落同一份） */
const {
  pending: dissolvePending,
  ask: askDissolve,
  confirm: confirmDissolve,
  cancel: cancelDissolve,
} = useDissolveConfirm(() => {
  emit("close");
  roomStore.dissolve();
});
</script>

<template>
  <BaseSheet @close="$emit('close')">
    <div class="setSheet">
      <h3>⚙ 设置</h3>
      <p class="hint">对局中只放展示类开关；数值局中冻结，改配置请回大厅/结算页。</p>

      <button
        v-if="sections.sfx"
        class="row"
        type="button"
        role="switch"
        :aria-checked="sfxUi.enabled"
        data-set="sfx"
        @click="toggleSfx"
      >
        <span class="lab">🔊 音效</span>
        <span class="sw" :class="{ on: sfxUi.enabled }"><i /></span>
      </button>

      <button
        v-if="sections.vibrate"
        class="row"
        type="button"
        role="switch"
        :aria-checked="sfxUi.vibrateOn"
        data-set="vibrate"
        @click="toggleVibrate"
      >
        <span class="lab">📳 震动</span>
        <span class="sw" :class="{ on: sfxUi.vibrateOn }"><i /></span>
      </button>

      <div v-if="sections.unlockHint" class="unlockBox">
        <p class="unlockNote">浏览器还没解锁声音——点一下按钮即可（需在你的手势里）。</p>
        <button class="unlock" type="button" data-set="unlock" @click="tryUnlock">开启音效</button>
        <p v-if="unlockMsg" class="unlockErr">{{ unlockMsg }}</p>
      </div>

      <section v-if="sections.members" class="sec" data-set="members">
        <h4>👥 成员管理</h4>
        <ul class="memList">
          <li v-for="m in members" :key="m.seat" :class="{ off: !m.bot && !m.online }">
            <span class="no">{{ m.seat + 1 }}</span>
            <span class="nm">{{ m.name }}<i v-if="m.me" class="me">（你）</i></span>
            <span v-if="m.host" class="crown">👑</span>
            <span v-if="m.bot" class="tag bot">🤖 假人</span>
            <span v-else class="tag" :class="{ on: m.online }">{{ m.online ? "在线" : "离线" }}</span>
            <!-- 假人不给「请出」钮；自己也不给（判据在 game/members，模板不重复判） -->
            <button
              v-if="m.canKick"
              class="kick"
              type="button"
              :data-kick-seat="m.seat"
              :title="`请出 ${m.name}`"
              @click="askKick(m)"
            >请出</button>
          </li>
        </ul>
        <p v-if="!members.length" class="hint">座位列还没到——稍等快照。</p>
      </section>

      <button v-if="sections.dissolve" class="danger" type="button" data-set="dissolve" @click="askDissolve">
        💥 解散房间
      </button>

      <button class="close" type="button" @click="$emit('close')">收 起</button>
    </div>
  </BaseSheet>

  <!-- 请出二次确认（G-07）：与大厅 🥾 同一形态、同一个状态机。
       刻意做成 BaseSheet 的**兄弟**而非其子节点：设置面板自己是可滚动浮层（overflow-y: auto），
       确认层叠在里面会受父级滚动容器/堆叠上下文牵连；同层兄弟在文档序上天然压住面板。 -->
  <ConfirmSheet
    v-if="kickPending"
    title="请出成员"
    :message="kickPrompt(kickPending.name)"
    confirm-text="请出"
    @confirm="confirmKick"
    @cancel="cancelKick"
  />
  <!-- 解散二次确认（复核 #55）：页底那颗钮点错=全房解散 -->
  <ConfirmSheet
    v-if="dissolvePending"
    title="解散房间"
    :message="dissolvePrompt()"
    confirm-text="解散"
    @confirm="confirmDissolve"
    @cancel="cancelDissolve"
  />
</template>

<style scoped>
.setSheet {
  color: #eceff1;
}
.setSheet h3 {
  margin: 0 0 3px;
  font-size: 15.5px;
}
.hint {
  margin: 0 0 10px;
  font-size: 11px;
  color: #90a4ae;
  line-height: 1.5;
}
/* 开关行：整行可点，右侧滑动块；无过渡（朴素呈现） */
.row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: #263238;
  border: 1px solid #37474f;
  border-radius: 12px;
  padding: 11px 12px;
  margin-bottom: 8px;
  color: #eceff1;
  font-size: 13.5px;
  font-weight: 700;
  text-align: left;
}
.row .sw {
  flex: 0 0 auto;
  width: 42px;
  height: 24px;
  border-radius: 999px;
  background: #455a64;
  padding: 3px;
  display: flex;
  align-items: center;
}
.row .sw i {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #cfd8dc;
}
.row .sw.on {
  background: #26a69a;
  justify-content: flex-end;
}
.row .sw.on i {
  background: #fff;
}
.unlockBox {
  background: #33291a;
  border: 1px solid #ffb300;
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.unlockNote {
  margin: 0 0 8px;
  font-size: 11.5px;
  color: #ffe0b2;
  line-height: 1.5;
}
.unlock {
  width: 100%;
  border: 0;
  border-radius: 10px;
  background: #ffb300;
  color: #3e2723;
  font-size: 13px;
  font-weight: 800;
  padding: 9px;
}
.unlockErr {
  margin: 7px 0 0;
  font-size: 11px;
  color: #ffcc80;
}
.sec {
  background: #263238;
  border: 1px solid #37474f;
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.sec h4 {
  margin: 0 0 6px;
  font-size: 13px;
  color: #e0f7fa;
}
.sec .hint {
  margin: 0;
}
/* 成员行（#58）：名字 + 在线态 + 行尾「请出」；假人/自己的行没有钮 */
.memList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.memList li {
  display: flex;
  align-items: center;
  gap: 7px;
  background: #1c2933;
  border-radius: 9px;
  padding: 6px 8px;
  font-size: 12.5px;
  min-height: 30px;
}
.memList li.off {
  opacity: 0.6;
}
.no {
  flex: 0 0 auto;
  width: 19px;
  height: 19px;
  display: grid;
  place-items: center;
  background: #37474f;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 800;
  color: #b0bec5;
}
.nm {
  flex: 1;
  min-width: 0;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nm .me {
  font-style: normal;
  font-size: 10.5px;
  color: #ffb74d;
}
.crown {
  flex: 0 0 auto;
  font-size: 11px;
}
.tag {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: #90a4ae;
}
.tag.on {
  color: #81c784;
}
.tag.bot {
  color: #81d4fa;
}
.kick {
  flex: 0 0 auto;
  border: 1px solid #8e2418;
  background: rgba(142, 36, 24, 0.25);
  color: #ef9a9a;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11.5px;
  font-weight: 800;
}
.danger {
  width: 100%;
  border: 1px solid #8e2418;
  background: rgba(142, 36, 24, 0.35);
  color: #ef9a9a;
  border-radius: 12px;
  padding: 11px;
  font-size: 13px;
  font-weight: 800;
  margin-bottom: 8px;
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

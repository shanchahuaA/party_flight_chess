<script setup lang="ts">
/**
 * 局中设置浮层（M3-T3，#55 / G-04）：HUD `⚙` 打开。
 *
 * 四件事（判据全在 `game/settingsPanel.ts`，本组件只照单渲染）：
 * ① 🔊 音效开关——接 T2 的 `audio/shell.ts`（`sfxUi` / `enableSfx`），**不自己读 localStorage**
 * ② 📳 震动开关——同上（`enableVibrate`）；设备不支持 `navigator.vibrate` 时**整行隐藏**
 * ③ 房主（仅房间页）见「👥 成员管理」节骨架——内容归 #58，本票只立标题与显隐
 * ④ 房主（仅房间页）见「💥 解散房间」——`roomStore.dissolve()`
 *
 * 待解锁（G-17）：`sfxUi.needsUnlock` 且音效开着时出可点的「开启音效」，不许静默失败。
 * 数值冻结：**本面板不出现任何数值配置**（无滑条 / 无下拉 / 无配置面板组件）。
 * 动效红线：不带动画（本文件在 `motionRedline.test.ts` 的朴素区名单里）。
 */
import { computed, ref } from "vue";
import { enableSfx, enableVibrate, sfxUi, unlockSfx } from "../audio/shell";
import { roomStore } from "../net/roomStore";
import { settingsSections } from "../game/settingsPanel";
import BaseSheet from "./BaseSheet.vue";

const emit = defineEmits<{ close: [] }>();

/** 联机房间页（单机对局没有成员管理/解散的概念） */
const inRoom = computed(() => roomStore.view.value === "room" && roomStore.code.value != null);
/** 房主判据：座位号可比且相等（mySeat 未定/快照未到时一律非房主，避免 null===null） */
const amHost = computed(() => {
  const snap = roomStore.snapshot.value;
  const mine = roomStore.mySeat.value;
  return !!snap && mine != null && snap.hostSeat === mine;
});

const sections = computed(() =>
  settingsSections({
    inRoom: inRoom.value,
    host: amHost.value,
    canVibrate: sfxUi.canVibrate,
    needsUnlock: sfxUi.needsUnlock,
    sfxEnabled: sfxUi.enabled,
    vibrateOn: sfxUi.vibrateOn,
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

function dissolve(): void {
  emit("close");
  roomStore.dissolve();
}
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
        <p class="hint">成员列表与请出操作见下一版（中局踢人在 #58 落地）。</p>
      </section>

      <button v-if="sections.dissolve" class="danger" type="button" data-set="dissolve" @click="dissolve">
        💥 解散房间
      </button>

      <button class="close" type="button" @click="$emit('close')">收 起</button>
    </div>
  </BaseSheet>
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
  margin: 0 0 4px;
  font-size: 13px;
  color: #e0f7fa;
}
.sec .hint {
  margin: 0;
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

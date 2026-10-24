<script setup lang="ts">
/**
 * 进房页真形态（M2-T3，#40；界面呈现定案 §一）：
 * - 加入模式：房间码（链接 ?room= 直跳自动填）+ 昵称 → 进房拿座位。
 * - 创建模式：只填昵称 → 创建即得房间码与分享链接（创建者=房主=座位 0）。
 * - 本机存过 token（pfc.token.<码>）则静默归队：刷新/断线免重输，直接回房间大厅。
 */
import { computed, onMounted, ref } from "vue";
import { loadNickname, roomStore } from "../net/roomStore";

const isCreate = computed(() => roomStore.joinMode.value === "create");
const prefill = computed(() => roomStore.pendingCode.value ?? "");

const code = ref(prefill.value);
const nick = ref(loadNickname());
const busy = ref(false);
/** 凭 token 静默归队中（免重输通路的过渡态） */
const resuming = ref(false);

onMounted(() => {
  if (isCreate.value || !prefill.value) return;
  resuming.value = true;
  void roomStore.resumeWithToken(prefill.value).then((ok) => {
    resuming.value = false;
    if (ok) roomStore.view.value = "room";
    // 归队失败（房间没了/token 失效）：token 已被清，留在表单正常走输入流程
  });
});

function submit(): void {
  const name = nick.value.trim();
  if (!name) {
    roomStore.joinError.value = "先给自己起个昵称";
    return;
  }
  if (isCreate.value) {
    busy.value = true;
    void roomStore.createRoom(name).finally(() => (busy.value = false));
    return;
  }
  const c = code.value.trim().toUpperCase();
  if (!c) {
    roomStore.joinError.value = "填一下房间码（或点分享链接直达）";
    return;
  }
  busy.value = true;
  void roomStore.joinRoom(c, name).finally(() => (busy.value = false));
}
</script>

<template>
  <div class="joinPage">
    <header class="head">
      <h1>🏮 庄园法会 · 进房</h1>
      <p class="sub">{{ isCreate ? "创建房间后把邀请链接发给朋友" : "输房间码或点朋友的分享链接" }}</p>
    </header>

    <section class="card">
      <label v-if="!isCreate" class="field">
        <span class="lab">房间码</span>
        <input
          v-model="code"
          class="codeInput"
          type="text"
          inputmode="text"
          autocapitalize="characters"
          autocomplete="off"
          maxlength="5"
          placeholder="如 K7M2X"
          :disabled="resuming || busy"
          @input="code = code.toUpperCase()"
        />
      </label>
      <label class="field">
        <span class="lab">你的昵称</span>
        <input v-model="nick" type="text" maxlength="12" placeholder="最多 12 字" :disabled="resuming || busy" />
      </label>
      <p v-if="roomStore.joinError.value" class="err">{{ roomStore.joinError.value }}</p>
      <button class="primary" type="button" :disabled="resuming || busy" @click="submit">
        {{ resuming ? "正在回到房间…" : busy ? "请稍候…" : isCreate ? "🏮 创建房间" : "🚪 加入房间" }}
      </button>
    </section>

    <footer class="foot">
      <button class="ghost" type="button" @click="roomStore.backHome()">← 回首页</button>
    </footer>
  </div>
</template>

<style scoped>
.joinPage {
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
.card {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(176, 190, 197, 0.25);
  border-radius: 14px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
.lab {
  width: 64px;
  flex: 0 0 auto;
  color: #cfd8dc;
}
input {
  flex: 1;
  background: #263238;
  color: #eceff1;
  border: 1px solid #455a64;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 15px;
}
.codeInput {
  letter-spacing: 0.2em;
  text-transform: uppercase;
  font-weight: 800;
}
.err {
  margin: 0;
  font-size: 12px;
  color: #ef9a9a;
}
.primary {
  border: 0;
  border-radius: 12px;
  background: #b71c1c;
  color: #fff;
  font-size: 15px;
  font-weight: 800;
  padding: 13px;
  box-shadow: 0 3px 10px rgba(183, 28, 28, 0.45);
}
.primary:disabled {
  opacity: 0.55;
}
.foot {
  margin-top: auto;
  padding-top: 6px;
}
.ghost {
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

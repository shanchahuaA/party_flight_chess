<script setup lang="ts">
/**
 * 首次引导浮层（M3-T4，#56 / G-05）：第一局第一窗掷骰前自动弹 3 步。
 * 状态机与降级口径全在 game/guide.ts（`stepGuide` + `useGuide` 薄适配）；本组件只管渲染 +
 * 转发「跳过 / 下一步 / 开始游戏」。
 * 两个入口：①自动（第一局第一窗掷骰前）②大厅页脚「📖 规则速查」重看（gameStore.guideReq）。
 * 出口三态：**跳过 / 走完**写 `pfc.guide.seen`（本设备之后不再自动弹）；
 * **让位**（玩家主动点开 📖/⚙，gameStore.guideDismiss）只收起浮层、不写 seen——本局不再自动弹，
 * 换新局若仍未看过照常弹（视觉拍板 B：玩家主动点开的浮层优先）。
 */
import { computed, watch } from "vue";
import { gameStore } from "../game/store";
import { GUIDE_STEPS, guideSeen, shouldShowGuide } from "../game/guide";
import { useGuide } from "../game/useGuide";

const store = (() => {
  try {
    return localStorage;
  } catch {
    return null;
  }
})();

const guide = useGuide(store);
const open = guide.open;
const step = guide.step;

/** 自动弹条件：第一局第一窗 + 轮到我 + 掷骰前 + 本设备没看过（两闸与去抖由状态机管） */
const autoReady = computed(() => {
  const s = gameStore.state.value;
  if (!s) return false;
  return shouldShowGuide({
    seen: guideSeen(store),
    phase: s.phase,
    turn: s.turn,
    turnActor: s.turnActor ?? null,
    rolled: !!s.players[0]?.rolled,
    confirmed: !!s.players[0]?.confirmed,
    dead: !!s.players[0]?.dead,
    zone: s.players[0]?.zone ?? "main",
  });
});

function maybeAutoOpen(): void {
  if (autoReady.value) guide.autoOpen();
}

watch(
  autoReady,
  (v) => {
    if (v) maybeAutoOpen();
  },
  { immediate: true },
);

// 重看入口（大厅页脚「📖 规则速查」）：与自动弹同一份内容，不受 seen 闸限制
watch(
  () => gameStore.guideReq.value,
  () => {
    if (gameStore.guideReq.value === 0) return;
    guide.reopen();
  },
);

// 让位入口（视觉拍板 B）：玩家主动点开 📖 帮助 / ⚙ 设置 -> 引导先收起。
// 收起≠跳过：不写 seen，但本局不再自动弹（否则 autoReady 仍成立会立刻弹回来）。
watch(
  () => gameStore.guideDismiss.value,
  () => {
    if (gameStore.guideDismiss.value === 0) return;
    guide.close();
  },
);

/** 换局（数据源换体）：自动弹闸重置——新局若仍未看过，第一窗再弹一次 */
watch(
  () => gameStore.source.value,
  () => {
    guide.reset();
    // reset 只松闸；autoReady 读数可能没变（computed 不会因此重算触发 watcher），
    // 这里显式补判一次，保证「换新局后仍未看过 → 第一窗照常弹」不依赖状态抖动。
    maybeAutoOpen();
  },
);

const cur = computed(() => GUIDE_STEPS[Math.min(step.value, GUIDE_STEPS.length - 1)]!);
const isLast = computed(() => step.value >= GUIDE_STEPS.length - 1);
</script>

<template>
  <div v-if="open" class="guideOverlay" @click.self="guide.skip">
    <div class="guideCard">
      <header class="gHead">
        <span class="dots">
          <i v-for="(_, i) in GUIDE_STEPS" :key="i" :class="{ on: i === step }" />
        </span>
        <button class="skip" type="button" @click="guide.skip">跳过</button>
      </header>
      <div class="gBody">
        <span class="gIcon">{{ cur.icon }}</span>
        <h3>{{ cur.title }}</h3>
        <p>{{ cur.body }}</p>
      </div>
      <button class="next" type="button" @click="guide.next">{{ isLast ? "开始游戏" : "下一步" }}</button>
    </div>
  </div>
</template>

<style scoped>
.guideOverlay {
  position: fixed;
  inset: 0;
  z-index: 96; /* 抉择卡(95)之上——新手引导优先；toast(200)仍压过它 */
  background: rgba(13, 20, 26, 0.78);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
}
.guideCard {
  width: min(88vw, 340px);
  background: linear-gradient(160deg, #2c3e4d, #263238);
  border: 2px solid #4dd0e1;
  border-radius: 16px;
  padding: 14px 15px calc(15px + env(safe-area-inset-bottom));
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
}
.gHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.dots {
  display: flex;
  gap: 5px;
}
.dots i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #455a64;
}
.dots i.on {
  background: #4dd0e1;
}
.skip {
  border: 0;
  background: transparent;
  color: #90a4ae;
  font-size: 12px;
  padding: 4px 6px;
  text-decoration: underline dotted;
}
.gBody {
  padding: 10px 2px 14px;
}
.gIcon {
  font-size: 34px;
  display: block;
  line-height: 1.1;
  text-align: center;
}
.gBody h3 {
  margin: 7px 0 6px;
  font-size: 17px;
  color: #e0f7fa;
  letter-spacing: 0.5px;
  text-align: center;
}
.gBody p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: #b0bec5;
}
.next {
  width: 100%;
  border: 0;
  border-radius: 12px;
  background: #00838f;
  color: #fff;
  font-size: 14.5px;
  font-weight: 800;
  padding: 12px;
  box-shadow: 0 3px 10px rgba(0, 131, 143, 0.4);
}
</style>

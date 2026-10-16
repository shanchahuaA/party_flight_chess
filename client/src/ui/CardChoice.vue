<script setup lang="ts">
/**
 * 中央抉择卡牌浮层（界面呈现定案 K2 实玩定案）：抉择卡只弹给触发者本人（单机=真人 pid 0），
 * 点选项即向内核提交 chooseCard 意图；倒计时尽/超窗收口由内核按默认项代选并在战报标「(代选)」。
 * 可收起（不出牌、继续看场面）；收起后留一枚再开小钩，挂起未应答不锁 dock 操作。
 * 卡面=几何+emoji 占位（春节怪谈×庄园文案皮随 T3b 落数补）；选项效果给 DSL 投影的机械提示。
 * 层次口径：暗牌/战报抽屉等 BaseSheet=90 < 抉择浮层=95 < 错误 toast=200。
 */
import { computed, ref, watch } from "vue";
import { AXIS_NAMES, EVENT_CARD_BY_ID, type CardEffect, type EventCard } from "../../../kernel/src";
import { gameStore } from "../game/store";

const pend = computed(() => gameStore.human?.cardPending ?? null);
const card = computed<EventCard | null>(() => (pend.value ? (EVENT_CARD_BY_ID.get(pend.value.cardId) ?? null) : null));

const folded = ref(false);
watch(
  () => pend.value?.cardId,
  () => {
    folded.value = false; // 新卡挂起 → 浮层弹起
  },
);

/** 倒计时按当前秒重算：beat 心跳驱动逐秒刷新（deadline 是内核发的时间戳） */
const leftSec = computed(() => {
  void gameStore.beat.value;
  const p = pend.value;
  if (!p) return 0;
  return Math.max(0, Math.ceil((p.deadline - gameStore.now()) / 1000));
});

function choose(i: number): void {
  gameStore.apply({ type: "chooseCard", pid: 0, option: i });
}

/** 选项效果速览：EffectPart DSL 的一行投影（机械真话；文案皮 T3b 再补） */
function digest(eff: CardEffect): string {
  const segs: string[] = [];
  for (const p of eff.self ?? []) {
    if (p.type === "move") segs.push(`前进 ${p.v}`);
    else if (p.type === "back") segs.push(`退 ${p.v}`);
    else if (p.type === "hp") segs.push(p.v > 0 ? `❤+${p.v}` : `❤${p.v}`);
    else if (p.type === "drawItem") segs.push(`🎁${p.v}`);
    else if (p.type === "skip") segs.push(`✋ 罚停 ${p.v} 回合`);
    else if (p.type === "trial") segs.push("再抽一张");
    else if (p.type === "check") {
      const axisName = p.spec.axis ? AXIS_NAMES[p.spec.axis] : "前途骰";
      segs.push(p.spec.dc != null ? `🎲 ${axisName}·DC${p.spec.dc}` : `🎲 ${axisName}`);
    }
  }
  for (const t of eff.others ?? []) segs.push(t.target === "all" ? "指向全员" : "指向他人");
  return segs.join("、") || "原地待命";
}
</script>

<template>
  <div v-if="card && pend && !folded" class="choiceOverlay" @click.self="folded = true">
    <div class="card">
      <div class="head">
        <span class="tag">🃏 事件 · 第 {{ card.no }} 张</span>
        <span v-if="card.gamble" class="tagGamble">🐶 赌狗时刻</span>
        <button class="fold" type="button" aria-label="收起卡面（稍后再选）" @click="folded = true">✕</button>
      </div>
      <h3 class="title">{{ card.title }}</h3>
      <p class="flavor">{{ card.flavor }}</p>
      <div class="opts">
        <button v-for="(o, i) in card.options" :key="i" type="button" class="opt" @click="choose(i)">
          <span class="lab">{{ o.label }}</span>
          <span class="dgt">{{ digest(o.effect) }}</span>
        </button>
      </div>
      <p class="cd">⏳ {{ leftSec }}s 后未选，按默认项代选</p>
    </div>
  </div>
  <button v-else-if="card && pend && folded" class="reopen" type="button" @click="folded = false">
    🃏 待抉择 · {{ leftSec }}s
  </button>
</template>

<style scoped>
.choiceOverlay {
  position: fixed;
  inset: 0;
  z-index: 95;
  background: rgba(13, 20, 26, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fade 0.18s ease-out;
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
.card {
  width: min(86vw, 330px);
  max-height: 84vh;
  overflow-y: auto;
  background: linear-gradient(160deg, #2c3e4d, #263238);
  border: 2px solid #ffab40;
  border-radius: 16px;
  padding: 13px 14px calc(16px + env(safe-area-inset-bottom));
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
  animation: pop 0.2s ease-out;
}
@keyframes pop {
  from {
    transform: scale(0.92);
    opacity: 0;
  }
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tag {
  font-size: 10.5px;
  font-weight: 800;
  color: #ffcc80;
  letter-spacing: 0.5px;
}
.tagGamble {
  font-size: 10.5px;
  font-weight: 800;
  color: #ef5350;
  background: rgba(239, 83, 80, 0.12);
  border-radius: 999px;
  padding: 2px 7px;
}
.fold {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: #90a4ae;
  font-size: 15px;
  padding: 2px 6px;
  cursor: pointer;
}
.title {
  margin: 7px 0 3px;
  font-size: 19px;
  color: #ffe0b2;
  letter-spacing: 1px;
}
.flavor {
  margin: 0 0 12px;
  font-size: 12px;
  font-style: italic;
  color: #b0bec5;
  line-height: 1.55;
}
.opts {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.opt {
  border: 1.5px solid #ffab40;
  background: rgba(255, 171, 64, 0.09);
  color: #eceff1;
  border-radius: 12px;
  padding: 11px 12px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 3px;
  cursor: pointer;
}
.opt:active {
  transform: scale(0.98);
}
.opt .lab {
  font-size: 14.5px;
  font-weight: 800;
}
.opt .dgt {
  font-size: 11px;
  color: #ffcc80;
}
.cd {
  margin: 12px 0 0;
  font-size: 10.5px;
  color: #78909c;
  text-align: center;
}
/* 收起后的再开小钩：dock 上方情境任务条位（按任务槽收口，不做抽屉形态） */
.reopen {
  position: fixed;
  right: 10px;
  bottom: calc(126px + env(safe-area-inset-bottom));
  z-index: 85;
  border: 1.5px solid #ffab40;
  background: #263238;
  color: #ffcc80;
  font-size: 12px;
  font-weight: 800;
  border-radius: 999px;
  padding: 8px 13px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  animation: fade 0.2s ease-out;
}
</style>

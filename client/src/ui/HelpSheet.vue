<script setup lang="ts">
/**
 * 帮助速查浮层（M3-T3，#55 / G-03）：HUD `📖` 打开，一屏读完的六块规则速查。
 *
 * 口径：
 * - 统一走 `BaseSheet`（浮层原则 T-01：查看类操作不切页、不重拉数据）。
 * - 六块文案住 `game/help.ts`（纯数据、Node 可测）——本组件只管渲染，不改口径。
 * - 不配图（emoji 顶）；不带动画（动效红线 T-05，`motionRedline.test.ts` 把本文件当朴素区守）。
 * - 首屏一屏读完，超出可上滑（BaseSheet 的 `.sheet` 自带 `overflow-y:auto`）。
 */
import { HELP_BLOCKS } from "../game/help";
import BaseSheet from "./BaseSheet.vue";

defineEmits<{ close: [] }>();
</script>

<template>
  <BaseSheet @close="$emit('close')">
    <div class="helpSheet">
      <h3>📖 规则速查</h3>
      <section v-for="b in HELP_BLOCKS" :key="b.id" class="blk" :data-hb="b.id">
        <h4>{{ b.title }}</h4>
        <p v-for="(line, i) in b.lines" :key="i">{{ line }}</p>
      </section>
      <button class="close" type="button" @click="$emit('close')">收 起</button>
    </div>
  </BaseSheet>
</template>

<style scoped>
.helpSheet {
  color: #eceff1;
}
.helpSheet h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
/* 六块：紧凑两行制，块间距压到 5px——390×844 首屏（85dvh=717px）六块一屏读完 */
.blk {
  background: #263238;
  border-radius: 9px;
  padding: 5px 9px 6px;
  margin-bottom: 5px;
}
.blk h4 {
  margin: 0 0 2px;
  font-size: 12.5px;
  color: #e0f7fa;
  letter-spacing: 0.2px;
}
.blk p {
  margin: 0;
  font-size: 12px; /* 视觉拍板：11px → 12px（390×844 实测仍一屏读完，见 G-03）；行高保持 1.42 */
  line-height: 1.42;
  color: #b0bec5;
}
.close {
  width: 100%;
  margin-top: 2px;
  border: 1px solid #455a64;
  background: #263238;
  color: #cfd8dc;
  border-radius: 12px;
  padding: 9px;
  font-size: 13px;
  font-weight: 700;
}
</style>

<script setup lang="ts">
/**
 * 音效素材署名（M3-T2 → #54 / A-06）：`win.mp3`（CC-BY 4.0）与 `step.mp3`（CC-BY 3.0）两条必须出现在
 * **产品可见处**——单机大厅页脚与房间大厅页脚共用这一块，文案住 `audio/credits.ts`
 * （`credits.test.ts` 与 `public/audio/LICENSES.md` 逐字对账）。
 *
 * 纯静态展示：无状态、无动画（查看类不做出场演出）。
 */
import { SFX_CREDITS } from "../audio/credits";
</script>

<template>
  <section class="about">
    <h3>关于 · 音效素材授权</h3>
    <p v-for="c in SFX_CREDITS" :key="c.file" class="credit">
      <span class="cf">{{ c.file }}</span>{{ c.text }}
    </p>
    <p class="cc0Note">其余 10 条音效为 CC0（Kenney / artisticdude），不要求署名。</p>
  </section>
</template>

<style scoped>
.about {
  margin-top: 12px;
  padding-top: 9px;
  border-top: 1px dashed rgba(176, 190, 197, 0.22);
}
.about h3 {
  margin: 0 0 5px;
  font-size: 10.5px;
  font-weight: 700;
  color: #78909c;
  letter-spacing: 0.3px;
}
.credit {
  margin: 0 0 4px;
  font-size: 10px;
  line-height: 1.5;
  color: #78909c;
}
.credit .cf {
  color: #b0bec5;
  font-weight: 700;
  margin-right: 4px;
}
.cc0Note {
  margin: 2px 0 0;
  font-size: 9.5px;
  color: #546e7a;
}
</style>

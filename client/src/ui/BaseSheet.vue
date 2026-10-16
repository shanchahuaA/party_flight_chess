<script setup lang="ts">
/** 底部抽屉弹层壳（浮层原则通用壳）：overlay+sheet 布局统一；内容与动作由使用方给。
 *  @close 由壳层消费与否自定——必选流程（如开局暗牌）可对 close 不响应。 */
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="sheet"><slot /></div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(13, 20, 26, 0.75);
  display: flex;
  align-items: flex-end;
  z-index: 90;
}
.sheet {
  width: 100%;
  background: #22303c;
  color: #eceff1;
  border-radius: 16px 16px 0 0;
  padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
  box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.45);
}
</style>

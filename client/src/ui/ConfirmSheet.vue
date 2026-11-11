<script setup lang="ts">
/**
 * 二次确认浮层（M3-T6，#58 / G-07 + L-05）。
 *
 * 一处形态、多处复用：请出（⚙ 成员管理 / 大厅 🥾）与解散房间（⚙ / 大厅页脚 / 对局面角落）
 * 全部走它——破坏性动作的统一外观与统一默认值（点遮罩=取消，**绝不**等于确认）。
 *
 * 状态机不在本组件里：`game/confirm.ts` 的 `stepConfirm()` 是唯一真源（ask 只开浮层、
 * cancel 不执行、confirm 才执行一次）；本组件只负责画两个钮并把事件抛给调用方。
 * 动效红线：查看类浮层朴素呈现，无过渡/动画（本文件在 motionRedline.test.ts 的朴素区名单里）。
 */
import BaseSheet from "./BaseSheet.vue";

withDefaults(
  defineProps<{
    /** 标题（默认「请确认」） */
    title?: string;
    /** 正文：一句说清后果（G-07 原文逐字由 game/confirm.ts 的 kickPrompt 给） */
    message: string;
    /** 确认钮文案 */
    confirmText?: string;
    /** 取消钮文案 */
    cancelText?: string;
  }>(),
  {
    title: "请确认",
    confirmText: "确认",
    cancelText: "取消",
  },
);

/** confirm=真的执行；cancel=什么都不做（含点遮罩关闭） */
defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <BaseSheet @close="$emit('cancel')">
    <div class="confirmSheet" data-confirm="sheet">
      <h3>{{ title }}</h3>
      <p class="msg">{{ message }}</p>
      <div class="btns">
        <button class="cancel" type="button" data-confirm="cancel" @click="$emit('cancel')">
          {{ cancelText }}
        </button>
        <button class="ok" type="button" data-confirm="ok" @click="$emit('confirm')">
          {{ confirmText }}
        </button>
      </div>
    </div>
  </BaseSheet>
</template>

<style scoped>
.confirmSheet {
  color: #eceff1;
}
.confirmSheet h3 {
  margin: 0 0 8px;
  font-size: 15.5px;
}
.msg {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.6;
  color: #e0e0e0;
}
.btns {
  display: flex;
  gap: 10px;
}
.cancel {
  flex: 1;
  border: 1px solid #455a64;
  background: #263238;
  color: #cfd8dc;
  border-radius: 12px;
  padding: 11px;
  font-size: 13.5px;
  font-weight: 700;
}
.ok {
  flex: 1;
  border: 1px solid #8e2418;
  background: #8e2418;
  color: #ffebee;
  border-radius: 12px;
  padding: 11px;
  font-size: 13.5px;
  font-weight: 800;
}
</style>

<script setup lang="ts">
/**
 * 测试记录器悬浮条（M3 #51）：仅 `?rec=1` 时渲染（父级 v-if 门控）。
 * 不显眼地贴在左下角：条数 +「📋 复制 JSON」+「⬇ 下载 .json」。
 * iPhone 上下载走 blob + a[download]（iOS Safari 会落到「文件」App）；剪贴板不可用时退化为
 * 把 JSON 塞进新窗口供手动选择——绝不静默失败。
 */
import { computed, ref } from "vue";
import { recLog } from "../net/recLog";
import { roomStore } from "../net/roomStore";

const count = computed(() => recLog.count.value);
const dropped = computed(() => recLog.dropped.value);

const busy = ref(false);
const hint = ref("");

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function download(): Promise<void> {
  busy.value = true;
  try {
    const json = recLog.exportJSON(roomStore.mySeat.value);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pfc-rec-${recLog.snapshot().room ?? "solo"}-${stamp()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 给 iOS 一点时间接管下载再回收
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    hint.value = "已导出";
  } catch {
    hint.value = "导出失败";
  } finally {
    busy.value = false;
    window.setTimeout(() => (hint.value = ""), 1600);
  }
}

async function copy(): Promise<void> {
  busy.value = true;
  try {
    const json = recLog.exportJSON(roomStore.mySeat.value);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(json);
      hint.value = `已复制 ${(json.length / 1024).toFixed(1)}KB`;
    } else {
      window.prompt("剪贴板不可用——长按复制下面的 JSON", json);
      hint.value = "已展开 JSON";
    }
  } catch {
    hint.value = "复制失败";
  } finally {
    busy.value = false;
    window.setTimeout(() => (hint.value = ""), 1600);
  }
}
</script>

<template>
  <div class="recBar" :title="`测试记录器（?rec=1）：${count} 条`">
    <span class="cnt">📋 {{ count }}<i v-if="dropped > 0">(丢{{ dropped }})</i></span>
    <button type="button" :disabled="busy" @click="copy">{{ hint || "复制 JSON" }}</button>
    <button type="button" :disabled="busy" @click="download">⬇ 下载</button>
  </div>
</template>

<style scoped>
.recBar {
  position: fixed;
  left: 6px;
  bottom: calc(4px + env(safe-area-inset-bottom));
  z-index: 240; /* 压过一切浮层：测试通道永远可点 */
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(20, 28, 36, 0.82);
  border: 1px solid #455a64;
  border-radius: 999px;
  padding: 3px 8px 3px 6px;
  opacity: 0.72;
  font-size: 9.5px;
  color: #b0bec5;
  user-select: none;
}
.recBar:hover,
.recBar:active {
  opacity: 1;
}
.cnt {
  font-weight: 700;
  color: #80cbc4;
  white-space: nowrap;
}
.cnt i {
  font-style: normal;
  color: #ef9a9a;
}
.recBar button {
  border: 1px solid #546e7a;
  background: #263238;
  color: #cfd8dc;
  border-radius: 999px;
  font-size: 9.5px;
  padding: 2px 7px;
  white-space: nowrap;
}
.recBar button:disabled {
  opacity: 0.6;
}
</style>

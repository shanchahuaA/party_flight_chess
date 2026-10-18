<script setup lang="ts">
/**
 * 战报让位带简版（界面呈现定案 §三 V2）：顶部常驻一条流水带（布局占位让出，不叠棋盘），
 * 最新 2 条常驻、新消息推入旧行下移；点带子展开全量战报抽屉（详情入口不能缺）。
 * 条目结构＝类型图标 · 谁 · 结果短语：主语按 who 渲染成名字 chip，文本只出现一次名
 * （实玩增补细则：「小黄 小黄」重复已定案为渲染层剥前缀）；抽屉起步渲染最近 50 条、上滑增量，
 * 回合号换行＝分节线（summary 类条目 T8 落地即自带文案），点条目展开 flavor（卡面叙事皮不进一行）。
 */
import { computed, nextTick, ref, watch } from "vue";
import type { MessageEntry, MessageKind } from "../../../kernel/src";
import { gameStore } from "../game/store";
import BaseSheet from "./BaseSheet.vue";

const KIND_ICONS: Record<MessageKind, string> = {
  event: "🃏",
  trap: "⚠️",
  item: "🎁",
  malice: "🌲",
  beast: "🐉",
  system: "📣",
  summary: "📜",
  score: "📣",
};

const msgs = computed(() => gameStore.state.value?.messages ?? []);

/** 常驻两条：新消息推入顶部、旧行下移让位（倒序取尾部两条） */
const band = computed(() => {
  const all = msgs.value;
  const rows: MessageEntry[] = [];
  for (let i = all.length - 1; i >= 0 && rows.length < 2; i--) rows.push(all[i]!);
  return rows;
});

function name(pid?: number): string {
  if (pid == null) return "";
  return gameStore.state.value?.players[pid]?.name ?? "";
}

/** 名字 chip：who 玩家名。系统替掷/代选/自动确认类消息文本以「系统替 X」开头、自含归因，
 *  出 chip 会拼成「你 系统 …」的夹生句——这类整句直出、不出 chip（文本里名只出现一次，不算重复） */
function chip(m: MessageEntry): string {
  const n = name(m.who);
  return n && m.text.startsWith("系统替 ") ? "" : n;
}

/** 正文：chip 已承担主语时，剥文本头的名字前缀（stub 首版两处重名已定案渲染层剥前缀） */
function body(m: MessageEntry): string {
  const n = chip(m);
  if (n && m.text.startsWith(`${n} `)) return m.text.slice(`${n} `.length);
  return m.text;
}

// ---------- 全量战报抽屉 ----------

const drawer = ref(false);
const flavorOpen = ref<Set<number>>(new Set());

/** 抽屉按定案渲染约束：只渲染最近 50 条，上滑增量放更早条目（约 50 条/批）；开抽屉滚到最新 */
const limit = ref(50);
const recent = computed(() => msgs.value.slice(-limit.value));

/** 回合号换行即画分节线（抽屉首条不画）；summary 类条目 T8 落地后自带文案 */
function isTurnHead(m: MessageEntry, i: number): boolean {
  const before = i > 0 ? recent.value[i - 1]! : msgs.value.length > recent.value.length ? msgs.value[msgs.value.length - recent.value.length - 1]! : null;
  return !!before && before.turn !== m.turn;
}

/** 顶部触边：再放 50 条更早条目（prepend 上面，滚位别跳） */
function loadEarlier(): void {
  const el = listEl.value;
  const all = msgs.value;
  if (!el || el.scrollTop > 4 || limit.value >= all.length) return;
  const old = el.scrollHeight;
  limit.value = Math.min(all.length, limit.value + 50);
  nextTick(() => {
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight - old;
  });
}

function toggleFlavor(m: MessageEntry): void {
  if (!m.flavor) return;
  const s = new Set(flavorOpen.value);
  if (s.has(m.id)) s.delete(m.id);
  else s.add(m.id);
  flavorOpen.value = s;
}

const listEl = ref<HTMLElement | null>(null);
watch(drawer, async (open) => {
  if (!open) return;
  limit.value = 50; // 每次开抽屉归位：从最近 50 条起步，上滑再放
  await nextTick();
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
});
</script>

<template>
  <section class="worldMsg" title="点开全量战报" @click="drawer = true">
    <TransitionGroup name="ws" tag="div" class="rows">
      <div v-for="m in band" :key="m.id" class="row" :class="`e-${m.emphasis}`">
        <span class="ic">{{ KIND_ICONS[m.kind] }}</span>
        <span v-if="chip(m)" class="who">{{ chip(m) }}</span>
        <span class="txt">{{ body(m) }}</span>
      </div>
    </TransitionGroup>

    <!-- 全量战报抽屉（页内浮层，不路由切页） -->
    <BaseSheet v-if="drawer" @close="drawer = false">
      <div class="drawerBox">
        <h3>📜 战报 <small>{{ msgs.length }} 条 · 点条目看卡面文案</small></h3>
        <div ref="listEl" class="list" @scroll="loadEarlier">
          <template v-for="(m, i) in recent" :key="m.id">
            <div v-if="m.kind === 'summary'" class="turnLine">{{ body(m) }}</div>
            <template v-else>
              <div v-if="isTurnHead(m, i)" class="turnLine">📜 ── 回合 {{ m.turn }} ──</div>
              <div class="drow" :class="`e-${m.emphasis}`" @click="toggleFlavor(m)">
                <div class="rowMain">
                  <span class="ic">{{ KIND_ICONS[m.kind] }}</span>
                  <span v-if="chip(m)" class="who">{{ chip(m) }}</span>
                  <span class="txt">{{ body(m) }}</span>
                </div>
                <div v-if="m.flavor && flavorOpen.has(m.id)" class="flavor">{{ m.flavor }}</div>
              </div>
            </template>
          </template>
          <div v-if="msgs.length === 0" class="empty">这局还没有战报。</div>
          <div v-else-if="msgs.length > recent.length" class="moreHint">⬆ 上滑加载更早 {{ msgs.length - recent.length }} 条</div>
        </div>
        <button class="close" type="button" @click="drawer = false">收 起</button>
      </div>
    </BaseSheet>
  </section>
</template>

<style scoped>
.worldMsg {
  margin: 2px 10px 0;
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid #cfd8dc;
  border-radius: 10px;
  padding: 2px 9px;
  min-height: 46px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  cursor: pointer;
  overflow: hidden;
}
.rows {
  position: relative;
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 3px 0;
  font-size: 11.5px;
  color: #37474f;
  min-height: 20px;
  overflow: hidden;
}
.row .ic,
.drow .ic {
  flex: 0 0 auto;
  font-size: 12px;
}
.row .who,
.drow .who {
  flex: 0 0 auto;
  font-weight: 800;
  color: #263238;
}
.row .txt,
.drow .txt {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row.e-big,
.drow.e-big {
  background: #fff3e0;
}
.row.e-highlight .txt,
.drow.e-highlight .txt {
  font-weight: 700;
  color: #263238;
}
.row.e-target .who,
.drow.e-target .who {
  color: #c62828;
}

/* 条目换入动画：新消息从上沿推入，旧行受 move 下移让位 */
.ws-move {
  transition: transform 0.25s ease;
}
.ws-enter-active,
.ws-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.ws-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.ws-leave-active {
  position: absolute;
  width: 100%;
  opacity: 0;
}

/* 抽屉 */
.drawerBox h3 {
  margin: 0;
  font-size: 15px;
}
.drawerBox h3 small {
  font-size: 10.5px;
  font-weight: 400;
  color: #90a4ae;
  margin-left: 6px;
}
.list {
  margin-top: 8px;
  max-height: 52vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  overscroll-behavior: contain;
}
.turnLine {
  margin: 9px 0 3px;
  font-size: 11px;
  font-weight: 700;
  color: #ffb74d;
  text-align: center;
  border-top: 1px dashed #546e7a;
  padding-top: 7px;
}
.list > :first-child .turnLine {
  margin-top: 2px;
}
.drow {
  padding: 3px 0;
  font-size: 12px;
  color: #cfd8dc;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.drow .rowMain {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.drow.e-big {
  background: rgba(255, 183, 77, 0.14);
  border-radius: 6px;
}
.drow .flavor {
  margin: 2px 0 3px 21px;
  font-size: 11px;
  font-style: italic;
  color: #90a4ae;
}
.empty,
.moreHint {
  text-align: center;
  font-size: 11px;
  color: #607d8b;
  padding: 10px 0;
}
.close {
  margin-top: 10px;
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

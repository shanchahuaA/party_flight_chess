<script setup lang="ts">
/**
 * 大厅简版页（M1 形态：配置表单 + 直达「开始」）：
 * - 配置七项在共用 ConfigPanel（M2-T4 抽出：单机内联卡与联机房弹窗同一套控件）；
 *   单机不接 change 上行，开始时一次性读 model。
 * - 假人 1–7（共 2–8 人局）；角色 5 个明选（可重复选同一角色，属性只在详情弹层展示）。
 * - 出生格按人数均布由内核 spawnMenu 落座（各占一角相望）。
 */
import { computed, reactive, ref } from "vue";
import { ROLES, type GameConfig, type PlayerDef, type RoleId } from "../../../kernel/src";
import { BOT_NAMES } from "../../../shared/protocol";
import { gameStore, newSeed } from "../game/store";
import { roomStore } from "../net/roomStore";
import BaseSheet from "./BaseSheet.vue";
import ConfigPanel, { type ConfigModel } from "./ConfigPanel.vue";

const botsN = ref(1);
const cfg = reactive<ConfigModel>({
  turnCap: 15,
  maxHp: 10,
  windowSeconds: 30,
  restSeconds: 10,
  timerMode: "world",
  maliceLevel: "mild",
  maliceEvery: 3,
});
const humanRole = ref<RoleId>("light");
const detailRole = ref<RoleId | null>(null);

const detail = computed(() => (detailRole.value ? ROLES.find((r) => r.id === detailRole.value) ?? null : null));

function pickRole(id: RoleId): void {
  humanRole.value = id;
}

function start(): void {
  const config: Partial<GameConfig> = {
    seed: newSeed(), // 单机局默认换新种子（内核默认种子留给测试）
    turnCap: cfg.turnCap,
    maxHp: cfg.maxHp,
    windowMs: cfg.windowSeconds * 1000,
    restMs: cfg.restSeconds * 1000,
    timerMode: cfg.timerMode,
    maliceLevel: cfg.maliceLevel,
    maliceEvery: cfg.maliceEvery,
  };
  const defs: PlayerDef[] = [
    { name: "你", isBot: false, roleId: humanRole.value },
    ...Array.from({ length: botsN.value }, (_, i): PlayerDef => ({ name: BOT_NAMES[i] ?? `小${i}`, isBot: true })),
  ];
  gameStore.boot(config, defs);
}
</script>

<template>
  <div class="lobby">
    <header class="head">
      <h1>🏮 庄园法会</h1>
      <p class="sub">单机可玩（1 真人 + 1–7 假人）｜数值冻结一局，下局可再调</p>
    </header>

    <!-- 大厅双入口（Spec #37 实现决策 10）：联机房间与单机开局并列，单机形态原样保留 -->
    <section class="card online">
      <h2>🛰️ 朋友联机</h2>
      <div class="row">
        <button class="roomBtn" type="button" @click="roomStore.openJoin('create')">🏠 创建房间</button>
        <button class="roomBtn" type="button" @click="roomStore.openJoin('join')">🚪 加入房间</button>
      </div>
      <p class="hint">创建得到房间码与邀请链接，发到群里朋友点开即进（最多 8 人）。</p>
    </section>

    <section class="card">
      <h2>🪑 同桌几人</h2>
      <div class="row">
        <div class="stepper">
          <button type="button" :disabled="botsN <= 1" @click="botsN--">−</button>
          <span class="val">{{ botsN }} 假人</span>
          <button type="button" :disabled="botsN >= 7" @click="botsN++">＋</button>
        </div>
        <span class="note">共 {{ botsN + 1 }} 人局</span>
      </div>
    </section>

    <section class="card">
      <h2>⚙️ 局面配置</h2>
      <ConfigPanel :model="cfg" />
    </section>

    <section class="card">
      <h2>🎭 明选角色</h2>
      <div class="roles">
        <div
          v-for="r in ROLES"
          :key="r.id"
          class="roleCard"
          :class="{ on: humanRole === r.id }"
          @click="pickRole(r.id)"
        >
          <div class="face">{{ r.emoji }}</div>
          <div class="rname">{{ r.name }}</div>
          <button class="info" type="button" @click.stop="detailRole = r.id">ⓘ</button>
        </div>
      </div>
      <p class="hint">属性（三轴/被动/检定特长）只在角色详情弹层展示，不常驻棋屏。</p>
    </section>

    <footer class="foot">
      <button class="start" type="button" @click="start">🎴 抽暗牌 · 开始</button>
    </footer>

    <!-- 角色详情弹层（浮层原则：查看类不切页） -->
    <BaseSheet v-if="detail" @close="detailRole = null">
      <div class="sheetBody">
        <div class="sheetHead">
          <span class="big">{{ detail.emoji }}</span>
          <div>
            <h3>{{ detail.name }}</h3>
            <p class="sub">三轴 6 点（检定 = 1d20 + 对应轴）</p>
          </div>
        </div>
        <div class="axes">
          <span>力 {{ detail.axes.might }}</span>
          <span>敏 {{ detail.axes.agile }}</span>
          <span>运 {{ detail.axes.luck }}</span>
        </div>
        <dl>
          <dt>检定特长</dt>
          <dd>{{ detail.specialty ? detail.specialty.name : "无（敏 3 本身是检定挂点）" }}</dd>
          <dt>被动</dt>
          <dd>{{ detail.passiveText }}</dd>
        </dl>
        <button class="close" type="button" @click="detailRole = null">收 起</button>
      </div>
    </BaseSheet>
  </div>
</template>

<style scoped>
.lobby {
  /* min-height 而非 height：内容超出视口时整页长高、靠 body 滚动（style.css 放开） */
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
  padding: 10px 12px 12px;
}
.online .roomBtn {
  flex: 1;
  border: 0;
  border-radius: 12px;
  background: #8e2418;
  color: #ffebee;
  font-size: 14px;
  font-weight: 800;
  padding: 12px 4px;
}
.card h2 {
  font-size: 13.5px;
  margin: 0 0 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.stepper {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #263238;
  border-radius: 999px;
  padding: 4px 10px;
}
.stepper button {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 0;
  background: #455a64;
  color: #fff;
  font-size: 16px;
  font-weight: 800;
}
.stepper button:disabled {
  opacity: 0.4;
}
.val {
  font-weight: 800;
  font-size: 13.5px;
}
.note {
  font-size: 11.5px;
  color: #b0bec5;
}
.hint {
  font-size: 11px;
  color: #90a4ae;
  margin: 6px 0 0;
}
.roles {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 7px;
}
.roleCard {
  position: relative;
  background: #263238;
  border: 2px solid transparent;
  border-radius: 12px;
  padding: 8px 2px 6px;
  text-align: center;
  cursor: pointer;
  user-select: none;
}
.roleCard.on {
  border-color: #ef5350;
  background: #37474f;
  box-shadow: 0 0 0 2px rgba(239, 83, 80, 0.25);
}
.face {
  font-size: 22px;
}
.rname {
  font-size: 10px;
  font-weight: 700;
  color: #cfd8dc;
  margin-top: 3px;
}
.info {
  position: absolute;
  top: 2px;
  right: 3px;
  border: 0;
  background: rgba(255, 255, 255, 0.12);
  color: #b0bec5;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 10px;
  padding: 0;
  line-height: 18px;
}
.foot {
  padding: 2px 0 6px;
}
.start {
  width: 100%;
  border: 0;
  border-radius: 14px;
  background: #b71c1c;
  color: #fff;
  font-size: 15px;
  font-weight: 800;
  padding: 14px;
  box-shadow: 0 3px 10px rgba(183, 28, 28, 0.45);
}
.sheetBody .sub {
  font-size: 11.5px;
  color: #b0bec5;
  margin: 0;
}
.sheetHead {
  display: flex;
  gap: 10px;
  align-items: center;
}
.sheetHead h3 {
  margin: 0;
  font-size: 16px;
}
.big {
  font-size: 34px;
}
.axes {
  display: flex;
  gap: 8px;
  margin: 10px 0;
}
.axes span {
  background: #263238;
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12.5px;
  font-weight: 700;
}
dl {
  margin: 10px 0 14px;
}
dt {
  font-size: 11px;
  color: #90a4ae;
  margin-bottom: 2px;
}
dd {
  margin: 0;
  font-size: 13px;
  color: #eceff1;
  line-height: 1.5;
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

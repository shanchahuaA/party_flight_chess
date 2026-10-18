<script setup lang="ts">
/**
 * 大厅简版页（M1 形态：配置表单 + 直达「开始」）：
 * - 配置五项：局长 5–30 默认 15／血量上限 5–20 默认 10／世界回合窗 10–90s 默认 30／
 *   计时模式双选（世界·即时默认；轮班·限时先可选中，完整行为在 T9，M1 前段按世界·即时跑）／休息 0–20s 默认 10。
 * - 世界恶意（#24 T6a，数值表 §5.5）：档位三段钮（关/温和 −1 血/猛 −2 血，默认温和）+
 *   波周期滑条（每 2–5 个世界回合一波，默认 3；关档时禁用）。
 * - 假人 1–7（共 2–8 人局）；角色 5 个明选（可重复选同一角色，属性只在详情弹层展示）。
 * - 出生格按人数均布由内核 spawnMenu 落座（各占一角相望）。
 */
import { computed, reactive, ref } from "vue";
import { CONFIG_LIMITS, ROCK_LEN, ROLES, SINK_CELLS, TIMBER_CELLS, type GameConfig, type PlayerDef, type RoleId } from "../../../kernel/src";
import { gameStore, newSeed } from "../game/store";
import BaseSheet from "./BaseSheet.vue";

const BOT_NAMES = ["小黄", "小绿", "小蓝", "小紫", "小橙", "小粉", "小青"];

const botsN = ref(1);
const cfg = reactive({
  turnCap: 15,
  maxHp: 10,
  windowSeconds: 30,
  timerMode: "world" as "world" | "turn",
  restSeconds: 10,
  maliceLevel: "mild" as "mild" | "fierce" | "off",
  maliceEvery: 3,
});
const humanRole = ref<RoleId>("light");
const detailRole = ref<RoleId | null>(null);

const WINDOW_OPTIONS = [10, 15, 20, 30, 60, 90];
const MALICE_LEVELS: Array<{ id: "mild" | "fierce" | "off"; label: string; note: string }> = [
  { id: "off", label: "关", note: "整局无世界恶意" },
  { id: "mild", label: "温和", note: "每波 −1 血（默认）" },
  { id: "fierce", label: "猛", note: "每波 −2 血（伤害翻倍）" },
];
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
      <h1>🏮 庄园法会 · 开局</h1>
      <p class="sub">单机可玩（1 真人 + 1–7 假人）｜数值冻结一局，下局可再调</p>
    </header>

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
      <label class="field">
        <span class="lab">局长（世界回合）</span>
        <span class="ctl">
          <input v-model.number="cfg.turnCap" type="range" :min="CONFIG_LIMITS.turnCap[0]" :max="CONFIG_LIMITS.turnCap[1]" step="1" />
          <b>{{ cfg.turnCap }} 回合</b>
        </span>
      </label>
      <label class="field">
        <span class="lab">血量上限</span>
        <span class="ctl">
          <input v-model.number="cfg.maxHp" type="range" :min="CONFIG_LIMITS.maxHp[0]" :max="CONFIG_LIMITS.maxHp[1]" step="1" />
          <b>{{ cfg.maxHp }} ❤</b>
        </span>
      </label>
      <label class="field">
        <span class="lab">世界回合窗</span>
        <span class="ctl">
          <select v-model.number="cfg.windowSeconds">
            <option v-for="s in WINDOW_OPTIONS" :key="s" :value="s">{{ s }} 秒</option>
          </select>
        </span>
      </label>
      <label class="field">
        <span class="lab">回合间休息</span>
        <span class="ctl">
          <input v-model.number="cfg.restSeconds" type="range" :min="CONFIG_LIMITS.restMs[0] / 1000" :max="CONFIG_LIMITS.restMs[1] / 1000" step="1" />
          <b>{{ cfg.restSeconds }} s</b>
        </span>
      </label>
      <div class="field">
        <span class="lab">计时模式</span>
        <span class="ctl seg">
          <button type="button" :class="{ on: cfg.timerMode === 'world' }" @click="cfg.timerMode = 'world'">
            世界·即时<span class="tag">默认</span>
          </button>
          <button type="button" :class="{ on: cfg.timerMode === 'turn' }" @click="cfg.timerMode = 'turn'">
            轮班·限时<span class="tag alert">T9 起</span>
          </button>
        </span>
      </div>
      <p v-if="cfg.timerMode === 'turn'" class="hint">轮班·限时选段已记下；完整轮转行为在 T9 接入，本局先按世界·即时跑。</p>
      <div class="field">
        <span class="lab">世界恶意</span>
        <span class="ctl seg">
          <button
            v-for="l in MALICE_LEVELS"
            :key="l.id"
            type="button"
            :class="{ on: cfg.maliceLevel === l.id }"
            :title="l.note"
            @click="cfg.maliceLevel = l.id"
          >{{ l.label }}</button>
        </span>
      </div>
      <label class="field">
        <span class="lab">恶意波周期</span>
        <span class="ctl" :class="{ off: cfg.maliceLevel === 'off' }">
          <input v-model.number="cfg.maliceEvery" type="range" :min="CONFIG_LIMITS.maliceEvery[0]" :max="CONFIG_LIMITS.maliceEvery[1]" step="1" :disabled="cfg.maliceLevel === 'off'" />
          <b>每 {{ cfg.maliceEvery }} 回合</b>
        </span>
      </label>
      <p class="hint">世界恶意：🌲 每 N 回合一波全桌不测之祸（🪵 木头砸 {{ TIMBER_CELLS }} 格·预警可逃／🪨 滚石 {{ ROCK_LEN }} 格可躲／🕳 塌陷 {{ SINK_CELLS }} 格），战报承载、不打断操作。</p>
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
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: calc(12px + env(safe-area-inset-top)) 12px calc(14px + env(safe-area-inset-bottom));
  background: #17222c;
  color: #eceff1;
  overflow-y: auto;
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
.field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 12.5px;
}
.lab {
  width: 96px;
  flex: 0 0 auto;
  color: #cfd8dc;
}
.ctl {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ctl input[type="range"] {
  flex: 1;
  accent-color: #ef5350;
}
.ctl b {
  width: 66px;
  text-align: right;
  font-size: 12.5px;
}
.ctl select {
  flex: 1;
  background: #263238;
  color: #eceff1;
  border: 1px solid #455a64;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 13px;
}
.seg {
  gap: 6px;
}
.ctl.off {
  opacity: 0.45;
}
.seg button {
  flex: 1;
  border: 1px solid #455a64;
  background: #263238;
  color: #90a4ae;
  border-radius: 10px;
  padding: 8px 4px;
  font-size: 12px;
  font-weight: 700;
}
.seg button.on {
  background: #b71c1c;
  border-color: #ef5350;
  color: #fff;
}
.tag {
  font-size: 9px;
  vertical-align: super;
  margin-left: 2px;
  color: #90a4ae;
}
.tag.alert {
  color: #ffb74d;
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

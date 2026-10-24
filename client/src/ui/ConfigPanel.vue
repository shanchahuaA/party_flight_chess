<script lang="ts">
/** 配置面板的 UI 域模型：窗/休息用秒（滑条口径），上行/落账时由使用方换算毫秒（LobbyConfig） */
export interface ConfigModel {
  turnCap: number;
  maxHp: number;
  windowSeconds: number;
  restSeconds: number;
  timerMode: "world" | "turn";
  maliceLevel: "mild" | "fierce" | "off";
  maliceEvery: number;
}
</script>

<script setup lang="ts">
/**
 * 开局配置面板（M2-T4，#41 从单机大厅抽出共用）：单机大厅内联卡与联机房配置弹窗=同一套控件，
 * 界面呈现定案「房主配置面板（弹窗）＋非房主只读预览」的「同一套」即复用本组件。
 * - model 由使用方持有并直接写回（reactive 对象引用）；面板不持有状态。
 * - change 事件=任一控件落定（滑条松手/选项点选）时发一次——联机方借此上行 setConfig
 *   （深 watch 会随拖动逐像素刷 WS，故走落定沿）；单机方不接，开始时一次性读 model。
 * - readonly：非房主只读预览（控件全禁+整体压暗+不可点）。
 */
import { CONFIG_LIMITS, ROCK_LEN, SINK_CELLS, TIMBER_CELLS } from "../../../kernel/src";

defineProps<{ model: ConfigModel; readonly?: boolean }>();
defineEmits<{ change: [] }>();

const WINDOW_OPTIONS = [10, 15, 20, 30, 60, 90];
const MALICE_LEVELS: Array<{ id: "mild" | "fierce" | "off"; label: string; note: string }> = [
  { id: "off", label: "关", note: "整局无世界恶意" },
  { id: "mild", label: "温和", note: "每波 −1 血（默认）" },
  { id: "fierce", label: "猛", note: "每波 −2 血（伤害翻倍）" },
];
</script>

<template>
  <div class="panel" :class="{ ro: readonly }">
    <label class="field">
      <span class="lab">局长（世界回合）</span>
      <span class="ctl">
        <input v-model.number="model.turnCap" type="range" :min="CONFIG_LIMITS.turnCap[0]" :max="CONFIG_LIMITS.turnCap[1]" step="1" :disabled="readonly" @change="$emit('change')" />
        <b>{{ model.turnCap }} 回合</b>
      </span>
    </label>
    <label class="field">
      <span class="lab">血量上限</span>
      <span class="ctl">
        <input v-model.number="model.maxHp" type="range" :min="CONFIG_LIMITS.maxHp[0]" :max="CONFIG_LIMITS.maxHp[1]" step="1" :disabled="readonly" @change="$emit('change')" />
        <b>{{ model.maxHp }} ❤</b>
      </span>
    </label>
    <label class="field">
      <span class="lab">世界回合窗</span>
      <span class="ctl">
        <select v-model.number="model.windowSeconds" :disabled="readonly" @change="$emit('change')">
          <option v-for="s in WINDOW_OPTIONS" :key="s" :value="s">{{ s }} 秒</option>
        </select>
      </span>
    </label>
    <label class="field">
      <span class="lab">回合间休息</span>
      <span class="ctl">
        <input v-model.number="model.restSeconds" type="range" :min="CONFIG_LIMITS.restMs[0] / 1000" :max="CONFIG_LIMITS.restMs[1] / 1000" step="1" :disabled="readonly" @change="$emit('change')" />
        <b>{{ model.restSeconds }} s</b>
      </span>
    </label>
    <div class="field">
      <span class="lab">计时模式</span>
      <span class="ctl seg">
        <button type="button" :disabled="readonly" :class="{ on: model.timerMode === 'world' }" @click="model.timerMode = 'world'; $emit('change')">
          世界·即时<span class="tag">默认</span>
        </button>
        <button type="button" :disabled="readonly" :class="{ on: model.timerMode === 'turn' }" @click="model.timerMode = 'turn'; $emit('change')">
          轮班·限时
        </button>
      </span>
    </div>
    <p class="hint">
      {{
        model.timerMode === "turn"
          ? "轮班·限时：按座次轮流行动，轮到谁谁的倒计时才开始走；淘汰者与通关席跳过，超时自动掷骰。"
          : "世界·即时：全员同一倒计时窗内同时行动，全员确认提前开窗，超时系统替掷。"
      }}
    </p>
    <div class="field">
      <span class="lab">世界恶意</span>
      <span class="ctl seg">
        <button
          v-for="l in MALICE_LEVELS"
          :key="l.id"
          type="button"
          :disabled="readonly"
          :class="{ on: model.maliceLevel === l.id }"
          :title="l.note"
          @click="model.maliceLevel = l.id; $emit('change')"
        >{{ l.label }}</button>
      </span>
    </div>
    <label class="field">
      <span class="lab">恶意波周期</span>
      <span class="ctl" :class="{ off: model.maliceLevel === 'off' }">
        <input v-model.number="model.maliceEvery" type="range" :min="CONFIG_LIMITS.maliceEvery[0]" :max="CONFIG_LIMITS.maliceEvery[1]" step="1" :disabled="readonly || model.maliceLevel === 'off'" @change="$emit('change')" />
        <b>每 {{ model.maliceEvery }} 回合</b>
      </span>
    </label>
    <p class="hint">世界恶意：🌲 每 N 回合一波全桌不测之祸（🪵 木头砸 {{ TIMBER_CELLS }} 格·预警可逃／🪨 滚石 {{ ROCK_LEN }} 格可躲／🕳 塌陷 {{ SINK_CELLS }} 格），战报承载、不打断操作。</p>
  </div>
</template>

<style scoped>
.panel.ro {
  opacity: 0.62;
  filter: grayscale(0.15);
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
.seg button:disabled {
  cursor: default;
}
.tag {
  font-size: 9px;
  vertical-align: super;
  margin-left: 2px;
  color: #90a4ae;
}
.hint {
  font-size: 11px;
  color: #90a4ae;
  margin: 6px 0 0;
}
</style>

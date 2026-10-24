<script setup lang="ts">
/**
 * 房间大厅真形态（M2-T4，#41；界面呈现定案大厅页）：座位列（角色明选/在线/到齐）+
 * 房主配置弹窗（共用 ConfigPanel，非房主只读预览）+ 假人步进（房主）+ 开始按钮（仅房主）。
 * 按下开始→快照 phase=started：大厅面收口进「开局中」等待态（对局主链路 T5/T6 接线）。
 * 角色被动等查看类走浮层（弹窗原则）：角色详情与配置面板都是 BaseSheet。
 */
import { computed, reactive, ref, watch } from "vue";
import { ROLES, type RoleDef, type RoleId } from "../../../kernel/src";
import { MAX_BOTS, MAX_SEATS, type LobbyConfig } from "../../../shared/protocol";
import { roomStore } from "../net/roomStore";
import BaseSheet from "./BaseSheet.vue";
import ConfigPanel, { type ConfigModel } from "./ConfigPanel.vue";

const snap = computed(() => roomStore.snapshot.value);
const amHost = computed(() => snap.value?.hostSeat === roomStore.mySeat.value);
const phase = computed(() => snap.value?.phase ?? "lobby");
const started = computed(() => phase.value === "started");
const seats = computed(() => snap.value?.seats ?? []);
const humansCount = computed(() => seats.value.filter((s) => !s.bot).length);
const botsCount = computed(() => seats.value.filter((s) => s.bot).length);
const emptySeats = computed(() => (snap.value ? MAX_SEATS - seats.value.length : 0));
const myRole = computed(
  () => seats.value.find((s) => s.seat === roomStore.mySeat.value)?.roleId ?? null,
);
/** 假人可加判据与服务端同口径（假人 ≤7、真人+假人 ≤8；服务端兜底） */
const canAddBot = computed(() => botsCount.value < MAX_BOTS && seats.value.length < MAX_SEATS);

function isMe(seat: number): boolean {
  return seat === roomStore.mySeat.value;
}

function roleOf(id: RoleId | null): RoleDef | null {
  return id ? ROLES.find((r) => r.id === id) ?? null : null;
}

// ── 配置弹窗：面板 model 与快照 config 双向对齐（秒↔毫秒换算住这里）──
const sheetOpen = ref(false);
const cfg = reactive<ConfigModel>({
  turnCap: 15,
  maxHp: 10,
  windowSeconds: 30,
  restSeconds: 10,
  timerMode: "world",
  maliceLevel: "mild",
  maliceEvery: 3,
});

function fromLobbyConfig(c: LobbyConfig): ConfigModel {
  return {
    turnCap: c.turnCap,
    maxHp: c.maxHp,
    windowSeconds: Math.round(c.windowMs / 1000),
    restSeconds: Math.round(c.restMs / 1000),
    timerMode: c.timerMode,
    maliceLevel: c.maliceLevel,
    maliceEvery: c.maliceEvery,
  };
}

function toLobbyConfig(m: ConfigModel): LobbyConfig {
  return {
    turnCap: m.turnCap,
    maxHp: m.maxHp,
    windowMs: m.windowSeconds * 1000,
    restMs: m.restSeconds * 1000,
    timerMode: m.timerMode,
    maliceLevel: m.maliceLevel,
    maliceEvery: m.maliceEvery,
  };
}

watch(
  () => snap.value?.config,
  (c) => {
    if (!c) return;
    // 房主+弹窗开=编辑中：本地 model 优先，快照别回拉（拖滑条途中他人选角/加假人的广播
    // 会带同一份 config，无守卫会把滑条拽回服务器旧值）。关着弹窗/非房主=始终以服务器为准。
    if (amHost.value && sheetOpen.value) return;
    Object.assign(cfg, fromLobbyConfig(c));
  },
  { immediate: true },
);

/** 开弹窗先对齐一次快照（上次编辑后服务器可能拒过/改过） */
function openSheet(): void {
  const c = snap.value?.config;
  if (c) Object.assign(cfg, fromLobbyConfig(c));
  sheetOpen.value = true;
}

/** 面板落定沿（滑条松手/选项点选）→ 上行 setConfig；ack 快照回来再对齐（幂等） */
function sendConfig(): void {
  if (!amHost.value || started.value) return;
  roomStore.setConfig(toLobbyConfig(cfg));
}

const configSummary = computed(() => {
  const c = snap.value?.config;
  if (!c) return "";
  const mode = c.timerMode === "turn" ? "轮班·限时" : "世界·即时";
  const malice =
    c.maliceLevel === "off" ? "无恶意" : `恶意${c.maliceLevel === "mild" ? "温和" : "猛"}/每${c.maliceEvery}回合`;
  return `${c.turnCap} 回合 · ${c.maxHp}❤ · ${Math.round(c.windowMs / 1000)}s 窗 · ${mode} · ${malice}`;
});

// ── 角色详情浮层（查看类不切页）──
const detailRole = ref<RoleId | null>(null);
const detail = computed(() => roleOf(detailRole.value));
</script>

<template>
  <div class="roomLobby">
    <header class="head">
      <h1>🛖 房间大厅</h1>
      <p class="sub">{{ started ? "已按下开始，正在开局……" : "明选角色、等人进房，房主配好局就能开" }}</p>
    </header>

    <div v-if="roomStore.banner.value" class="banner">
      <span>{{ roomStore.banner.value }}</span>
      <div class="bannerBtns">
        <button type="button" @click="roomStore.reconnect()">重新连接</button>
        <button type="button" @click="roomStore.backHome()">回首页</button>
      </div>
    </div>

    <section class="card">
      <h2>📡 房间码</h2>
      <div class="codeRow">
        <span class="code">{{ roomStore.code.value }}</span>
        <button class="copy" type="button" @click="roomStore.copyInvite()">📋 复制邀请链接</button>
      </div>
      <p class="hint">朋友输码进房，或点链接直达（码已自动填好）{{ started ? "；已开局，新面孔进不来了" : "" }}。</p>
    </section>

    <section class="card">
      <h2>🪑 座位（{{ humansCount }} 真人 + {{ botsCount }} 假人 · 共 {{ seats.length }}/{{ MAX_SEATS }}）</h2>
      <ul class="seats">
        <li v-for="s in seats" :key="s.seat" :class="{ off: !s.bot && !s.online }">
          <span class="no">{{ s.seat + 1 }}</span>
          <span class="name">{{ s.name }}<i v-if="isMe(s.seat)" class="me">（你）</i></span>
          <span v-if="s.host" class="crown">👑 房主</span>
          <span class="role" :class="{ picked: !!s.roleId }">
            <template v-if="roleOf(s.roleId)">{{ roleOf(s.roleId)!.emoji }} {{ roleOf(s.roleId)!.name }}</template>
            <template v-else-if="s.bot">🎲 随机</template>
            <template v-else>未选</template>
          </span>
          <span v-if="s.bot" class="botTag">🤖 假人</span>
          <span v-else class="dot" :class="{ on: s.online }">{{ s.online ? "在线" : "离线" }}</span>
        </li>
      </ul>
      <p v-if="!started && emptySeats > 0" class="hint">还差 {{ emptySeats }} 个座位；人不够房主可加假人凑局。</p>
    </section>

    <template v-if="!started">
      <section class="card">
        <h2>🎭 明选角色（可重复选）</h2>
        <div class="roles">
          <div
            v-for="r in ROLES"
            :key="r.id"
            class="roleCard"
            :class="{ on: myRole === r.id }"
            @click="roomStore.pickRole(r.id)"
          >
            <div class="face">{{ r.emoji }}</div>
            <div class="rname">{{ r.name }}</div>
            <button class="info" type="button" @click.stop="detailRole = r.id">ⓘ</button>
          </div>
        </div>
        <p class="hint">{{ myRole ? `你已选「${roleOf(myRole)!.name}」，点其他卡可换选` : "不选也行——开局默认轻装上阵" }}；属性只在详情弹层展示。</p>
      </section>

      <section class="card">
        <h2>⚙️ 开局配置</h2>
        <p class="summary">{{ configSummary }}</p>
        <button class="cfgBtn" type="button" @click="openSheet()">
          {{ amHost ? "🔧 修改配置" : "👀 只读预览" }}
        </button>
        <p class="hint">{{ amHost ? "改配置全员实时可见；开局后数值冻结。" : "配置由房主调整，此处仅供预览。" }}</p>
      </section>
    </template>

    <section v-else class="card startedCard">
      <h2>🎴 开局中</h2>
      <p class="hint">房主已按下开始，正在开局——暗牌抽选与棋局画面随后就到。</p>
    </section>

    <footer class="foot">
      <button
        v-if="amHost && !started"
        class="start"
        type="button"
        :disabled="seats.length < 2"
        @click="roomStore.startGame()"
      >🎴 抽暗牌 · 开始</button>
      <p v-else-if="!amHost && !started" class="waitHint">等房主按下开始</p>
      <div class="footBtns">
        <button v-if="amHost" class="danger" type="button" @click="roomStore.dissolve()">💥 解散房间</button>
        <button class="ghost" type="button" @click="roomStore.leave()">🚪 离房</button>
      </div>
      <p v-if="amHost && !started && seats.length < 2" class="hint">至少 2 人才能开局——人不够可先加假人。</p>
    </footer>

    <!-- 房主配置弹窗（与单机同一套 ConfigPanel；非房主只读预览；浮层原则不切页） -->
    <BaseSheet v-if="sheetOpen" @close="sheetOpen = false">
      <div class="sheetBody">
        <h3 class="sheetTitle">{{ amHost ? "⚙️ 开局配置（房主）" : "⚙️ 开局配置（预览）" }}</h3>

        <div class="botsRow">
          <span class="lab">同桌几人</span>
          <span v-if="amHost" class="stepper">
            <button type="button" :disabled="botsCount <= 0" @click="roomStore.removeBot()">−</button>
            <span class="val">{{ botsCount }} 假人</span>
            <button type="button" :disabled="!canAddBot" @click="roomStore.addBot()">＋</button>
          </span>
          <span v-else class="note">{{ botsCount }} 假人 · 共 {{ seats.length }} 人局（房主调配）</span>
        </div>
        <p class="hint">假人由服务器代打（超时替掷同一条路径），两三个人也能开一局。</p>

        <ConfigPanel :model="cfg" :readonly="!amHost" @change="sendConfig()" />

        <button class="close" type="button" @click="sheetOpen = false">收 起</button>
      </div>
    </BaseSheet>

    <!-- 角色详情弹层（同单机大厅形态） -->
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
.roomLobby {
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
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: #4e342e;
  border: 1px solid #bf360c;
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 12.5px;
}
.bannerBtns {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}
.bannerBtns button {
  border: 1px solid #8d6e63;
  background: #3e2723;
  color: #ffe0b2;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 700;
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
.codeRow {
  display: flex;
  align-items: center;
  gap: 10px;
}
.code {
  font-size: 24px;
  font-weight: 900;
  letter-spacing: 0.25em;
  background: #263238;
  border: 1px dashed #78909c;
  border-radius: 10px;
  padding: 6px 10px 6px 14px;
}
.copy {
  border: 1px solid #455a64;
  background: #263238;
  color: #cfd8dc;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 12.5px;
  font-weight: 700;
}
.hint {
  font-size: 11px;
  color: #90a4ae;
  margin: 8px 0 0;
}
.seats {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.seats li {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #263238;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 13px;
}
.seats li.off {
  opacity: 0.55;
}
.no {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  background: #37474f;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 800;
  color: #b0bec5;
}
.name {
  flex: 1;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.me {
  font-style: normal;
  font-size: 11px;
  color: #ffb74d;
}
.crown {
  font-size: 11.5px;
  color: #ffd54f;
  flex: 0 0 auto;
}
.role {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: #90a4ae;
  background: #1c2933;
  border-radius: 999px;
  padding: 3px 9px;
  white-space: nowrap;
}
.role.picked {
  color: #ffcc80;
  background: #33261c;
}
.botTag {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: #81d4fa;
}
.dot {
  font-size: 10.5px;
  color: #90a4ae;
  flex: 0 0 auto;
}
.dot.on {
  color: #81c784;
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
.summary {
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 700;
  color: #cfd8dc;
}
.cfgBtn {
  width: 100%;
  border: 1px solid #455a64;
  background: #263238;
  color: #eceff1;
  border-radius: 10px;
  padding: 9px;
  font-size: 13px;
  font-weight: 700;
}
.startedCard {
  border-color: rgba(255, 213, 79, 0.4);
}
.startedCard h2 {
  color: #ffd54f;
}
.foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 6px;
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
.start:disabled {
  opacity: 0.45;
  box-shadow: none;
}
.waitHint {
  text-align: center;
  font-size: 12px;
  color: #90a4ae;
  margin: 4px 0;
}
.footBtns {
  display: flex;
  gap: 8px;
}
.footBtns .danger {
  flex: 1;
}
.danger {
  border: 0;
  border-radius: 12px;
  background: #8e2418;
  color: #ffebee;
  font-size: 13px;
  font-weight: 800;
  padding: 11px;
}
.ghost {
  flex: 1;
  border: 1px solid #455a64;
  background: #263238;
  color: #cfd8dc;
  border-radius: 12px;
  padding: 11px;
  font-size: 13.5px;
  font-weight: 700;
}
.sheetTitle {
  margin: 0 0 10px;
  font-size: 15px;
}
.botsRow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0 2px;
}
.lab {
  width: 96px;
  flex: 0 0 auto;
  font-size: 12.5px;
  color: #cfd8dc;
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
.close {
  width: 100%;
  border: 1px solid #455a64;
  background: #263238;
  color: #cfd8dc;
  border-radius: 12px;
  padding: 10px;
  font-size: 13px;
  font-weight: 700;
  margin-top: 12px;
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
</style>

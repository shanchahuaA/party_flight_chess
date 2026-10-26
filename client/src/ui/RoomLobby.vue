<script setup lang="ts">
/**
 * 房间大厅真形态（M2-T4#41 大厅页 + M2-T6#43 对局面接入）：
 * - lobby 态：座位列（角色明选/在线/到齐）+ 房主配置弹窗（共用 ConfigPanel，非房主只读预览）+
 *   假人步进（房主）+ 开始按钮（仅房主）。
 * - playing 态（大厅面收口）：「对局已组建」卡 + 内嵌 SecretDraft 暗牌浮层（自包含，drafting 且
 *   本人未定谳自动悬出；仅自己可见的选项是服务端裁剪保证的）——对局画面接通由 App 按源状态分流。
 * - intermission 态（局间真形，#42 定案 phase 三值换代）：配置面板（现有 sheet 流）+ 假人步进 +
 *   房主「🎴 开下一局」（startGame）+ 上一局结算摘要卡（roomStore.lastSettlement 局间缓存；
 *   详情点「回看战况」开全屏 BaseSheet 文字流——不是 Settlement.vue 整页横生）。
 * 角色被动等查看类走浮层（弹窗原则）：角色详情与配置面板都是 BaseSheet。
 */
import { computed, reactive, ref, watch } from "vue";
import { ROLES, secretGoal } from "../../../kernel/src";
import type { MessageEntry, RoleDef, RoleId, SettlementRow } from "../../../kernel/src";
import { MAX_BOTS, MAX_SEATS, type LobbyConfig } from "../../../shared/protocol";
import { roomStore } from "../net/roomStore";
import { gameStore } from "../game/store";
import BaseSheet from "./BaseSheet.vue";
import ConfigPanel, { type ConfigModel } from "./ConfigPanel.vue";
import SecretDraft from "./SecretDraft.vue";
import { CULPRIT_META, MEDALS } from "./Settlement.vue";

const snap = computed(() => roomStore.snapshot.value);
const amHost = computed(() => snap.value?.hostSeat === roomStore.mySeat.value);
const phase = computed(() => snap.value?.phase ?? "lobby");
// M2-T6（#43）：T5 的 started shim 退役——playing=对局进行中（大厅面收口+暗牌区/画面接通等待）；
// intermission=局间真形（配置/选角/开局权限面与服务端 lobbyGate 同口径：lobby|intermission 同闸）。
const inPlay = computed(() => phase.value === "playing");
/** playing 卡文案：源里 drafting=抽暗牌等待；无源（首条 game 消息未到/瞬间暂态）=接通等待 */
const playHint = computed(() =>
  gameStore.state.value?.phase === "drafting"
    ? "抽暗牌后进局；暗牌只有你自己看得见，选完对局画面会自动接上。"
    : "对局进行中——对局画面即将接通……",
);
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

// ── 局间真形（M2-T6）：上一局结算摘要卡+回看战况（数据=roomStore.lastSettlement 局间缓存）──
const lastSettle = computed(() => roomStore.lastSettlement.value);
const reviewOpen = ref(false);

/** 名次序（与结算页同口径：总分降序、同分按 pid——缓存态已按收者视角 rebase，我恒 pid 0） */
const rankedRows = computed<SettlementRow[]>(() => {
  const rows = lastSettle.value?.settlement.rows ?? [];
  return [...rows].sort((a, b) => b.total - a.total || a.pid - b.pid);
});function settleName(pid: number): string {
  return lastSettle.value?.state.players[pid]?.name ?? `玩家${pid}`;
}

/** 暗牌亮牌仅限自己（他人 secretOptions 被服务端保形置零——亮牌无真值，恰是保密口径） */
function myGoalOf(row: SettlementRow) {
  if (row.pid !== 0) return null;
  const p = lastSettle.value?.state.players[0];
  const pick = p?.secretPick;
  if (!p || pick == null) return null;
  return secretGoal(p.secretOptions[pick]!);
}
function myGoalAchieved(row: SettlementRow): boolean {
  const g = myGoalOf(row);
  return !!g && row.goalNos.includes(g.no);
}

/** 回看战报文字流数据源：终局态快照里的战报尾片（服务端尾片 200 条，终局收束章必含） */
const reportMsgs = computed<MessageEntry[]>(() => lastSettle.value?.state.messages ?? []);

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

/** 面板落定沿（滑条松手/选项点选）→ 上行 setConfig；ack 快照回来再对齐（幂等）。
 *  playing 态收口（服务端 lobbyGate 把大厅动作锁到 lobby|intermission 放行）。 */
function sendConfig(): void {
  if (!amHost.value || inPlay.value) return;
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
      <p class="sub">
        {{
          inPlay
            ? "对局进行中——大厅已收口，抽暗牌后接进对局画面"
            : phase === "intermission"
              ? "上一局收官——改配置、选角，房主可开下一局"
              : "明选角色、等人进房，房主配好局就能开"
        }}
      </p>
    </header>

    <div class="seatNoteBar">
      <p class="hint" style="margin: 0">
        断线不丢座：掉线后棋子由系统暂管，随时自动重连归队（M2-T8）。房主可对在线异常者「🥾 请出」。
      </p>
    </div>

    <section class="card">
      <h2>📡 房间码</h2>
      <div class="codeRow">
        <span class="code">{{ roomStore.code.value }}</span>
        <button class="copy" type="button" @click="roomStore.copyInvite()">📋 复制邀请链接</button>
      </div>
      <p class="hint">朋友输码进房，或点链接直达（码已自动填好）{{ phase !== "lobby" ? "；已开局，新面孔进不来了" : "" }}。</p>
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
          <!-- 踢人（M2-T8，#45）：仅房主可见、真人且非自己；被踢者即刻断连+拉黑至房间销毁 -->
          <button
            v-if="amHost && !s.bot && !isMe(s.seat)"
            class="kick"
            type="button"
            title="请出：断其连接、身份拉黑至房间销毁（棋子转自动掷骰）"
            @click="roomStore.kick(s.seat)"
          >🥾</button>
        </li>
      </ul>
      <p v-if="!inPlay && emptySeats > 0" class="hint">还差 {{ emptySeats }} 个座位；人不够房主可加假人凑局。</p>
    </section>

    <template v-if="!inPlay">
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
        <p class="hint">{{ amHost ? "改配置全员实时可见；下一局开始后数值冻结。" : "配置由房主调整，此处仅供预览。" }}</p>
      </section>
    </template>

    <!-- 对局进行中（大厅面收口，M2-T6）：SecretDraft 自包含浮层——drafting 且本人未定谳时自动悬出；
         暗牌/手牌/报备单的「仅自己可见」全部由服务端裁剪保证，浮层零 bespoke -->
    <section v-if="inPlay" class="card startedCard">
      <h2>🎴 对局已组建</h2>
      <p class="hint">{{ playHint }}</p>
      <SecretDraft />
    </section>

    <!-- 局间真形（M2-T6）：上一局结算摘要（局间缓存）+ 回看战况；无缓存（页中刷新等）只出休整说明 -->
    <section v-if="phase === 'intermission'" class="card interCard">
      <template v-if="lastSettle">
        <h2>🏁 上一局结算</h2>
        <div class="interHead">
          <p v-if="rankedRows[0]" class="winLine">
            「{{ settleName(rankedRows[0].pid) }}」以 <b>{{ rankedRows[0].total }}</b> 分登顶
          </p>
          <span v-if="lastSettle.settlement.groupFail" class="stampSmall">💀 群体失败</span>
        </div>
        <ul class="interRows">
          <li v-for="(r, i) in rankedRows.slice(0, 3)" :key="r.pid" :class="{ me: r.pid === 0 }">
            <span class="md">{{ MEDALS[i] ?? `#${i + 1}` }}</span>
            <span class="mn">{{ settleName(r.pid) }}<i v-if="r.pid === 0">（我）</i></span>
            <span class="mt">{{ r.total }} 分</span>
          </li>
        </ul>
        <p v-if="rankedRows.length > 3" class="hint">其余 {{ rankedRows.length - 3 }} 人名次详见「回看战况」。</p>
        <button class="ghost review" type="button" @click="reviewOpen = true">📜 回看战况</button>
      </template>
      <template v-else>
        <h2>🎲 局间休整</h2>
        <p class="hint">上一局已收官——改配置、明选角色、凑人；房主可开下一局（每局新种子）。</p>
      </template>
    </section>

    <footer class="foot">
      <button
        v-if="amHost && !inPlay"
        class="start"
        type="button"
        :disabled="seats.length < 2"
        @click="roomStore.startGame()"
      >{{ phase === "intermission" ? "🎴 开下一局" : "🎴 抽暗牌 · 开始" }}</button>
      <p v-else-if="!amHost && !inPlay" class="waitHint">
        {{ phase === "intermission" ? "等房主开下一局" : "等房主按下开始" }}
      </p>
      <div class="footBtns">
      <button v-if="amHost" class="danger" type="button" @click="roomStore.dissolve()">💥 解散房间</button>
      <!-- 对局中（playing）服务端封禁离席（名册 boot 定死）；断线治理=自动重连归队（M2-T8）——别出假按钮 -->
      <button v-if="!inPlay" class="ghost" type="button" @click="roomStore.leave()">🚪 离房</button>
    </div>
    <p v-if="inPlay" class="hint">对局中不可离席；掉线后自动重连归队，棋子由系统暂管（超时替掷）。房主可请出座位。</p>
      <p v-if="amHost && !inPlay && seats.length < 2" class="hint">至少 2 人才能开局——人不够可先加假人。</p>
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

    <!-- 上一局战况回看（局间；BaseSheet 文字流——非 Settlement.vue 整页横生；战报抽屉本体在下局对局面内） -->
    <BaseSheet v-if="reviewOpen" @close="reviewOpen = false">
      <div class="sheetBody">
        <h3 class="sheetTitle">📜 上一局战况回看</h3>
        <p class="hint">局间缓存呈现；下一局开局后本页销账。</p>

        <section class="rankList">
          <div v-for="(r, i) in rankedRows" :key="r.pid" class="rankRow" :class="{ me: r.pid === 0 }">
            <div class="rankLine">
              <span class="md">{{ MEDALS[i] ?? `#${i + 1}` }}</span>
              <span class="nm">{{ settleName(r.pid) }}<i v-if="r.pid === 0">（我）</i></span>
              <span class="tt">{{ r.total }}<small>分</small></span>
            </div>
            <div class="its">
              <span>进度 +{{ r.progress }}</span>
              <span>通关 +{{ r.finish }}<template v-if="r.finishRank">（第 {{ r.finishRank }} 位）</template></span>
              <span>存活 +{{ r.survive }}</span>
              <span>称号 +{{ r.titleScore }}<template v-if="r.goalNos.length">（{{ r.goalNos.length }} 条）</template></span>
              <span>整蛊 +{{ r.grudgeScore }}（{{ r.grudgeCount }} 次）</span>
            </div>
            <div class="gList">
              <template v-if="r.goalsVoided">
                <span class="voided">🖋 称号作废</span>
              </template>
              <template v-else-if="r.goalNos.length">
                <span v-for="no in r.goalNos" :key="no" class="gTag">{{ secretGoal(no).title }}</span>
              </template>
              <template v-else>
                <span class="noTitle">—</span>
              </template>
            </div>
            <p class="dark" v-if="myGoalOf(r)">
              🎯 暗牌「{{ myGoalOf(r)!.title }}」
              <b v-if="r.goalsVoided" class="voidTxt">作废</b>
              <b v-else-if="myGoalAchieved(r)" class="hitTxt">达成 ✓</b>
              <b v-else class="missTxt">未达成</b>
            </p>
          </div>
        </section>

        <div v-if="lastSettle?.settlement.groupFail" class="failLine">
          💀 群体失败——全员倒在最后一波，暗牌目标作废（含已达成）。
        </div>

        <section class="cullBox">
          <h4>🧾 找战犯</h4>
          <p v-if="!lastSettle?.settlement.culprits.length" class="hint">查无战犯，皆大欢喜。</p>
          <div v-for="(c, i) in lastSettle?.settlement.culprits ?? []" :key="i" class="cRow">
            <div class="cHead">
              <span class="cIcon">{{ CULPRIT_META[c.kind].icon }}</span>
              <span class="cName">{{ settleName(c.pid) }}</span>
              <span class="cKind">{{ CULPRIT_META[c.kind].label }}</span>
            </div>
            <p class="cDetail">{{ c.detail }}</p>
            <p v-if="c.evidence.length" class="cEvi">证据：战报条目 {{ c.evidence.map((id) => `#${id}`).join(" ") }}</p>
          </div>
        </section>

        <section class="reportBox">
          <h4>📜 战报（尾片 {{ reportMsgs.length }} 条）</h4>
          <div class="rList">
            <template v-for="(m, i) in reportMsgs" :key="m.id">
              <div v-if="i === 0 || m.turn !== reportMsgs[i - 1]!.turn" class="rTurn">📜 ── 回合 {{ m.turn }} ──</div>
              <div class="rRow" :class="{ big: m.emphasis === 'big' }">{{ m.text }}</div>
            </template>
            <div v-if="!reportMsgs.length" class="hint">战报尾片为空（旧账缺省）。</div>
          </div>
        </section>

        <button class="close" type="button" @click="reviewOpen = false">收 起</button>
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
/* 踢人（M2-T8）：座位行内的低调小钮 */
.kick {
  flex: 0 0 auto;
  border: 0;
  background: rgba(142, 36, 24, 0.25);
  color: #ef9a9a;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  font-size: 12px;
}
.seatNoteBar {
  margin: 0;
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

/* ── 局间真形（M2-T6）：结算摘要卡 ── */
.interCard {
  border-color: rgba(255, 213, 79, 0.4);
}
.interCard h2 {
  color: #ffd54f;
}
.interHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.winLine {
  margin: 0;
  font-size: 12.5px;
  color: #b0bec5;
}
.winLine b {
  color: #ffd54f;
  font-size: 15px;
}
.stampSmall {
  flex: 0 0 auto;
  transform: rotate(-8deg);
  border: 2px double #ef5350;
  color: #ef5350;
  border-radius: 8px;
  padding: 2px 8px;
  font-size: 12px;
  font-weight: 900;
  background: rgba(239, 83, 80, 0.1);
}
.interRows {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.interRows li {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #263238;
  border-radius: 10px;
  padding: 7px 10px;
  font-size: 13px;
}
.interRows li.me {
  border: 1px solid #ef5350;
  background: #37474f;
}
.interRows .md {
  font-size: 15px;
  flex: 0 0 24px;
  text-align: center;
}
.interRows .mn {
  flex: 1;
  font-weight: 700;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.interRows .mn i {
  font-style: normal;
  font-size: 10.5px;
  color: #ff8a80;
}
.interRows .mt {
  font-weight: 900;
  color: #ffd54f;
}
.ghost.review {
  margin-top: 10px;
  width: 100%;
}

/* ── 局间回看 sheet（BaseSheet 文字流）── */
.rankList {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.rankRow {
  background: #263238;
  border: 1px solid rgba(176, 190, 197, 0.25);
  border-radius: 12px;
  padding: 8px 10px;
}
.rankRow.me {
  border-color: #ef5350;
  background: #37474f;
}
.rankLine {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.md {
  font-size: 15px;
  flex: 0 0 28px;
  text-align: center;
}
.nm {
  flex: 1;
  font-size: 13.5px;
  font-weight: 800;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nm i {
  font-style: normal;
  font-size: 10.5px;
  color: #ff8a80;
}
.tt {
  font-size: 17px;
  font-weight: 900;
  color: #ffd54f;
}
.tt small {
  font-size: 10px;
  font-weight: 400;
  color: #b0bec5;
  margin-left: 2px;
}
.its {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-top: 6px;
}
.its span {
  font-size: 10.5px;
  color: #b0bec5;
  background: rgba(16, 24, 32, 0.6);
  border-radius: 999px;
  padding: 2px 8px;
}
.gList {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
  min-height: 20px;
  align-items: center;
}
.gTag {
  font-size: 11px;
  font-weight: 700;
  color: #cfd8dc;
  background: rgba(16, 24, 32, 0.6);
  border: 1px solid #455a64;
  border-radius: 8px;
  padding: 2px 8px;
}
.voided {
  font-size: 11px;
  font-weight: 800;
  color: #ef5350;
  border: 1.5px dashed #ef5350;
  border-radius: 8px;
  padding: 1px 8px;
  transform: rotate(-2deg);
}
.noTitle {
  font-size: 11px;
  color: #546e7a;
}
.dark {
  margin: 7px 0 0;
  font-size: 10.5px;
  color: #90a4ae;
}
.dark b {
  font-weight: 800;
  margin-left: 4px;
}
.hitTxt {
  color: #66bb6a;
}
.missTxt {
  color: #90a4ae;
}
.voidTxt {
  color: #ef5350;
}
.failLine {
  margin-top: 10px;
  border: 2px double #ef5350;
  border-radius: 10px;
  color: #ef9a9a;
  font-size: 12px;
  padding: 8px 10px;
  background: rgba(239, 83, 80, 0.08);
}
.cullBox,
.reportBox {
  margin-top: 12px;
  border: 1px solid rgba(176, 190, 197, 0.25);
  border-radius: 12px;
  padding: 10px 12px 12px;
}
.cullBox h4,
.reportBox h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: #eceff1;
}
.cRow {
  border-top: 1px dashed rgba(176, 190, 197, 0.2);
  padding: 7px 0;
}
.cRow:first-of-type {
  border-top: 0;
  padding-top: 0;
}
.cHead {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.cIcon {
  font-size: 13px;
}
.cName {
  font-size: 12.5px;
  font-weight: 800;
}
.cKind {
  font-size: 10.5px;
  color: #ef9a9a;
  background: rgba(239, 83, 80, 0.12);
  border-radius: 999px;
  padding: 1px 8px;
}
.cDetail {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: #b0bec5;
  line-height: 1.5;
}
.cEvi {
  margin: 4px 0 0;
  font-size: 10.5px;
  color: #78909c;
}
.rList {
  margin-top: 4px;
  max-height: 40vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.rTurn {
  margin: 8px 0 2px;
  font-size: 10.5px;
  font-weight: 700;
  color: #ffb74d;
  text-align: center;
  border-top: 1px dashed #546e7a;
  padding-top: 6px;
}
.rList > :first-child .rTurn {
  margin-top: 0;
}
.rRow {
  font-size: 12px;
  color: #cfd8dc;
  padding: 2px 0;
  line-height: 1.45;
}
.rRow.big {
  color: #ffd54f;
}
</style>

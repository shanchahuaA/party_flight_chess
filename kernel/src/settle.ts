/**
 * 结算判定核（#36 T8b1，内容数值表 §5.1 五项积分 + 表四十条称号 + 找战犯聚合）：
 *
 * **纯聚合**——输入权威 GameState，折叠一次出完整结算（无副作用）：
 *   计数真源=**战报流**（state.messages：append-only 可完整重建，发射点挂 MsgTag 结构化标签——
 *   禁解析中文文案，延续「结构化事实替代文案正则」纪律）；点名时点的状态真源=state（净步/血量/
 *   手牌/通关席——「结算时」点值，定义上就是状态读）。判定不散接线：不挂任何计数器字段。
 *
 * 口径（实现期定案回账点=数值表 §5.1 注记）：
 *   - 进度分：负净步 0 保底不倒扣（负数倒扣超出「≈5–8 分」量级叙事的意图）；
 *   - 称号分/整蛊分：群体失败只作废暗牌目标（称号），整蛊分 ±不折损；
 *   - 淘汰者：已达成事实照判保留（dogKilled/gambleWin/整蛊……），「活到结算」型（幸存者/硬骨头）自然失败；
 *   - 海关清白：整局至少开过一张海关风云且本人零「命中谎报」（无人开窗=无处全程，不发空头清白）；
 *   - 环境负面：任一来源的气候负面都算（气候是全桌单槽——自己打的雷暴劈自己也是吃了）。
 */
import { SECRET_GOALS, type SecretGoalDef } from "./data/goals";
import { HEALING_ITEM_IDS, itemCard } from "./data/items";
import type { CulpritReport, GameState, MsgTag, PlayerState, SettlementResult, SettlementRow } from "./types";

/** 通关分分位（#35 T8a1 落定、#36 T8b1 迁位收拢——数值表 §5.1 真源）：首通 +10／次通 +8／第三 +6，第四位起无分位。 */
export const FINISH_SCORES = [10, 8, 6];
export function finishScore(rank: number): number {
  return FINISH_SCORES[rank - 1] ?? 0;
}

/** 称号分/条（表五 §5.1 真源） */
export const TITLE_SCORE = 8;
/** 存活分（表五 §5.1 真源） */
export const SURVIVE_SCORE = 4;
/** 整蛊分/次（表五 §5.1 真源） */
export const GRUDGE_SCORE = 2;
/** 进度分除数（表五 §5.1：净步 ÷10 向下取整） */
export const PROGRESS_DIVISOR = 10;

/** 战报流折叠出的计数账：每标签每玩家的落账条目 id（count=id 数） */
export interface TagCounts {
  count(tag: MsgTag, pid: number): number;
  evidence(tag: MsgTag, pid: number): number[];
  /** 某玩家名下的出局手牌散落条目（cards=归还卡 id；缺省=没散过牌） */
  retiredHand(pid: number): { msgId: number; cards: string[] } | null;
  /** 某标签全桌总量（海关「窗存在过」判据用） */
  total(tag: MsgTag): number;
}

/** 折叠战报流（T8b1 唯一计数收口）：发射点挂的 MsgTag 全数落账——谁/挂哪条 id 都留着 */
export function foldTags(messages: GameState["messages"]): TagCounts {
  const byTag = new Map<MsgTag, Map<number, number[]>>();
  const totals = new Map<MsgTag, number>();
  const retired = new Map<number, { msgId: number; cards: string[] }>();
  for (const m of messages) {
    for (const t of m.tags ?? []) {
      totals.set(t, (totals.get(t) ?? 0) + 1);
      if (m.who != null) {
        const perPlayer = byTag.get(t) ?? new Map<number, number[]>();
        const ids = perPlayer.get(m.who) ?? [];
        ids.push(m.id);
        perPlayer.set(m.who, ids);
        byTag.set(t, perPlayer);
      }
    }
    if (m.tags?.includes("retiredHand") && m.who != null && m.cards?.length) {
      retired.set(m.who, { msgId: m.id, cards: m.cards });
    }
  }
  return {
    count: (tag, pid) => byTag.get(tag)?.get(pid)?.length ?? 0,
    evidence: (tag, pid) => byTag.get(tag)?.get(pid) ?? [],
    retiredHand: (pid) => retired.get(pid) ?? null,
    total: (tag) => totals.get(tag) ?? 0,
  };
}

/** 单条称号判定（表四逐条；target=0 的无目标值条读布尔） */
function goalAchieved(p: PlayerState, goal: SecretGoalDef, tags: TagCounts): boolean {
  switch (goal.counter) {
    case "survive":
      return !p.dead;
    case "finish":
      return p.zone === "done"; // 通关席=踩进旗位（finishers 名次供分位，达成事实看 zone）
    case "grudge":
      return tags.count("grudge", p.id) >= goal.target;
    case "handAtEnd":
      return p.hand.length >= goal.target;
    case "gamble":
      return tags.count("gambleWin", p.id) >= goal.target;
    case "customs":
      // 「零违规」=窗存在过、本人零「命中谎报」、且零「查验清白」（查错人白赔=海关记录不清白——
      // 与找战犯「查验查错人」同账：又赔卡又拿清白称号=内在矛盾，评审收口）；无人开窗=无处全程不发空头清白
      return tags.total("customsOpen") > 0 && tags.count("customsLied", p.id) === 0 && tags.count("customsClean", p.id) === 0;
    case "dogs":
      return tags.count("dogKilled", p.id) >= goal.target;
    case "hpAtEnd":
      return p.hp >= goal.target;
    case "hitsTaken":
      return !p.dead && tags.count("hpLost", p.id) >= goal.target; // 「仍活着」=活到结算型
    case "ambient":
      return tags.count("ambientPlayed", p.id) >= goal.target && tags.count("ambientDown", p.id) === 0;
  }
}

/** 找战犯三类聚合（GLOSSARY：只给数据不做裁决；evidence=可溯源战报条目 id） */
function aggregateCulprits(state: GameState, tags: TagCounts): CulpritReport[] {
  const culprits: CulpritReport[] = [];
  for (const p of state.players) {
    if (tags.count("itemPlayed", p.id) === 0) {
      culprits.push({ kind: "noCardsPlayed", pid: p.id, detail: `${p.name} 整局没打过卡（0 次出手）`, evidence: [] });
    }
    const rh = tags.retiredHand(p.id);
    if (p.dead && rh) {
      const heals = rh.cards.filter((id) => HEALING_ITEM_IDS.includes(id)).map((id) => itemCard(id).title);
      if (heals.length > 0) {
        culprits.push({
          kind: "healedToDeath",
          pid: p.id,
          detail: `${p.name} 把治疗吞到死——出局时手里还有：${heals.join("、")}`,
          evidence: [rh.msgId],
        });
      }
    }
    const wrong = tags.evidence("customsClean", p.id);
    if (wrong.length > 0) {
      culprits.push({
        kind: "wrongCheck",
        pid: p.id,
        detail: `${p.name} 查验查错人 ${wrong.length} 次（每查错一次白赔 1 张）`,
        evidence: wrong,
      });
    }
  }
  return culprits;
}

/** 终局结算：纯聚合一次（finishEndgame 收束当拍调用；呈现=T8b2 结算页消费 state.endgame.settlement） */
export function computeSettlement(state: GameState): SettlementResult {
  const tags = foldTags(state.messages);
  const groupFail = state.endgame?.groupFail === true;
  const rows: SettlementRow[] = state.players.map((p) => {
    const finishRank = state.finishers.indexOf(p.id);
    const finish = finishRank >= 0 ? finishScore(finishRank + 1) : 0;
    const survive = p.dead ? 0 : SURVIVE_SCORE;
    const grudgeCount = tags.count("grudge", p.id);
    const grudgeScore = grudgeCount * GRUDGE_SCORE;
    const goalNos = groupFail ? [] : SECRET_GOALS.filter((g) => goalAchieved(p, g, tags)).map((g) => g.no);
    const titleScore = goalNos.length * TITLE_SCORE;
    const progress = Math.max(0, Math.floor(p.net / PROGRESS_DIVISOR));
    const total = progress + finish + survive + titleScore + grudgeScore;
    return {
      pid: p.id,
      progress,
      finishRank: finishRank >= 0 ? finishRank + 1 : null,
      finish,
      survive,
      goalNos,
      goalsVoided: groupFail,
      titleScore,
      grudgeCount,
      grudgeScore,
      total,
    };
  });
  return { groupFail, rows, culprits: aggregateCulprits(state, tags) };
}

/**
 * 陷阱格 14 格全检定定制（内容数值表 · §5.4，#33 T5b）。
 *
 * 陷阱是**格子属性**不是卡（事件定案 §3.3——不走牌池、不占抽卡）：踩上先掷对应轴检定逃生
 * （1d20+轴 vs 卡面 DC），通过=免伤或仅小惩罚，失败=吃该格负面，骰 1 大失败=负面加重一档
 * （单格自带 onCritFail）。轴与 DC 逐格自带：平原 DC 全 8（易档，安全大道）／雪山 10（中距，
 * 险径）／戈壁 12（中档，死路宝地）；轴默认敏（表五「敏=陷阱检定」），个别特殊陷阱改其它轴
 * ——力=捕兽夹挣脱／流沙挣扎，运=赌运石（§5.4 戈壁？位候选格按表定案收口：过=摸 2 张道具卡，
 * 败=扣 1 血）。
 *
 * 落位：各生态陷阱格**按格 id 序**与下表逐一配对（board 类型灌装固定种子逐环境一致、
 * board.test 锚定；本文件校验块在 load 时炸数据坏账）。负面通路全走既有原语与既有管道：
 * 扣血=hp 原语（applyHpDelta 单入口——护身符/皮糙肉厚盾照拦，T5a）、退格=back（T1 走格）、
 * 罚停=skip（T3a 罚停窗）、弃卡=discard（T4a 手牌池，随机抽牌弃入弃牌堆）、传送=teleport
 * （净步保留、来路清空——与偷天换日同口径）、削面=rollMod cut（T4a 走格骰修正四原语）、
 * 禁道具=itemBan（T5b 新原语：下一世界回合打不出道具，开窗消费、随窗自然解除）。
 * 倒霉蛋「踩陷阱走格骰 10 无事」在内核 triggerTrap 消费（表三数据位 trapWalk10Safe）。
 */
import { BOARD, type BoardCell, type Eco } from "../board";
import type { Axis } from "./roles";
import type { CheckSpec, EffectPart } from "./events";
import { DC_TIERS } from "./events";
import { back, drawItem, hp, rollMod, skip } from "./primitives";

/** 三条 T5b 新原语速写（teleport=传送回自己出生格；discard=随机弃手牌 v 张；itemBan=禁道具 v 个世界回合） */
export const teleport = (): EffectPart => ({ type: "teleport" });
export const discard = (v: number): EffectPart => ({ type: "discard", v });
export const itemBan = (v: number): EffectPart => ({ type: "itemBan", v });

export interface TrapDef {
  id: string;
  /** 格名（战报短线消费；棋盘格位渲染仍走 ⚠️ 统一画皮，不做逐格图标） */
  name: string;
  /** 一句场景文案（叙事皮：春节怪谈×庄园） */
  flavor: string;
  check: CheckSpec;
}

const check = (
  axis: Axis,
  dc: number,
  tier: CheckSpec["tier"],
  onFail: CheckSpec["onFail"],
  onCritFail: CheckSpec["onFail"],
  onPass?: CheckSpec["onPass"],
): CheckSpec => ({ axis, dc, tier, onFail, onCritFail, ...(onPass ? { onPass } : {}) });

/**
 * 14 格逐格落位（§5.4 生态配额：平 4=扣血1/滑倒回退2/罚停1/弃卡1；雪 4=滑倒回退3×2/摔伤1/削面1；
 * 戈 6=扣血2/传送回出生格2/下回合禁道具1/赌运检定1）。数组序=各生态格 id 序的配对序。
 * DC 阶梯为生态梯度定案（实现期拍板，实玩复查回表）：平 8／雪 10／戈 12——表五 DC 参考档
 * 内挂 tier 锚；DC 10 无参考档（e10 冰面滑道同例）不标 tier。
 */
export const TRAP_PLANS: Record<Eco, readonly TrapDef[]> = {
  plain: [
    {
      id: "t01",
      name: "荆棘丛",
      flavor: "一蓬带刺的荆条横在路中，叶子擦着裤腿沙沙响。",
      check: check("agile", DC_TIERS.easy, "easy", [hp(-1)], [hp(-2)]),
    },
    {
      id: "t02",
      name: "青苔石阶",
      flavor: "台阶上淌着一层薄苔，绿得发亮。",
      check: check("agile", DC_TIERS.easy, "easy", [back(2)], [back(3)]),
    },
    {
      id: "t03",
      name: "巡园捕兽夹",
      flavor: "锈齿间还留着半截木头，正等下一只脚。",
      check: check("might", DC_TIERS.easy, "easy", [skip(1)], [skip(2)]),
    },
    {
      id: "t04",
      name: "贼赃房",
      flavor: "窗缝里探出几只手，专薅过路人的袋子。",
      check: check("agile", DC_TIERS.easy, "easy", [discard(1)], [discard(2)]),
    },
  ],
  snow: [
    {
      id: "t05",
      name: "冻雨斜坡",
      flavor: "斜坡冻着一层亮壳，脚印踩上去就打圈。",
      check: check("agile", 10, undefined, [back(3)], [back(4)]),
    },
    {
      id: "t06",
      name: "冰碴滑道",
      flavor: "半条冰道沿着屋脊斜下来，底下垫着硬石阶。",
      check: check("agile", 10, undefined, [back(3)], [back(4)]),
    },
    {
      id: "t07",
      name: "危檐坠冰",
      flavor: "冰柱斜出屋檐，底下人过一步都提心吊胆。",
      check: check("agile", 10, undefined, [hp(-1)], [hp(-2)]),
    },
    {
      id: "t08",
      name: "寒风削骨",
      flavor: "风贴着山口灌下来，像一排小刀刮过指节。",
      check: check(
        "agile",
        10,
        undefined,
        [rollMod([{ mode: "cut", v: 1, src: "寒风削骨" }])],
        [rollMod([{ mode: "cut", v: 2, src: "寒风削骨" }])],
      ),
    },
  ],
  gobi: [
    {
      id: "t09",
      name: "灼热石板",
      flavor: "日头把石板晒得透烫，隔两层鞋底都钻脚。",
      check: check("agile", DC_TIERS.mid, "mid", [hp(-1)], [hp(-2)]),
    },
    {
      id: "t10",
      name: "毒蝎刺",
      flavor: "沙缝里那点银亮的东西动了动，尾针已经绷起。",
      check: check("agile", DC_TIERS.mid, "mid", [hp(-1)], [hp(-2)]),
    },
    {
      id: "t11",
      name: "流沙坑",
      flavor: "看着结实的沙面一圈圈往下晕，脚踝已经陷了半截。",
      check: check("might", DC_TIERS.mid, "mid", [teleport()], [teleport(), skip(1)]),
    },
    {
      id: "t12",
      name: "回旋沙柱",
      flavor: "一根沙柱立在巷口打转，顶天立地滴溜溜。",
      check: check("agile", DC_TIERS.mid, "mid", [teleport()], [teleport(), skip(1)]),
    },
    {
      id: "t13",
      name: "沙困行囊",
      flavor: "细沙从针脚里灌进去，行囊沉得像灌了铅。",
      check: check("agile", DC_TIERS.mid, "mid", [itemBan(1)], [itemBan(2)]),
    },
    {
      id: "t14",
      name: "赌运石",
      flavor: "顽石磨出一面平整桌面，桌心刻着一个「赌」字。",
      check: check("luck", DC_TIERS.mid, "mid", [hp(-1)], [hp(-2)], [drawItem(2)]),
    },
  ],
};

/** 全部陷阱落位对照（格 id 序↔数据序咬合的唯一真源；landOn/test/data 校验共用）：生态组序平→雪→戈、组内格 id 序 */
export const TRAP_DEFS: readonly { def: TrapDef; cellId: number; eco: Eco }[] = (() => {
  const out: { def: TrapDef; cellId: number; eco: Eco }[] = [];
  for (const eco of ["plain", "snow", "gobi"] as const) {
    const cells = BOARD.filter((c) => c.type === "T" && c.zone === eco);
    cells.forEach((c, i) => out.push({ def: TRAP_PLANS[eco][i]!, cellId: c.id, eco }));
  }
  return out;
})();

/** 格 → 陷阱数据位（landOn 消费；非陷阱格抛错——调用方先看格型） */
export const trapDefAt = (cell: BoardCell): TrapDef => {
  const hit = TRAP_DEFS.find((t) => t.cellId === cell.id);
  if (!hit) throw new Error(`格 ${cell.id} 不是陷阱格`);
  return hit.def;
};

// ---- 数据完整性校验（load 期执行；§5.4 配额守恒+逐格对上） ----
{
  const q = (z: Eco) => BOARD.filter((c) => c.type === "T" && c.zone === z).length;
  if (q("plain") !== TRAP_PLANS.plain.length) throw new Error("平原陷阱数 ≠ §5.4 配额 4");
  if (q("snow") !== TRAP_PLANS.snow.length) throw new Error("雪山陷阱数 ≠ §5.4 配额 4");
  if (q("gobi") !== TRAP_PLANS.gobi.length) throw new Error("戈壁陷阱数 ≠ §5.4 配额 6");

  // 戈壁 ？位=赌运检定（过=摸 2 张道具卡）：恰好 1 格——其失败分支也带 hp(−1)（表定案「败=扣 1 血」），
  // 从下面的普通效果分布统计里排除，只对账其余格
  const gambleCells = TRAP_PLANS.gobi.filter((d) => d.check.onPass?.some((p) => p.type === "drawItem"));
  if (gambleCells.length !== 1) throw new Error(`戈壁赌运检定格数 ${gambleCells.length} ≠ §5.4 ？位 1`);

  /** 生态内的效果分布对账：统计**失败分支**出现某类原语的格数（赌运检定格除外） */
  const count = (z: Eco, kind: string) =>
    TRAP_PLANS[z].filter((d) => !gambleCells.includes(d)).filter((d) => d.check.onFail?.some((p) => p.type === kind)).length;
  const expect: Record<Eco, Record<string, number>> = {
    plain: { hp: 1, back: 1, skip: 1, discard: 1 },
    snow: { back: 2, hp: 1, rollMod: 1 },
    gobi: { hp: 2, teleport: 2, itemBan: 1 },
  };
  for (const z of ["plain", "snow", "gobi"] as const) {
    for (const [kind, n] of Object.entries(expect[z]!)) {
      if (count(z, kind) !== n) throw new Error(`生态 ${z} 的 ${kind} 格数 ${count(z, kind)} ≠ §5.4 配额 ${n}`);
    }
  }
  for (const d of TRAP_PLANS.plain.concat(TRAP_PLANS.snow).concat(TRAP_PLANS.gobi)) {
    const { axis, dc, onFail, onCritFail } = d.check;
    if (!axis) throw new Error(`陷阱 ${d.id} 缺检定轴`);
    if (dc == null || dc < 8 || dc > 12) throw new Error(`陷阱 ${d.id} DC 超出 8..12`);
    if (d.check.tier && DC_TIERS[d.check.tier] !== dc) throw new Error(`陷阱 ${d.id} 检定档位与 DC 不一致`);
    if (!onFail?.length) throw new Error(`陷阱 ${d.id} 缺失败负面分支`);
    if (!onCritFail?.length) throw new Error(`陷阱 ${d.id} 缺大失败加重分支`);
  }
}

/**
 * 帮助速查的六块文案（M3-T3，#55 / G-03）：HUD `📖` 打开的一屏规则速查。
 *
 * 纯数据 + 零 Vue（Node 可测）；组件 `ui/HelpSheet.vue` 只负责把六块渲染进 `BaseSheet`。
 *
 * 口径：
 * - **六块**是 G-03 点名的六件事（目标 / 一回合三步 / 四类格子 / 环岛选路与来路栈退格 /
 *   最后一波 / 结算五项），比首次引导的 3 步更全——六块必须自足，不假设玩家看过引导。
 * - **一屏读完**：每块 ≤3 行、全篇 ≤480 字（390×844 首屏）；写不下就砍修饰，不砍事实。
 * - **数值与内核同一真源（尽力而为）**：称号/存活/整蛊分、进度除数、年兽血量与伤害骰、通关分位、
 *   选路超时全部从 `kernel/src` 引常量拼串——数值表改了而帮助没改，就是对玩家说谎
 *   （`help.test.ts` 会炸）。
 *   **两处例外**（内核未导出常量，本文件硬编码、`help.test.ts` 显式豁免对账）：
 *   ① 开局暗牌「抽 2 张选 1」——张数住在 `kernel/src/game.ts` 的局部 `draftPair()` 里；
 *   ② 年兽反噬「−1（猛档 −2）」——住在私有方法 `beastRoarDmg()` 里。
 *   内核若改这两处数值，必须手改这里的文案（豁免不等于免维护）。
 *   文案口径与 `game/guide.ts` 对齐（不复述规则书，只讲会踩的坑）。
 */
import {
  BEAST_BASE_HP,
  BEAST_DIE,
  BEAST_HP_PER_PLAYER,
  FINISH_SCORES,
  GAME_DEFAULTS,
  GRUDGE_SCORE,
  PROGRESS_DIVISOR,
  SURVIVE_SCORE,
  TITLE_SCORE,
} from "../../../kernel/src";

/** 六块的固定顺序（id 即锚点；顺序= G-03 的 ①~⑥） */
export type HelpBlockId = "goal" | "turn" | "cells" | "route" | "lastWave" | "settlement";

export interface HelpBlock {
  id: HelpBlockId;
  /** emoji 顶图标（不配图——G-03 明确 emoji 占位） */
  icon: string;
  /** 块标题：一句话点名主题 */
  title: string;
  /** 正文行（1–3 行，一屏内读完） */
  lines: readonly string[];
}

/** 选路超时（秒）：环岛点方向的口径与内核 `routeAskMs` 同一真源 */
const ROUTE_SECONDS = GAME_DEFAULTS.routeAskMs / 1000;

const [FIRST_FINISH, SECOND_FINISH, THIRD_FINISH] = FINISH_SCORES;

export const HELP_BLOCKS: readonly HelpBlock[] = [
  {
    id: "goal",
    icon: "🎯",
    title: "🎯 目标",
    lines: [
      `开局抽 2 张暗牌选 1，终局亮牌：达成=称号 +${TITLE_SCORE} 分（群体失败则全员作废）。`,
      "明面要拿的是——把棋子走远、踩进自己的终点支路，顺手整蛊别人也加分。",
    ],
  },
  {
    id: "turn",
    icon: "🎲",
    title: "🎲 一回合三步",
    lines: [
      "① 掷骰走格 ② 打道具卡 / 做任务 ③ 点「✔ 确认结束」进等待区。",
      "掷完不会自动确认——确认前都能继续出牌；超时系统替你掷并确认。",
    ],
  },
  {
    id: "cells",
    icon: "🗺",
    title: "🗺 四类格子",
    lines: [
      "事件（抽一张）｜道具（拿一张）｜陷阱（先检定逃生，失败吃负面）｜空格（无事）。",
      "环岛与出生格是净底，不算四类；陷阱的负面写在这一格的效果里。",
    ],
  },
  {
    id: "route",
    icon: "🧭",
    title: "🧭 环岛选路与来路栈退格",
    lines: [
      `走到环岛有多条路时你自己点方向，${ROUTE_SECONDS} 秒不选自动直行。`,
      "退格效果沿来路原路退回（净步减幅照账）；栈浅了就沿来向倒一步。",
    ],
  },
  {
    id: "lastWave",
    icon: "🐉",
    title: "🐉 最后一波",
    lines: [
      `局长打满后全员合砍年兽：血量 ${BEAST_BASE_HP} + 每玩家 ${BEAST_HP_PER_PLAYER}，人人掷 1d${BEAST_DIE} 当伤害。`,
      "年兽每波反噬全场 −1（猛档 −2）；全灭=群体失败，全员暗牌作废。",
    ],
  },
  {
    id: "settlement",
    icon: "🏁",
    title: "🏁 结算五项",
    lines: [
      `进度（净步 ÷${PROGRESS_DIVISOR}）｜通关（首通 +${FIRST_FINISH}／次通 +${SECOND_FINISH}／三通 +${THIRD_FINISH}）。`,
      `存活 +${SURVIVE_SCORE}｜称号 +${TITLE_SCORE}/条（群体失败作废）｜整蛊 +${GRUDGE_SCORE}/次。`,
      "五项相加=总分，同分顺序稳定，奖牌按名次发。",
    ],
  },
];

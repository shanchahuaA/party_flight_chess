/**
 * 常驻探针 REPL（回顾定案 C3：临时探针文件建了又删 → 固化在这里）。
 *
 * 用法：直接跑 `npm run probe`（=vitest run test/probe.debug.test.ts），改 it 各小节
 * 打印你要看的东西；全量 `npm test` 时本文件自动跳过（按 argv 是否含本文件名判定直跑）。
 * 要聚焦某节：`npx vitest run test/probe.debug.test.ts -t "名字"`。
 *
 * 规约：探针只读诊断（boot + 驱动 + console.log），不写断言不留证据——真断言请落各自 test 文件。
 */
import { describe, expect, it } from "vitest";

// kernel lib=ES2022 无 DOM——console 是 Node 运行时给的，探针专用声明（别把这段抄进内核源码）
declare const console: { log: (...a: unknown[]) => void };
declare const process: { env: Record<string, string | undefined> };
import { BEAST_DIE, GameKernel, type Fact, type PlayerDef } from "../src";
import { BOARD } from "../src/board";
import { M1_EVENT_POOL } from "../src/data/events";
import { ITEM_CARDS } from "../src/data/items";
import { boot, dieOf, me, toNextWindow, walkOut } from "./helpers";

/** 仅当经 npm run probe / dump:board 直跑时启用（全量测试=跳过，零成本零噪音）；
 *  也可显式 PROBE=1 开（非 npm 入口直调 vitest 时用） */
const direct =
  process.env.PROBE === "1" || ["probe", "dump:board"].includes(process.env.npm_lifecycle_event ?? "");
const ddescribe = direct ? describe : describe.skip;
const dit = direct ? it : it.skip;

const die = (fx: Fact[], pid = 0): number => {
  const r = fx.find((f) => f.type === "roll" && f.pid === pid);
  return r && r.type === "roll" ? r.d : -1;
};

ddescribe("探针（npm run probe 直跑才启用）", () => {
  dit("棋盘全表：格 id/类型/生态/街/坐标/邻接（找落点、查邻接用）", () => {
    const lines = BOARD.map(
      (c) =>
        `#${String(c.id).padStart(3)} type=${c.type.padEnd(4)} ${String(c.zone).padEnd(8)} ${String(c.street).padEnd(10)} (${c.col},${c.row}) links=[${c.links.join(",")}]`,
    );
    console.log(lines.join("\n"));
    expect(lines.length).toBe(BOARD.length);
  });

  dit("开局快照：默认种子一局的手牌/牌堆顶/暗牌（调卡牌类测试用）", () => {
    const k = boot();
    console.log(
      JSON.stringify(
        {
          seed: k.config.seed,
          hands: k.state.players.map((p) => p.hand),
          deckTop: k.state.deck.slice(0, 5),
          itemDeckTop: k.state.itemDeck.slice(0, 5),
          eventPool: `${k.state.deck.length}+${k.state.discard.length}=${M1_EVENT_POOL.length}`,
          itemPool: `${k.state.itemDeck.length}+${k.state.itemDiscard.length}+手牌${k.state.players.reduce((n, p) => n + p.hand.length, 0)}=${ITEM_CARDS.length}`,
          secretPicks: k.state.players.map((p) => p.secretPick),
        },
        null,
        2,
      ),
    );
    expect(k.state.phase).toBe("acting");
  });

  dit("骰面流：一枚种子的逐窗走格骰 20 面（找种子/验分布用）", () => {
    const k = boot({ seed: 7 });
    const faces: number[] = [];
    for (let i = 0; i < 20; i++) {
      const fx = k.apply({ type: "roll", pid: 0 }, k.state.windowDeadline - 1);
      faces.push(die(fx));
      toNextWindow(k, k.state.windowDeadline - 1, k.config.windowMs, k.config.restMs);
    }
    console.log(`seed=${k.config.seed} 走格骰流:`, faces.join(","));
    expect(faces.length).toBe(20);
  });

  dit("走格回放：pid0 逐步落点与来路栈（验 trail/支路用）", () => {
    const k = boot({ seed: 42 });
    const fx = k.apply({ type: "roll", pid: 0 }, 0);
    console.log("首掷 =", dieOf(fx));
    const steps = walkOut(k, 0).filter((f) => f.type === "step" && f.pid === 0);
    console.log(
      "steps:",
      steps.map((f) => (f.type === "step" ? `${f.from}->${f.to}` : "")).join(" "),
      "| 终点格:",
      me(k).pos,
      "净步:",
      me(k).net,
      "trail:",
      me(k).trail.join(","),
    );
    expect(steps.length).toBeGreaterThan(0);
  });

  dit("年兽战速查：BEAST_DIE 与血条公式（调终局测试用）", () => {
    console.log("BEAST_DIE =", BEAST_DIE);
    expect(BEAST_DIE).toBe(12);
  });

  dit("年兽波拍诊断：两波砍击的完整事实/血量轨迹（查反噬账用）", () => {
    const CREW: PlayerDef[] = [
      { name: "你", isBot: false, roleId: "light" },
      { name: "阿二", isBot: true, roleId: "light" },
      { name: "阿三", isBot: true, roleId: "light" },
      { name: "阿四", isBot: true, roleId: "light" },
    ];
    const { kernel: k } = GameKernel.create({ allowDev: true, seed: 7, maliceLevel: "off", windowMs: 5, restMs: 0 }, 0, CREW);
    k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
    for (let i = 0; i < 15; i++) k.tick(Math.max(k.state.windowDeadline, k.state.restUntil) + 1);
    const now = Math.max(k.state.windowDeadline, k.state.restUntil);
    console.log("== 开战:", JSON.stringify(k.state.endgame?.beast), "hp:", k.state.players.map((p) => p.hp));
    const wave = (t: number) => {
      const fx1 = k.apply({ type: "strike", pid: 0 }, t);
      const fx2 = k.tick(t + 6);
      console.log("-- 波事实:", JSON.stringify([...fx1, ...fx2].filter((f) => f.type === "beastHit" || f.type === "beastRoar" || f.type === "beastWave" || f.type === "eliminated")));
      console.log("   血量:", k.state.players.map((p) => p.hp), "| 战报尾:", k.state.messages.slice(-4).map((m) => m.text).join(" / "));
    };
    wave(now);
    wave(now + 6);
    expect(k.state.endgame?.beast?.wave).toBe(3);
  });

  dit("反噬测试原样复刻：setHp+setBeast999 后的逐拍血量（查 [6,8,8,8] 来源）", () => {
    const CREW: PlayerDef[] = [
      { name: "你", isBot: false, roleId: "light" },
      { name: "阿二", isBot: true, roleId: "light" },
      { name: "阿三", isBot: true, roleId: "light" },
      { name: "阿四", isBot: true, roleId: "light" },
    ];
    const mk = (over: Record<string, unknown>) => {
      const { kernel: k } = GameKernel.create({ allowDev: true, seed: 7, maliceLevel: "off", windowMs: 5, restMs: 0, ...over }, 0, CREW);
      k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
      for (let i = 0; i < 15; i++) k.tick(Math.max(k.state.windowDeadline, k.state.restUntil) + 1);
      return k;
    };
    // 温和：两波
    const k = mk({});
    const now = Math.max(k.state.windowDeadline, k.state.restUntil);
    for (const p of k.state.players) k.apply({ type: "dev.setHp", pid: p.id, hp: 10 }, now);
    k.apply({ type: "dev.setBeast", hp: 999 }, now);
    const wave = (t: number, tag: string) => {
      const fx = [...k.apply({ type: "strike", pid: 0 }, t), ...k.tick(t + 6)];
      console.log(`${tag}:`, JSON.stringify(fx.filter((f) => f.type === "beastHit" || f.type === "beastRoar" || f.type === "eliminated")));
      console.log("  血量:", k.state.players.map((p) => p.hp));
    };
    wave(now, "温和波1");
    wave(now + 6, "温和波2");
    // 猛档：一波
    const kf = mk({ maliceLevel: "fierce" });
    const nf = Math.max(kf.state.windowDeadline, kf.state.restUntil);
    for (const p of kf.state.players) kf.apply({ type: "dev.setHp", pid: p.id, hp: 10 }, nf);
    kf.apply({ type: "dev.setBeast", hp: 999 }, nf);
    const fxf = [...kf.apply({ type: "strike", pid: 0 }, nf), ...kf.tick(nf + 6)];
    console.log("猛档波1:", JSON.stringify(fxf.filter((f) => f.type === "beastHit" || f.type === "beastRoar" || f.type === "eliminated")));
    console.log("  血量:", kf.state.players.map((p) => p.hp));
    expect(true).toBe(true);
  });

  dit("搜种子：开局手牌含指定卡（重钉「手牌含 i14」类钉账用——改 seed 后把结果填回测试）", () => {
    const CREW: PlayerDef[] = [
      { name: "你", isBot: false, roleId: "light" },
      { name: "阿二", isBot: true, roleId: "light" },
      { name: "阿三", isBot: true, roleId: "light" },
      { name: "阿四", isBot: true, roleId: "light" },
    ];
    const want = process.env.PROBE_CARD ?? "i14";
    const hits: number[] = [];
    for (let seed = 1; seed < 2000 && hits.length < 5; seed++) {
      const { kernel: k } = GameKernel.create({ allowDev: true, seed, maliceLevel: "off", windowMs: 5, restMs: 0 }, 0, CREW);
      k.apply({ type: "chooseSecret", pid: 0, pick: 0 }, 0);
      if (k.state.players[0]!.hand.includes(want)) hits.push(seed);
    }
    console.log(`开局手牌含 ${want} 的种子（前 5 个）:`, hits.join(", "));
    expect(hits.length).toBeGreaterThan(0);
  });

  dit("环境账诊断：雷暴打出后的逐窗 tickAmbient/劈人账（T8b1 环境双账测试配准用）", () => {
    const k = boot({ seed: 1, maliceLevel: "off" });
    const tryGive = (cardId: string) => {
      try {
        k.apply({ type: "dev.giveItem", pid: 0, cardId }, 0);
        return true;
      } catch {
        return false;
      }
    };
    tryGive("i13");
    k.apply({ type: "playItem", pid: 0, cardId: "i13" }, 0);
    console.log("== 雷暴打出:", JSON.stringify(k.state.ambient));
    let t = toNextWindow(k, 0, 30_000, 0);
    console.log("after toNextWindow#1 (t=" + t + "):", JSON.stringify(k.state.ambient));
    t = toNextWindow(k, t, 30_000, 0);
    console.log("after toNextWindow#2 (t=" + t + "):", JSON.stringify(k.state.ambient));
    console.log("劈人条目:", k.state.messages.filter((m) => m.tags?.includes("ambientDown")).map((m) => `${m.who}:${m.text}`).join(" / "));
    expect(true).toBe(true);
  });
});

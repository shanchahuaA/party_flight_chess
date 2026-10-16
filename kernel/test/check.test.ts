/** 检定框架（表五 §5.2）：1d20 高掷优四档、极值取原始面、修正先互抵、轴加值/保底面宽 */
import { describe, expect, it } from "vitest";
import { netMods, resolveCheck, rollD20 } from "../src";
import { rngFrom } from "../src";

describe("互抵 netMods", () => {
  it("adv 正负互抵成套（D&D 语义：合计后再定掷法）面宽直接加总", () => {
    expect(netMods([{ adv: 2 }, { adv: -1 }, { bonus: -3 }, { bonus: 1 }])).toMatchObject({
      adv: 1,
      advCount: 1,
      bonus: -2,
    });
    expect(netMods([{ adv: 1 }, { adv: -3 }])).toMatchObject({ adv: -1, advCount: 2 });
    expect(netMods([])).toMatchObject({ adv: 0, advCount: 0, bonus: 0, floor: null });
  });

  it("多张保底互扰取最宽松", () => {
    expect(netMods([{ floor: 6 }, { floor: 10 }, { floor: 8 }]).floor).toBe(10);
  });
});

describe("四档判读 resolveCheck", () => {
  it("通过线：1d20+轴 ≥ DC（边界恰好等于 DC=过）", () => {
    expect(resolveCheck({ raw: 15, axisBonus: 3, dc: 12 }).grade).toBe("pass");
    expect(resolveCheck({ raw: 10, axisBonus: 3, dc: 12 }).grade).toBe("pass"); // used=13
    expect(resolveCheck({ raw: 9, axisBonus: 3, dc: 12 }).grade).toBe("pass"); // used=12 边界=过
    expect(resolveCheck({ raw: 5, axisBonus: 3, dc: 12 }).grade).toBe("fail"); // used=8 <12
  });

  it("极值档：20 大成功／1 大失败，不看修正（极值挂检定骰本身）", () => {
    expect(resolveCheck({ raw: 20, axisBonus: 0, dc: 17 }).grade).toBe("crit");
    expect(resolveCheck({ raw: 20, axisBonus: 0, dc: 17, mods: [{ bonus: -25 }] }).grade).toBe("crit");
    expect(resolveCheck({ raw: 1, axisBonus: 4, dc: 5 }).grade).toBe("critfail");
    expect(resolveCheck({ raw: 1, axisBonus: 4, dc: 5, mods: [{ floor: 10 }] }).grade).toBe("critfail"); // 保底不救大失败
  });

  it("菜狗翻身：原始 1 改判大成功（倒霉蛋特长数据位）", () => {
    expect(resolveCheck({ raw: 1, axisBonus: 0, dc: 16, oneToCrit: true }).grade).toBe("crit");
    expect(resolveCheck({ raw: 1, axisBonus: 0, dc: 16, oneToCrit: true, mods: [{ floor: 10 }] }).grade).toBe("crit");
  });

  it("保底与面宽：互抵后 used 判 pass/fail", () => {
    expect(resolveCheck({ raw: 5, axisBonus: 0, dc: 8, mods: [{ floor: 10 }] }).used).toBe(10);
    expect(resolveCheck({ raw: 5, axisBonus: 0, dc: 8, mods: [{ floor: 10 }] }).grade).toBe("pass");
    expect(resolveCheck({ raw: 10, axisBonus: 0, dc: 8, mods: [{ bonus: -4 }] }).grade).toBe("fail");
    expect(resolveCheck({ raw: 7, axisBonus: 2, dc: 8, mods: [{ bonus: -1 }] }).used).toBe(8);
    expect(resolveCheck({ raw: 7, axisBonus: 2, dc: 8, mods: [{ bonus: -1 }] }).grade).toBe("pass");
    expect(resolveCheck({ raw: 3, axisBonus: 0, dc: 12 }).grade).toBe("fail"); // 越面输入（1..20 之外的防御态）走判读线
  });
});

describe("掷骰通道 rollD20", () => {
  it("同种子确定性；净值优势取最高＝独立重放序列的 max", () => {
    const seed = 7;
    const r1 = rngFrom(seed);
    const a = rollD20(r1, { adv: 1, advCount: 2 }); // 掷 3 颗取最高
    const r2 = rngFrom(seed);
    const faces = [0, 0, 0].map(() => Math.floor(r2.next() * 20) + 1);
    expect(a).toBe(Math.max(...faces));
  });

  it("劣势取最低；无修正单掷", () => {
    const seed = 11;
    const r1 = rngFrom(seed);
    const a = rollD20(r1, { adv: -1, advCount: 2 });
    const r2 = rngFrom(seed);
    const faces = [0, 0, 0].map(() => Math.floor(r2.next() * 20) + 1);
    expect(a).toBe(Math.min(...faces));
    const r3 = rngFrom(seed);
    const single = rollD20(r3, { adv: 0, advCount: 0 });
    const r4 = rngFrom(seed);
    expect(single).toBe(Math.floor(r4.next() * 20) + 1);
  });

  it("骰面 1..20", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const d = rollD20(rngFrom(seed), { adv: 0, advCount: 0 });
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(20);
    }
  });
});

describe("骰面修正四原语（#19 T3a：削面/升面/保底/加值）", () => {
  it("面宽互抵：削面/升面先互相抵消再结算（同一次检定全量合账）", () => {
    expect(netMods([{ face: -2 }]).face).toBe(-2); // 削面 2 → 1d18
    expect(netMods([{ face: 1 }]).face).toBe(1); // 升面 1 → 1d21
    expect(netMods([{ face: -2 }, { face: 1 }]).face).toBe(-1); // 升面抵削面
    expect(netMods([{ face: -2 }, { face: 2 }]).face).toBe(0); // 恰好抵消
    expect(netMods([{ face: -1 }, { face: 1 }, { bonus: 3 }, { floor: 10 }])).toMatchObject({
      face: 0,
      bonus: 3,
      floor: 10,
    });
  });

  it("升/削面改骰面数：1d19 上限 19（大成功自然不可达）；1d22 出 21/22 是大数不是极值", () => {
    for (let seed = 1; seed <= 200; seed++) {
      expect(rollD20(rngFrom(seed), { adv: 0, advCount: 0 }, 19)).toBeLessThanOrEqual(19);
      expect(rollD20(rngFrom(seed, { s: seed + 300000 }), { adv: 0, advCount: 0 }, 22)).toBeLessThanOrEqual(22);
    }
    // 多颗（优势）同样尊重面数
    const r1 = rngFrom(9);
    const a = rollD20(r1, { adv: 1, advCount: 2 }, 19); // 掷 3 颗取最高
    const r2 = rngFrom(9);
    const faces = [0, 0, 0].map(() => Math.floor(r2.next() * 19) + 1);
    expect(a).toBe(Math.max(...faces));
  });

  it("极值不随面宽翻动：极值只判原始面 20/1（resolveCheck 收口；升面骰出的 21+ 判过不算大成功）", () => {
    expect(resolveCheck({ raw: 21, axisBonus: 0, dc: 18 }).grade).toBe("pass");
    expect(resolveCheck({ raw: 20, axisBonus: 0, dc: 18 }).grade).toBe("crit");
    expect(resolveCheck({ raw: 1, axisBonus: 0, dc: 18 }).grade).toBe("critfail");
  });
});

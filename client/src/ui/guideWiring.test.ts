import { describe, expect, it } from "vitest";

/**
 * 引导让位接线的回归钉（视觉拍板 B：玩家主动点开的浮层优先）。
 *
 * 逻辑层已由 `game/guide.test.ts`（状态机：让位不写 seen、本局不再自动弹、换局闸重置）与
 * `game/useGuide.test.ts`（薄适配：不落 localStorage）钉死。但组件模板可以完全不发这个信号——
 * 那时浮层逻辑全部正确、玩家看到的却是「点 📖 弹出引导压住帮助」的原缺陷。Node 环境不挂 DOM，
 * 源码级断言是唯一能抓到「接线漏了」的位置（先例：`confirmWiring.test.ts`、`settingsPanel.test.ts`）。
 *
 * 只断「两个入口都发了让位信号 + 浮层侧消费了同一信号」，不断函数名之外的结构。
 */

const RAW = import.meta.glob(["./HudBar.vue", "./GuideSheet.vue"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function src(rel: string): string {
  const v = RAW["./" + rel];
  if (v == null) throw new Error(`找不到 ${rel}（路径拼写？）`);
  return v;
}

describe("引导让位接线：📖 / ⚙ 两个入口都先发让位信号", () => {
  it("HudBar 的 openHelp 与 openSettings 都调 dismissGuide", () => {
    const s = src("HudBar.vue");
    for (const fn of ["openHelp", "openSettings"]) {
      const i = s.indexOf(`function ${fn}()`);
      expect(i, `HudBar 应有 ${fn}`).toBeGreaterThan(-1);
      const body = s.slice(i, s.indexOf("}", i));
      expect(body, `${fn} 应先发让位信号`).toContain("dismissGuide()");
    }
  });

  it("GuideSheet 消费同一个让位信号（watch guideDismiss → close）", () => {
    const s = src("GuideSheet.vue");
    expect(s).toContain("guideDismiss");
    expect(s).toContain("guide.close()");
  });

  it("让位不写 seen（GuideSheet 源码里 markGuideSeen 只能经 useGuide 的 skip/next 路径）", () => {
    // 组件层不许自己碰 seen：全部经 useGuide（writeSeen 只由状态机的 skip/末步 next 给出）
    expect(src("GuideSheet.vue")).not.toContain("markGuideSeen");
  });

  it("让位的两个入口不误发重看信号（收起 ≠ reopen）", () => {
    const s = src("HudBar.vue");
    for (const fn of ["openHelp", "openSettings"]) {
      const i = s.indexOf(`function ${fn}()`);
      const body = s.slice(i, s.indexOf("}", i));
      expect(body, `${fn} 不该发重看信号`).not.toContain("openGuide()");
    }
  });
});

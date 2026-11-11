import { describe, expect, it } from "vitest";

/**
 * 二次确认接线的**回归钉**（#58 / G-07 + L-05）。
 *
 * 为什么这一层值得钉：票面的核心不是「有没有一个浮层」，而是**「点一下就把人踢出去 / 把房间解散」
 * 这条错路径不能回来**。逻辑层已由 `game/confirm.test.ts` 与 `game/useConfirm.test.ts` 钉死
 * （ask 不执行、cancel 不执行、confirm 执行一次），但组件模板可以绕过状态机直调
 * `roomStore.kick()` / `roomStore.dissolve()`——源码级断言是唯一能在 Node 环境抓到它的位置。
 * 先例：`settingsPanel.test.ts` 断言 SettingsSheet 不内嵌配置控件、`motionRedline` 读 SFC 源码。
 *
 * 只断「模板里不许有无确认直调 + 破坏性入口必须挂同一个确认浮层」，不断函数名、不断实现结构。
 */

/** 键相对本测试文件（src/ui/）：ui 内文件用裸名、App.vue 用 ../App.vue */
const RAW = import.meta.glob(["./*.vue", "../App.vue"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function src(rel: string): string {
  const v = RAW[rel.startsWith("../") ? rel : "./" + rel];
  if (v == null) throw new Error(`找不到 ${rel}（路径拼写？）`);
  return v;
}

/** 取 SFC 的 <template> 段（只断模板接线；script 里的执行回调出 kick 是正常的） */
function templateOf(rel: string): string {
  const s = src(rel);
  const start = s.indexOf("<template>");
  const end = s.lastIndexOf("</template>");
  expect(start, `${rel} 应有 template 块`).toBeGreaterThan(-1);
  return s.slice(start, end);
}

describe("请出 / 解散：模板里不许出现无二次确认的直调", () => {
  it("大厅与 ⚙ 的请出钮都不直调 roomStore.kick（点一下就踢=错路径）", () => {
    for (const rel of ["RoomLobby.vue", "SettingsSheet.vue"]) {
      expect(templateOf(rel), `${rel} 模板不许直调 kick`).not.toContain("roomStore.kick(");
    }
  });

  it("请出钮的可见性由 canKick 判据给（假人/自己/非房主无钮），组件不另写一份 bot/自己条件", () => {
    // 判据本体在 game/members（纯函数，有测试）——两处模板都只照 canKick 渲染
    expect(templateOf("RoomLobby.vue")).toContain("canKick(s.seat)");
    expect(templateOf("SettingsSheet.vue")).toContain("m.canKick");
    expect(src("SettingsSheet.vue")).toContain("memberRows");
    expect(src("RoomLobby.vue")).toContain("memberRows");
  });

  it("三处解散入口（App 角落 / 大厅页脚 / ⚙ 面板）都不直调 roomStore.dissolve", () => {
    for (const rel of ["../App.vue", "RoomLobby.vue", "SettingsSheet.vue"]) {
      expect(templateOf(rel), `${rel} 模板不许直调解散`).not.toContain("roomStore.dissolve()");
    }
  });

  it("四处破坏性入口都挂 ConfirmSheet，且两个钮都接了处理（不会点取消也执行）", () => {
    for (const rel of ["../App.vue", "RoomLobby.vue", "SettingsSheet.vue"]) {
      const tmpl = templateOf(rel);
      expect(tmpl, `${rel} 应复用 ConfirmSheet`).toContain("<ConfirmSheet");
      expect(tmpl, `${rel} 确认钮应接 @confirm`).toContain("@confirm=");
      expect(tmpl, `${rel} 取消钮应接 @cancel`).toContain("@cancel=");
    }
  });

  it("ConfirmSheet 只有「确认 / 取消」两钮，且自身不执行任何动作（只抛事件）", () => {
    const s = src("ConfirmSheet.vue");
    expect(s).toContain('data-confirm="ok"');
    expect(s).toContain('data-confirm="cancel"');
    expect(s).not.toContain("roomStore");
    expect(s).not.toContain("fetch(");
  });
});

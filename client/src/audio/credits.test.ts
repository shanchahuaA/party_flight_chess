import { describe, expect, it } from "vitest";
import LICENSES from "../../public/audio/LICENSES.md?raw";
import { SFX_CREDITS } from "./credits";
import { SFX_NAMES } from "./sfx";

/**
 * 素材清单（`client/public/audio/*.mp3`）：只用 glob 的**键**（不读内容、不把二进制拉进测试包），
 * 用来钉「12 格每格都有文件、目录里没有孤儿 mp3」。
 */
const ASSET_FILES = Object.keys(
  import.meta.glob("../../public/audio/*.mp3") as Record<string, unknown>,
).map((p) => p.replace(/^.*\//, ""));

/**
 * 署名对账（A-06）：产品可见处的两条 CC-BY 文案必须与 `public/audio/LICENSES.md` **一字不差**，
 * 且只署这两条（其余 10 条 CC0 不强制——多署不算错，但会误导为「全部都要署名」，
 * 所以这里也钉住「恰两条」）。
 */
describe("音效署名（A-06：win.mp3 / step.mp3 两条 CC-BY）", () => {
  it("恰两条，分别是 win.mp3 与 step.mp3", () => {
    expect(SFX_CREDITS.map((c) => c.file)).toEqual(["win.mp3", "step.mp3"]);
  });

  it("文案逐字出现在 LICENSES.md 顶部（防两处走样）", () => {
    for (const c of SFX_CREDITS) {
      expect(LICENSES, c.file).toContain(c.text);
    }
  });

  it("两条素材都在 12 格音效表里（文件名即时机 id）", () => {
    for (const c of SFX_CREDITS) {
      const name = c.file.replace(/\.mp3$/, "");
      expect(SFX_NAMES as readonly string[]).toContain(name);
    }
  });

  it("LICENSES.md 里 ⚑ 标记的行恰好是这两条（授权清单没换过素材）", () => {
    const flagged = [...LICENSES.matchAll(/\|\s*⚑\s*`([^`]+)`/g)].map((m) => m[1]!);
    expect(flagged).toEqual(["win.mp3", "step.mp3"]);
  });

  it("授权清单逐条表列出的 12 个文件名与 SFX_NAMES 一一对应（素材齐、无孤儿）", () => {
    // 逐条对照表：`| \`roll.mp3\` | ...`（⚑ 行多一个标记）
    const files = [...LICENSES.matchAll(/\|\s*(?:⚑\s*)?`([a-z]+\.mp3)`\s*\|/g)].map((m) => m[1]!);
    expect(files).toHaveLength(12);
    expect(new Set(files).size).toBe(12);
    expect(files.map((f) => f.replace(/\.mp3$/, "")).sort()).toEqual([...SFX_NAMES].sort());
  });

  it("public/audio 目录里恰有这 12 个 mp3：每格都有文件，没有孤儿素材", () => {
    expect(ASSET_FILES).toHaveLength(12);
    expect([...ASSET_FILES].sort()).toEqual(SFX_NAMES.map((n) => `${n}.mp3`).sort());
  });
});

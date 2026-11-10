import { describe, expect, it } from "vitest";

/**
 * SFC 模板注释卫生（#59 踩坑回归）：HTML 注释里出现 `--` 或 `*\/` 会让 Vue 编译器把注释撑到
 * 下一个注释起点，**静默吞掉中间的模板节点**（组件不渲染、build 不报错）。
 * 实测案例：App.vue 注释里误带 jsdoc 结尾，把 `<WorldMessage/>`/`<BoardSvg/>`/`<RouteBar/>`
 * 三个节点整段吞成注释——页面看着能跑、棋盘全没了。
 *
 * 用 Vite 的 import.meta.glob 取文件（本来就带 `?raw` 能力，不起 node: 类型依赖）。
 */
const RAW = import.meta.glob(["./**/*.vue"], { eager: true, query: "?raw", import: "default" }) as Record<
  string,
  string
>;

describe("SFC 卫生：模板注释不许含 -- 或 */", () => {
  it("client/src 下所有 .vue 的 template 块注释都干净", () => {
    const files = Object.keys(RAW);
    expect(files.length).toBeGreaterThan(10);
    const bad: string[] = [];
    for (const f of files) {
      const src = RAW[f]!;
      const start = src.indexOf("<template>");
      const end = src.lastIndexOf("</template>");
      if (start < 0 || end < 0) continue;
      const tmpl = src.slice(start, end);
      for (const m of tmpl.matchAll(/<!--([\s\S]*?)-->/g)) {
        if (m[1]!.includes("--") || m[1]!.includes("*/")) {
          bad.push(`${f}: ${JSON.stringify(m[1]!.slice(0, 60))}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});


import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// 缝 2（M2 唯一新增自动化缝，Spec #37 Testing Decisions）：Room DO 的 WS 协议边界——
// 真 workerd 运行时（@cloudflare/vitest-plugin，vitest-pool-workers 的继任包），走 Worker
// 入口（SELF）打全生命周期主链。wrangler.jsonc 提供 DO 绑定与 SQLite 迁移；main 让 SELF 可用。
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      main: "./src/index.ts",
    }),
  ],
  test: {
    testTimeout: 15_000,
  },
});

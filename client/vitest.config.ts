import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 只测客户端纯逻辑（Node 环境）：不挂载 Vue 组件、不需要 DOM——
    // 判定模块与状态机模块一律无 Vue/无 DOM 依赖（Spec #52 Testing Decisions 缝 3）。
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});

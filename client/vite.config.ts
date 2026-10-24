import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages 项目页：相对路径资源，从子路径打开也不会白掉
  base: "./",
  plugins: [vue()],
  server: {
    port: 5173,
    // M2-T3（#40）本地联调：HTTP 面与 WS 升级都代理到 wrangler dev（8787）——
    // 前端代码只写相对路径/同 host WS，感知不到双进程（docs/脚手架约定.md 端口一节）
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});

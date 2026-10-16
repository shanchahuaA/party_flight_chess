import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages 项目页：相对路径资源，从子路径打开也不会白掉
  base: "./",
  plugins: [vue()],
  server: {
    port: 5173,
  },
});

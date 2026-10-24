// 测试环境的绑定类型：新插件走全局 Cloudflare.Env（wrangler types 生成的合并点），
// 这里手工声明 ROOM 绑定；env 从 cloudflare:workers 导入（cloudflare:test 的 env 已弃用）。
declare namespace Cloudflare {
  interface Env {
    ROOM: DurableObjectNamespace;
  }
}

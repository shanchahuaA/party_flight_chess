## Language

Always reply in Chinese (中文).

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical labels, used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Commands, RNG/test conventions, dev channels

Command table (kernel/client)、TS lib 下限、RNG 分流与种子搜索纪律、状态机票自检三问：`docs/脚手架约定.md`。调试通道与浏览器冒烟：`docs/agents/dev-channels.md`、`docs/agents/iab-smoke.md`。开工先读，别现场猜命令。

提交前跑一次 `npm run verify`（根目录，三包 typecheck+test 一条命令）。

### 关于子代理

子代理不仅是为了并行工作提升效率，还可以保证上下文干净。

本项目的实现者类型是 **`impl-flash-max`**（`.zcode/agents/impl-flash-max.md`，dsv4.1-flash @ max）。
`/implement-spec` 的每票实现、以及评审后的修复，都用它派发——它带着票级纪律（先读票与契约、
用 `tdd` 技能、内核零改动红线、动效红线、收尾三步入账），`general-purpose` 不带这些。
只读探索可用 `Explore` / `local-explorer`，联网查资料用 `websearch`。

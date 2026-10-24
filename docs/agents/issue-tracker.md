# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <file>`. 多行或含反引号/中文的 body 一律先落盘文件再 `--body-file`——内联 `--body` 会触发 bash 解析错误（EOF/heredoc 都不保险，与「commit message 走 python 落盘 + `-F`」同一条纪律）。
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body-file <file>`（body 落盘纪律同上）
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Closing an implemented ticket: the account comment

Closing an implemented ticket = **one comment (the account) + close + frontier sweep** — all three, every time. The account comment records what the implementation settled; it is the reviewable trail. Structure:

```markdown
## 收账

<一段：做了什么、怎么验收的（测试数/typecheck/冒烟路径）>

## 实现期定案

- **[需你表态]** <偏离票面/票面没写的决定，一句话+理由>（拿不准就标这条，别攒）
- **[无需动作（默认追认）]** <纯执行口径，不反对即视为追认>
```

Rules:

- Every decision made during implementation that the ticket text didn't pin down gets a line under 实现期定案, tagged either **需你表态** (deviates from the ticket, or genuinely needs the user's call) or **无需动作（默认追认）** (execution detail; silence = accepted). The user has twice asked "what am I supposed to do with these?" — the tags are the answer.
- After closing, sweep the frontier (below) so newly unblocked dependents get `ready-for-agent`.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## Ticket blocking and the frontier (spec tickets)

Issues have no "parked/unstarted" state: a ticket stays **open** until its work is accepted — close at acceptance, never to park gated work. Blocking lives in GitHub **native issue dependencies** (same mechanics as the wayfinding section below), mirrored by a `Blocked by` section in the body that `/to-tickets` writes.

- **Gating = native dependency edges, not issue state.** Per-ticket gate: `gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by` (>0 = open blockers remain). Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` (db id = `gh api repos/<owner>/<repo>/issues/<n> --jq .id`).
- **`ready-for-agent` = unblocked.** Gated tickets carry no label. A ticket already being worked may keep the label until close; the claim signal is the assignee — always filter it out when grabbing. Frontier query:
  ```bash
  gh issue list --state open --label ready-for-agent --json number,title,assignees \
    --jq '.[] | select(.assignees | length == 0) | "\(.number)\t\(.title)"'
  ```
- **After closing a ticket, sweep the frontier**: its open dependents are `GET /issues/<n>/dependencies/blocking`; re-apply `ready-for-agent` to each whose own blockers are now all closed:
  ```bash
  for ch in $(gh api repos/<owner>/<repo>/issues/<n>/dependencies/blocking --jq '.[].number'); do
    [ "$(gh api repos/<owner>/<repo>/issues/$ch/dependencies/blocked_by --jq '[.[] | select(.state != "closed")] | length')" = "0" ] \
      && gh issue edit $ch --add-label "ready-for-agent"
  done
  ```
- **Publishing via `/to-tickets`**: wire the dependency edges at create time; only unblocked tickets get `ready-for-agent`, the rest publish unlabeled.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

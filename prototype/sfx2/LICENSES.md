# `prototype/sfx2/` 第二轮候选音效授权清单

第二轮试听台（`prototype/m3-sfx-audition2-stub.html`）的候选素材，**仅覆盖 7–12 号时机**。
转码口径同一轮：64 kbps 单声道 mp3（44.1 kHz），峰值归一约 −1.5 dBFS，不足 0.22 s 补静音到 0.22 s。
★ 标记的条目是**变调版**（`asetrate` 改音高 + `aresample` 回标准采样率），并非新素材。

## 授权总览

| 来源包 | 授权 | 是否要署名 |
| --- | --- | --- |
| Kenney Casino / Interface Sounds / Music Jingles | **CC0** | 不要（官方原文「all game assets on the asset pages are public domain licensed (CC0)」，<https://kenney.nl/support>） |
| OpenGameArt RPG Sound Pack（artisticdude） | **CC0** | 不要 |
| OpenGameArt「Footsteps on different surfaces」（congusbongus） | **混合**：`gravel`、`bones` 是 CC0；`tile`、`wood`、`boots`、`grass`、`metal`、`water`、`dog`、`mech` 是 **CC-BY 3.0** | **要**（见下） |

> ⚠️ 授权差异是本轮新增的风险点：`s10-step-*` 里除 `gravel` 外全部来自 CC-BY 3.0 素材。
> 若最终选用 tile/wood/boots 任一条，**必须**在 `client/public/audio/LICENSES.md` 写上署名。

## CC-BY 3.0 署名要求（若选中 tile / wood / boots）

Footsteps on different surfaces by congusbongus，<https://opengameart.org/content/footsteps-on-different-surfaces>，CC-BY 3.0。
包内附带的原始出处：
- `tile/`、`boots/`：Derived from `footstep-concrete.wav` by **swuing**，<https://freesound.org/people/swuing/sounds/38873/>
- `tile/` 另含 `Squeaky footstep.wav` by **ceberation**，<https://freesound.org/people/ceberation/sounds/235524/>
- `wood/`：Derived from `footstep-wood.wav` by **swuing**，<https://freesound.org/people/swuing/sounds/38876/>

## 逐条对照

### 7 失败 sting
| 输出 | 源 | 授权 |
| --- | --- | --- |
| `s07-fail-steel14.mp3` | Kenney Music Jingles `jingles_STEEL14` | CC0 |
| `s07-fail-steel01.mp3` | Kenney Music Jingles `jingles_STEEL01` | CC0 |
| `s07-fail-pizza07.mp3` | Kenney Music Jingles `jingles_PIZZA07` | CC0 |
| `s07-fail-pizza01.mp3` | Kenney Music Jingles `jingles_PIZZA01` | CC0 |
| `s07-fail-sax07.mp3` | Kenney Music Jingles `jingles_SAX07` | CC0 |
| `s07-fail-giant2.mp3` | RPG Sound Pack `NPC/giant/giant2.wav` | CC0 |
| `s07-fail-shade11.mp3` | RPG Sound Pack `NPC/shade/shade11.wav` | CC0 |
| `s07-fail-sax03-down.mp3` | Kenney `jingles_SAX03` **降 3 半音** | CC0 |

### 8 胜利 sting
| 输出 | 源 | 授权 |
| --- | --- | --- |
| `s08-win-steel15.mp3` | `jingles_STEEL15` | CC0 |
| `s08-win-hit11.mp3` | `jingles_HIT11` | CC0 |
| `s08-win-pizza02.mp3` | `jingles_PIZZA02` | CC0 |
| `s08-win-steel10.mp3` | `jingles_STEEL10` | CC0 |
| `s08-win-nes05.mp3` | `jingles_NES05` | CC0 |
| `s08-win-sax12.mp3` | `jingles_SAX12` | CC0 |
| `s08-win-sax15.mp3` | `jingles_SAX15` | CC0 |
| `s08-win-steel02-up.mp3` | `jingles_STEEL02` **升 2 半音** | CC0 |

### 9 UI 轻点
全部 Kenney Interface Sounds（CC0）：`click_002` / `toggle_002` / `toggle_004` / `tick_004` / `select_005` / `drop_004`；
`s09-metal-small2.mp3` 来自 RPG Sound Pack `inventory/metal-small2.wav`（CC0）。

### 10 走格脚步
| 输出 | 源 | 授权 |
| --- | --- | --- |
| `s10-step-tile-0/3/6.mp3` | Footsteps `tile/0,3,6` | **CC-BY 3.0** |
| `s10-step-wood-0/4.mp3` | Footsteps `wood/0,4` | **CC-BY 3.0** |
| `s10-step-gravel-2/5.mp3` | Footsteps `gravel/2,5` | CC0 |
| `s10-step-boots-1.mp3` | Footsteps `boots/1` | **CC-BY 3.0** |

### 11 轮到自己
`s11-turn-confirm1/2/4`、`bong`、`pluck2`、`select4`、`maximize4` 来自 Kenney Interface Sounds（CC0）；
`s11-turn-interface5.mp3` 来自 RPG Sound Pack `interface/interface5.wav`（CC0）。

### 12 观战 / 出局
`s12-out-shade13/9/14` 来自 RPG `NPC/shade/`（CC0）；
`s12-out-giant2.mp3` 来自 RPG `NPC/giant/giant2.wav`（CC0）；
`s12-out-error3` / `s12-out-close2` 来自 Kenney Interface Sounds（CC0）；
`s12-out-metal1.mp3` 来自 RPG `inventory/metal-small1.wav`（CC0）；
`s12-out-door-down.mp3` 来自 RPG `world/door.wav` **降 4 半音**（CC0）。

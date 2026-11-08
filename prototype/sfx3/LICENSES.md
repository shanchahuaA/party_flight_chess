# `prototype/sfx3/` 第三轮候选音效授权清单

第三轮试听台（`prototype/m3-sfx-audition3-stub.html`）的候选，专攻两件事：「哇！」童真惊叹、失败 sting 重挑。
转码口径：64 kbps 单声道 mp3（44.1 kHz），峰值归一约 −1.5 dBFS。

## ⚠️ 授权风险提示

本轮**大部分素材是 CC-BY**，与第一轮的纯 CC0 不同。若最终选用，**必须**在
`client/public/audio/LICENSES.md` 里照下面的署名要求写清楚。

| 来源 | 授权 | 署名要求 |
| --- | --- | --- |
| Mary (Sis).mp3 / WakianTech | **CC-BY 3.0** | 「Little Girl voices by WakianTech」<https://opengameart.org/content/little-girl-voices> |
| 24 Cute Fighting Game Voice Recordings | **CC-BY 3.0** | 见包内未附；页作者需在 OGA 页面署名，<https://opengameart.org/content/24-cute-fighting-game-voice-recordings> |
| childrens_game_app_ending / Almitory | **CC-BY 4.0** | 「Video game cheerful ending by Almitory」<https://opengameart.org/content/video-game-cheerful-ending> |
| applause.wav | **CC-BY 3.0** | <https://opengameart.org/content/applause> |
| Kenney Voiceover Pack（40 lines）/ Voiceover Fighter | **CC0** | 不强制（Kenney 授权原文：public domain licensed (CC0)，署名可选） |
| vsgame（round_end.wav / death.wav） | **CC0** | — |
| RPG Sound Pack（artisticdude） | **CC0** | — |
| Kenney Music Jingles | **CC0** | — |

## 逐条对照

### A 组「哇！」童真惊叹

| 输出 | 源 | 授权 |
| --- | --- | --- |
| `wow-mary-00` … `wow-mary-11` | `Mary (Sis).mp3` 按静音切出的 12 段（原始 23.98s） | CC-BY 3.0 |
| `wow-cute-bonzai` | `Female - Bonzai 1.wav` | CC-BY 3.0 |
| `wow-cute-geronimo` | `Female - Geronimo 1.wav` | CC-BY 3.0 |
| `wow-cute-invincible` | `Female - Im Invincible 1.wav` | CC-BY 3.0 |
| `wow-cute-victory` | `Female - Onward to Victory 1.wav` | CC-BY 3.0 |
| `wow-cute-hiya` | `Female - Hiya 1.wav` | CC-BY 3.0 |
| `wow-cute-charge` | `Female - Charge 1.wav` | CC-BY 3.0 |
| `wow-v40-f-congrats` | Kenney `Female/congratulations.ogg` | CC0 |
| `wow-v40-f-levelup` | Kenney `Female/level_up.ogg` | CC0 |
| `wow-v40-f-yay` | Kenney `Female/you_win.ogg` | CC0 |
| `wow-v40-m-congrats` | Kenney `Male/congratulations.ogg` | CC0 |
| `wow-v40-m-yay` | Kenney `Male/you_win.ogg` | CC0 |
| `wow-cheerful-cut` / `wow-cheerful-full` | `childrens_game_app_ending.mp3`（截 2.2s / 完整） | CC-BY 4.0 |
| `wow-applause-cut` | `applause.wav` 前 2.5s | CC-BY 3.0 |
| `wow-roundend` | `vsgame/round_end.wav` | CC0 |

> 说明：`Mary (Sis).mp3` 是连续 24 秒的语音合集，12 段按能量静音自动切分，**段内内容未逐段核对**（无听辨能力）。
> 其中只有部分片段可能是「哇」类惊叹，需人耳确认；选中后用 `start/dur` 参数精确重切。

### B 组 失败 sting

| 输出 | 源 | 授权 |
| --- | --- | --- |
| `fail-steel14` | Kenney `jingles_STEEL14` | CC0 |
| `fail-sax07` | Kenney `jingles_SAX07` | CC0 |
| `fail-shade13` / `fail-shade11` | RPG `NPC/shade/` | CC0 |
| `fail-ogre3` | RPG `NPC/ogre/ogre3.wav` | CC0 |
| `fail-wolfman` | RPG `NPC/misc/wolfman.wav` | CC0 |
| `fail-pizza07` | Kenney `jingles_PIZZA07` | CC0 |
| `fail-death` | `vsgame/death.wav` | CC0 |

## 补充：人群欢呼（`wow-crowd-01` … `wow-crowd-10`）

- 来源：**Gregor Quendel — Free Crowd Cheering Sounds**，<https://opengameart.org/content/free-crowd-cheering-sounds>
- 授权：**CC-BY 4.0**（署名：「Crowd cheering sounds by Gregor Quendel, CC-BY 4.0」）
- 原始文件：11 条长录音（14s ~ 224s），`- Crowd Cheering Sounds - 01/02/…/10`。
- 切法：程序自动取每条**能量最响的 2.5 秒窗口**（提前 0.3s 起，尾部 0.35s 淡出），**未逐条人耳核对内容**。
- `11 - Full recording`（224s）未切，已跳过。

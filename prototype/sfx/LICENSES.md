# `prototype/sfx/` 音效授权清单

本目录是一次性试听台（`prototype/m3-sfx-audition-stub.html`）的候选音效，**全部为 CC0（公共领域）**，
不要求署名。此文件为记录来源用，正式接入时照此溯源即可。

转码口径：统一 **64 kbps 单声道 mp3**（44.1 kHz），峰值归一到约 -1.5 dBFS；
不足 0.22 s 的极短素材补静音，避免播放器解码误判。原文件全部保留在仓库根的 `.sfx-raw/`（不入库）。

- Kenney 授权原文：「all game assets on the asset pages are public domain licensed (CC0)」——<https://kenney.nl/support>
- RPG Sound Pack 作者 artisticdude，CC0。

---

## 1. Kenney Casino Audio（CC0，59 条目）

- 来源页：<https://kenney.nl/assets/casino-audio>
- 本地包：`.sfx-raw/casino.zip`

| 原始文件名 | 转码后文件名 |
| --- | --- |
| `Audio/dice-throw-1.ogg` | `dice-throw-1.mp3` |
| `Audio/dice-throw-2.ogg` | `dice-throw-2.mp3` |
| `Audio/die-throw-3.ogg` | `die-throw-3.mp3` |
| `Audio/card-slide-1.ogg` | `card-slide-1.mp3` |
| `Audio/cards-pack-take-out-1.ogg` | `card-take-out-1.mp3` |
| `Audio/card-fan-1.ogg` | `card-fan-1.mp3` |
| `Audio/chip-lay-3.ogg` | `chip-lay-3.mp3` |
| `Audio/chip-lay-2.ogg` | `chip-lay-2.mp3` |
| `Audio/chips-collide-3.ogg` | `chips-collide-3.mp3` |
| `Audio/card-place-2.ogg` | `card-place-2.mp3` |

## 2. Kenney Interface Sounds（CC0，104 条目）

- 来源页：<https://kenney.nl/assets/interface-sounds>
- 本地包：`.sfx-raw/iface.zip`

| 原始文件名 | 转码后文件名 |
| --- | --- |
| `Audio/click_001.ogg` | `click-001.mp3` |
| `Audio/toggle_001.ogg` | `toggle-001.mp3` |
| `Audio/drop_003.ogg` | `drop-003.mp3` |
| `Audio/confirmation_003.ogg` | `confirm-003.mp3` |
| `Audio/error_003.ogg` | `iface-error-003.mp3` |
| `Audio/error_005.ogg` | `iface-error-005.mp3` |

## 3. Kenney Music Jingles（CC0，92 条目）

- 来源页：<https://kenney.nl/assets/music-jingles>
- 本地包：`.sfx-raw/jingles.zip`

| 原始文件名 | 转码后文件名 |
| --- | --- |
| `OGG/jingles_SAX/jingles_SAX03.ogg` | `jingle-sax-03.mp3` |
| `OGG/jingles_SAX/jingles_SAX07.ogg` | `jingle-sax-07.mp3` |
| `OGG/jingles_NES/jingles_NES00.ogg` | `jingle-nes-00.mp3` |
| `OGG/jingles_STEEL/jingles_STEEL02.ogg` | `jingle-steel-02.mp3` |

## 4. RPG Sound Pack（CC0，作者 artisticdude）

- 来源页：<https://opengameart.org/content/rpg-sound-pack>
- 直链：<https://opengameart.org/sites/default/files/rpg_sound_pack.zip>（12,465,564 字节）
- 本地包：`.sfx-raw/rpg.zip`

| 原始文件名 | 转码后文件名 |
| --- | --- |
| `NPC/beetle/bite-small.wav` | `bite-small-1.mp3` |
| `NPC/beetle/bite-small3.wav` | `bite-small-3.mp3` |
| `NPC/gutteral beast/mnstr14.wav` | `mnstr-14.mp3` |
| `NPC/shade/shade8.wav` | `shade-8.mp3` |
| `NPC/shade/shade12.wav` | `shade-12.mp3` |
| `inventory/coin.wav` | `coin-1.mp3` |
| `inventory/coin3.wav` | `coin-3.mp3` |
| `inventory/wood-small.wav` | `wood-small.mp3` |
| `interface/interface6.wav` | `interface-6.mp3` |
| `world/door.wav` | `door.mp3` |

---

## 合计

30 个 mp3，共 179,257 字节（约 175.0 KB），全部 CC0。

# `client/public/audio/` 音效授权清单

> M3 音效定档（[#49](https://github.com/shanchahuaA/party_flight_chess/issues/49)，2026-11-09 用户逐格试听拍板）。
> 12 个时机 × 1 条，统一 **64 kbps 单声道 mp3（44.1 kHz）**，峰值归一到约 −1.5 dBFS，**总量 116 KB**。
> 不用 ogg：iOS 18.4 之前 Safari 不播 Ogg Vorbis。

## ⚠️ 两条 CC-BY，必须署名

12 条里 **10 条 CC0、2 条 CC-BY**。CC-BY 的两条（见下表 ⚑）在发布页/关于页需带上署名文案：

```
Crowd cheering sounds by Gregor Quendel — CC-BY 4.0
Footstep sounds by congusbongus (derived from footstep-concrete.wav by swuing) — CC-BY 3.0
```

其余条目 CC0，不要求署名（Kenney 授权原文：「all game assets on the asset pages are public domain licensed (CC0)」，<https://kenney.nl/support>）。

## 逐条对照

| 文件 | 时机 | 来源 | 原始文件 | 授权 |
|---|---|---|---|---|
| `roll.mp3` | 掷骰落定 | Kenney Casino Audio | `Audio/dice-throw-1.ogg` | CC0 |
| `draw.mp3` | 抽卡 / 发牌 | Kenney Casino Audio | `Audio/cards-pack-take-out-1.ogg` | CC0 |
| `play.mp3` | 打出道具卡 | Kenney Casino Audio | `Audio/card-place-2.ogg` | CC0 |
| `hurt.mp3` | 自己扣血 | RPG Sound Pack（artisticdude） | `battle/bite-small-1.wav` | CC0 |
| `score.mp3` | 得分 / 结算加分 | RPG Sound Pack | `inventory/coin.wav` | CC0 |
| `beast.mp3` | 年兽吼 / 重击 | RPG Sound Pack | `NPC/shade/shade8.wav` | CC0 |
| `fail.mp3` | 失败 sting | RPG Sound Pack | `NPC/ogre/ogre3.wav` | CC0 |
| ⚑ `win.mp3` | 胜利 sting（「哇！」人群惊叹） | Gregor Quendel — Free Crowd Cheering Sounds | `- Crowd Cheering Sounds - 01 - Strong cheering and strong rhythmic cheering` 最响 2.5s | **CC-BY 4.0** |
| `ui.mp3` | UI 轻点 | Kenney Interface Sounds | `Audio/drop_004.ogg` | CC0 |
| ⚑ `step.mp3` | 走格脚步 | Footsteps on different surfaces（congusbongus） | `footsteps/boots/1.ogg` | **CC-BY 3.0** |
| `turn.mp3` | 轮到自己 | Kenney Interface Sounds | `Audio/confirmation_001.ogg` | CC0 |
| `out.mp3` | 观战 / 出局 | RPG Sound Pack | `NPC/shade/shade14.wav` | CC0 |

## 来源页

- Kenney Casino Audio <https://kenney.nl/assets/casino-audio>（CC0）
- Kenney Interface Sounds <https://kenney.nl/assets/interface-sounds>（CC0）
- Kenney 授权总页 <https://kenney.nl/support>（CC0，署名可选）
- RPG Sound Pack, artisticdude <https://opengameart.org/content/rpg-sound-pack>（CC0）
- Gregor Quendel — Free Crowd Cheering Sounds <https://opengameart.org/content/free-crowd-cheering-sounds>（CC-BY 4.0）
- Footsteps on different surfaces, congusbongus <https://opengameart.org/content/footsteps-on-different-surfaces>（混合：`boots/` 为 CC-BY 3.0，原始来源 footstep-concrete.wav by swuing <https://freesound.org/people/swuing/sounds/38873/>）

## 试听痕迹（可删）

三轮试听台与候选素材在设计期留在 `prototype/`：`m3-sfx-audition-stub.html`（第一轮 30 条）、
`m3-sfx-audition2-stub.html`（第二轮 48 条）、`m3-sfx-audition3-stub.html`（第三轮 45 条），授权清单在
`prototype/sfx{,_2,_3}/LICENSES.md`。实现票只需本目录这 12 条。

/**
 * 音效素材署名（M3-T2，#54 / 清单 A-06）：12 条里 10 条 CC0（不要求署名），
 * **2 条 CC-BY 必须在产品可见处带上署名文案**——`win.mp3`（CC-BY 4.0）与 `step.mp3`（CC-BY 3.0）。
 *
 * 文案原文在 `client/public/audio/LICENSES.md` 顶部（授权清单是唯一真源）；
 * 本文件只是把它搬进可渲染的常量，`credits.test.ts` 对 LICENSES.md 逐字对账，
 * 防止有人改了一处忘了另一处。
 */

/** 一条署名 */
export interface Credit {
  /** 素材文件名（产品处可显示，也方便对账：LICENSES.md 表格里的 ⚑ 行） */
  file: string;
  /** 署名文案（与 LICENSES.md 一字不差） */
  text: string;
}

/**
 * 必须署名的两条（顺序与 LICENSES.md 顶部代码块一致）。
 * 文案含长破折号 `—`，不要换成连字符。
 */
export const SFX_CREDITS: readonly Credit[] = [
  {
    file: "win.mp3",
    text: "Crowd cheering sounds by Gregor Quendel — CC-BY 4.0",
  },
  {
    file: "step.mp3",
    text: "Footstep sounds by congusbongus (derived from footstep-concrete.wav by swuing) — CC-BY 3.0",
  },
];

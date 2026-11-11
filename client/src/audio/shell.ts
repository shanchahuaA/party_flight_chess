/**
 * 播放器的壳层接线（M3-T2，#54）：本文件是 `audio/sfx.ts` 与 Vue/DOM 之间的**唯一**配线处。
 *
 * 三件事：
 * 1. **判定 → 出声**：watch `gameStore.freshSfx`（T1 的 `deriveSounds` 每批算好的结果，只含自己身上的事），
 *    一次性交给播放器。组件不许自己播、不许自己判。
 * 2. **首次手势解锁**（A-03 / G-17）：`AudioContext.resume()` 必须在用户手势内。挂一个 capture 期的
 *    pointerdown/click 监听——只要还没 running，下一次手势就再试一次（「不是就等下一次手势」）；
 *    大厅「开始游戏」按钮另有显式调用（见 Lobby.vue），那条最稳。
 * 3. **UI 轻点（12 格第 9 格）**：通用按钮的音由播放器层挂（判定模块不产 `ui`），
 *    一个委托监听覆盖全站按钮，组件不各自补音。
 *
 * 另外给 T3 的 ⚙ 面板留一份**响应式只读面**（`sfxUi`）与开关写入函数：纯逻辑模块 `sfx.ts` 保持
 * 零 Vue/零 DOM（Node 直测），响应式包装住这一层。
 *
 * 零 UI、不挂 Vue 组件：`App.vue` 的 onMounted 调一次 `installSfxShell()`。
 */
import { reactive, watch } from "vue";
import { gameStore } from "../game/store";
import { sfxPlayer } from "./sfx";

/**
 * 播放器状态的响应式镜像（T3 设置面板的唯一读数面）：
 * - `enabled`：🔊 音效是否开（关掉=全局静音）
 * - `vibrateOn`：📳 震动是否开
 * - `canVibrate`：设备是否支持震动——**false 时整行隐藏**（A-05，不做假开关）
 * - `needsUnlock`：是否待解锁——true 时面板显示可点的「开启音效」（G-17，不许静默失败）
 */
export const sfxUi = reactive({
  enabled: sfxPlayer().enabled,
  vibrateOn: sfxPlayer().vibrateOn,
  canVibrate: sfxPlayer().canVibrate,
  needsUnlock: sfxPlayer().needsUnlock,
});

/** 🔊 开关写入（T3 面板调；内存态 + localStorage 双写，写不进也不抛） */
export function enableSfx(on: boolean): void {
  sfxPlayer().setEnabled(on);
  sfxUi.enabled = sfxPlayer().enabled;
}

/** 📳 开关写入 */
export function enableVibrate(on: boolean): void {
  sfxPlayer().setVibrate(on);
  sfxUi.vibrateOn = sfxPlayer().vibrateOn;
}

/** 「开启音效」按钮调（T3 面板 unlock 失败态）：必须在用户手势内调，返回是否成功 */
export async function unlockSfx(): Promise<boolean> {
  const ok = await sfxPlayer().unlock();
  sfxUi.needsUnlock = sfxPlayer().needsUnlock;
  return ok;
}

let installed = false;

/**
 * 冒烟探针（`?dev=1` 才挂 `__pzsfx()`）：播放器状态 + 最近 20 批判定出的音效名。
 * Web Audio 是否真出声只能靠耳朵，但「该播什么、有没有解锁、静音没」可以页内读——
 * A-03/A-04/A-07 的冒烟断言口。不进生产路径（未带 dev 参数时这个闭包都不存在）。
 */
const devLog: string[] | null = (() => {
  try {
    return new URLSearchParams(location.search).has("dev") ? [] : null;
  } catch {
    return null;
  }
})();

/** 把玩家状态同步进响应式镜像（解锁/失败后调用；T3 面板据此显示「开启音效」） */
function syncUi(): void {
  const p = sfxPlayer();
  sfxUi.enabled = p.enabled;
  sfxUi.vibrateOn = p.vibrateOn;
  sfxUi.canVibrate = p.canVibrate;
  sfxUi.needsUnlock = p.needsUnlock;
}

export function installSfxShell(): void {
  if (installed) return;
  installed = true;
  const player = sfxPlayer();
  syncUi();

  if (devLog) {
    (window as unknown as Record<string, unknown>).__pzsfx = () => ({
      enabled: player.enabled,
      vibrateOn: player.vibrateOn,
      canVibrate: player.canVibrate,
      ready: player.ready,
      needsUnlock: player.needsUnlock,
      assets: player.assetStats,
      recent: [...devLog],
    });
  }

  // ① 判定模块的每批结果 → 播放器（含震动判决：hurt/roll/turn 三处在 playAll 内对偶触发）。
  //    sync：每批事实算完立刻出声——默认 pre 批在微任务里合并，同一拍多批会丢中间那声；
  //    immediate：热重载/迟挂载时，已算好的首帧批（如直接进局）也不漏。
  //    播完顺手同步「待解锁」（系统挂起后会回落，供 T3 面板显示可点的「开启音效」）。
  watch(
    () => gameStore.freshSfx.value,
    (names) => {
      player.playAll(names);
      sfxUi.needsUnlock = player.needsUnlock;
      if (devLog && names.length > 0) {
        devLog.push(names.join("+"));
        if (devLog.length > 20) devLog.shift();
      }
    },
    { flush: "sync", immediate: true },
  );

  // ② 手势解锁：没 running 就再试——成功后就绪，之后每次手势只剩一次廉价状态读
  const tryUnlock = (): void => {
    if (!player.needsUnlock) return;
    void player.unlock().then(syncUi);
  };
  document.addEventListener("pointerdown", tryUnlock, true);
  document.addEventListener("click", tryUnlock, true);

  // ③ UI 轻点：全站按钮委托一声（禁用钮不响；这次点击顺带触发上面的解锁）
  document.addEventListener(
    "click",
    (ev) => {
      const target = ev.target;
      const btn = target instanceof Element ? target.closest("button") : null;
      if (!btn || (btn as HTMLButtonElement).disabled) return;
      player.play("ui");
    },
    true,
  );
}

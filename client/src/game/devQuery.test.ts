import { afterEach, describe, expect, it, vi } from "vitest";
import { hasDevQuery } from "./devQuery";

/**
 * dev 冒烟参数判据（`?dev=1`）的唯一口径——`audio/shell.ts`、`net/roomStore.ts`、
 * `game/store.ts` 三处同吃。求值时机各自保留（shell 是模块导入期、另两处是调用期），
 * 这里只钉口径本身：带 dev 为真、不带为假、取不到 location 时按「没带」处理（不崩）。
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasDevQuery：?dev=1 判据", () => {
  it("带 dev 参数为真（?dev=1 与 ?dev 都算）", () => {
    vi.stubGlobal("location", { search: "?dev=1" });
    expect(hasDevQuery()).toBe(true);
    vi.stubGlobal("location", { search: "?dev" });
    expect(hasDevQuery()).toBe(true);
  });

  it("不带 dev 参数为假（其它参数共存时也一样）", () => {
    vi.stubGlobal("location", { search: "?fast=1&room=ABCDE" });
    expect(hasDevQuery()).toBe(false);
    vi.stubGlobal("location", { search: "" });
    expect(hasDevQuery()).toBe(false);
  });

  it("取不到 location（非常规环境）按「没带 dev」处理，不抛", () => {
    vi.stubGlobal("location", undefined);
    expect(hasDevQuery()).toBe(false);
  });
});

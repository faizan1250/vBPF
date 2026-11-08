import { describe, expect, it } from "vitest";

import { banner, title } from "./main.js";

describe("banner", () => {
  it("names reserved port", () => {
    expect(title).toBe("vBPF");
    expect(banner()).toBe("vBPF dev on :5173");
  });
});

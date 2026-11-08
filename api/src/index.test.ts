import { describe, expect, it } from "vitest";

import { StatusSchema, describe as describeApi, status } from "./index.js";

describe("status", () => {
  it("matches schema", () => {
    expect(StatusSchema.parse(status)).toEqual(status);
  });

  it("names reserved port", () => {
    expect(describeApi()).toBe("api:8080");
  });
});

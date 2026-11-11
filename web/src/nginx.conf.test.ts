import { describe, expect, it } from "vitest";

import nginxConf from "../nginx.conf?raw";

function locationBlock(path: string): string {
  const match = nginxConf.match(
    new RegExp(`location ${path} \\{([^}]*)\\}`, "s"),
  );
  expect(match, `missing location ${path} block`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("nginx front door", () => {
  it("sets security headers", () => {
    for (const header of [
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Content-Security-Policy",
    ]) {
      expect(nginxConf).toContain(`add_header ${header}`);
    }
  });

  it("sets explicit proxy timeouts on api and ws locations", () => {
    for (const path of ["/api/", "/ws/"]) {
      const block = locationBlock(path);
      expect(block).toContain("proxy_read_timeout");
      expect(block).toContain("proxy_send_timeout");
    }
  });

  it("forwards client IP on api and ws locations", () => {
    for (const path of ["/api/", "/ws/"]) {
      const block = locationBlock(path);
      expect(block).toContain("X-Forwarded-For $proxy_add_x_forwarded_for");
      expect(block).toContain("X-Real-IP $remote_addr");
    }
  });
});

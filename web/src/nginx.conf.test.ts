import { describe, expect, it } from "vitest";

import nginxConf from "../nginx.conf?raw";

function locationBlock(path: string): string {
  const match = nginxConf.match(
    new RegExp(`location (?:= )?${path} \\{([^}]*)\\}`, "s"),
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
      "Permissions-Policy",
    ]) {
      expect(nginxConf).toContain(`add_header ${header}`);
    }
  });

  it("hides the server version banner", () => {
    expect(nginxConf).toMatch(/server_tokens\s+off/);
  });

  it("caps API request bodies at 64k", () => {
    for (const path of ["/api/generate", "/api/explain", "/api/"]) {
      const block = locationBlock(path);
      expect(block).toContain("client_max_body_size 64k");
    }
  });

  it("sets explicit proxy timeouts on api and ws locations", () => {
    for (const path of ["/api/generate", "/api/explain", "/api/", "/ws/"]) {
      const block = locationBlock(path);
      expect(block).toContain("proxy_connect_timeout 5s");
      expect(block).toContain("proxy_read_timeout 120s");
      expect(block).toContain("proxy_send_timeout 30s");
    }
  });

  it("forwards client IP on api and ws locations", () => {
    for (const path of ["/api/generate", "/api/explain", "/api/", "/ws/"]) {
      const block = locationBlock(path);
      expect(block).toContain("X-Forwarded-For $proxy_add_x_forwarded_for");
      expect(block).toContain("X-Real-IP $remote_addr");
    }
  });

  it("rate-limits the LLM endpoints as a second layer", () => {
    expect(nginxConf).toMatch(
      /limit_req_zone\s+\$binary_remote_addr\s+zone=llm/,
    );
    for (const path of ["/api/generate", "/api/explain"]) {
      const block = locationBlock(path);
      expect(block).toContain("limit_req zone=llm");
    }
  });
});

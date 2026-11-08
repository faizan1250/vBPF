import { z } from "zod";

export const StatusSchema = z.object({
  ok: z.literal(true),
  port: z.literal(8080),
});

export type Status = z.infer<typeof StatusSchema>;

export const status: Status = { ok: true, port: 8080 };

export function describe(): string {
  return `api:${status.port}`;
}

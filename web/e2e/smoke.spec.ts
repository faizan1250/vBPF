import { expect, test } from "@playwright/test";

test("serves index with title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/vBPF/);
});

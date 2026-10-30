import { expect, test } from "@playwright/test";

import { gotoSurface } from "./helpers/gateway";
import { waitForAny } from "./helpers/assert";

test.describe("Agency Operating System", () => {
  test("operations route exposes the employee operating surfaces", async ({ page }) => {
    await gotoSurface(page, "/agency-operations");
    await waitForAny(page, [".aops", "main"]);

    await expect(
      page.getByRole("heading", { name: /Agency Operations Center|Agency Operating System/ }),
    ).toBeVisible({ timeout: 20_000 });

    const employees = page.getByRole("button", { name: "Employees" });
    await expect(employees).toBeVisible();
    await employees.click();
    await expect(page.getByRole("heading", { name: "Employee directory" })).toBeVisible();

    const employeeOps = page.getByRole("button", { name: "Employee ops" });
    await employeeOps.click();
    await expect(
      page.getByRole("heading", { name: "Inbox, schedules, responsibilities and reviews" }),
    ).toBeVisible();

    const approvals = page.getByRole("button", { name: /Approval inbox/ });
    await approvals.click();
    await expect(page.getByRole("heading", { name: "Approval inbox" })).toBeVisible();

    const settings = page.getByRole("button", { name: "Agency settings" });
    await settings.click();
    await expect(page.getByRole("heading", { name: "Agency settings" })).toBeVisible();

    const reliability = page.getByRole("button", { name: "Reliability" });
    await reliability.click();
    await expect(
      page.getByRole("heading", { name: "Database health, backups and recovery" }),
    ).toBeVisible();
  });

  test("funnels route defaults to the canonical operating map", async ({ page }) => {
    await gotoSurface(page, "/funnels");
    await waitForAny(page, [".funnels-hud", ".afop", "main"]);

    const operatingMap = page.getByRole("button", { name: /OPERATING MAP/i });
    await expect(operatingMap).toBeVisible({ timeout: 20_000 });
    await operatingMap.click();

    await expect(page.getByRole("heading", { name: "Live Agency Funnel System" })).toBeVisible();
    await expect(page.getByText(/authoritative funnel map|Select an agency/i).first()).toBeVisible();
  });

  test("dashboard does not retain dismissed overlay surfaces", async ({ page }) => {
    await gotoSurface(page, "/dashboard");
    await waitForAny(page, [".dash-page", "main", ".app-shell"]);

    await page.keyboard.press("Escape");
    await expect(page.locator("agent-focus-panel[open]")).toHaveCount(0);
    await expect(page.locator("proactive-presenter")).toHaveCount(0);
  });
});

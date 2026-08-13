/**
 * End-to-end: this web UI, in a real browser, against this module's real
 * firmware -- with no hardware.
 *
 * The firmware runs in the Renode emulator, booted by zmk-west-commands'
 * `west zmk-web-e2e`, which serves the DUT's ZMK Studio RPC (carried over its
 * emulated USB CDC) to the browser and hands us a `navigator.serial` shim at
 * $ZMK_WEB_E2E_SHIM_URL. Installing that shim is the only thing faked here: the
 * app, its transport, the RPC framing and the firmware are all real.
 *
 *   west zmk-build tests/zmk-config -af web_e2e
 *   west zmk-web-e2e --elf build/web_e2e/zephyr/zmk.elf -- npm --prefix web run e2e
 *
 * The DUT carries the two runtime-accel instances from the
 * runtime-accel-instances snippet (tests/zmk-config/snippets/), so the curve
 * editor drives the full ListInstances -> GetCurve -> SetCurve path.
 */
import { test, expect } from "@playwright/test";

const SHIM_URL = process.env.ZMK_WEB_E2E_SHIM_URL;
// CONFIG_ZMK_KEYBOARD_NAME of the DUT (tests/zmk-config/config/tester_xiao.conf).
const DEVICE_NAME = process.env.ZMK_WEB_E2E_DEVICE_NAME || "Module Test";

test("the curve editor round-trips the custom RPC with real firmware", async ({
  page,
  request,
}) => {
  test.skip(
    !SHIM_URL,
    "no DUT: run this through `west zmk-web-e2e` (see the file header)"
  );

  // Install the navigator.serial shim before the app's own scripts run, so the
  // app sees a serial port -- the DUT's Studio CDC in Renode -- to connect to.
  await page.addInitScript(await (await request.get(SHIM_URL!)).text());
  await page.goto("/");

  // Click the app's real Connect button. Its transport opens the shimmed port,
  // completes the Studio handshake against the firmware, and the app renders
  // the name the firmware reported.
  await page.getByRole("button", { name: /Connect USB/ }).click();
  await expect(page.getByText(`Connected to: ${DEVICE_NAME}`)).toBeVisible();

  // The firmware registered this module's custom subsystem: the app found it
  // and rendered the curve editor (it renders a "not found" warning otherwise).
  await expect(
    page.getByRole("heading", { name: "Acceleration Curves" })
  ).toBeVisible();

  // ListInstances: both devicetree instances from the snippet are listed.
  await expect(page.getByRole("button", { name: "pointer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "scroll" })).toBeVisible();

  // GetCurve: the pointer instance's devicetree default-curve
  // <0 1000 1000 1000 3000 3500> is loaded into the editor (3 points).
  await expect(page.getByLabel("point 0 factor")).toHaveValue("1000");
  await expect(page.getByLabel("point 2 speed")).toHaveValue("3000");
  await expect(page.getByLabel("point 2 factor")).toHaveValue("3500");
  await expect(page.getByTestId("curve-svg")).toBeVisible();

  // SetCurve (persist=false): edit a factor beyond the firmware clamp; the
  // firmware sanitizes on apply and the UI reloads the clamped value.
  const factor2 = page.getByLabel("point 2 factor");
  await factor2.fill("99999");
  await page.getByRole("button", { name: /Apply \(RAM\)/ }).click();
  await expect(page.getByTestId("status")).toHaveText("Applied (RAM only)");
  await expect(factor2).toHaveValue("20000");

  // SetCurve (persist=true): the same value saved to flash via the
  // custom-settings write path.
  await page.getByRole("button", { name: /Save/ }).click();
  await expect(page.getByTestId("status")).toHaveText("Saved to flash");

  // Switching instances loads the scroll instance's own default curve
  // <0 1000 3000 2000>.
  await page.getByRole("button", { name: "scroll" }).click();
  await expect(page.getByLabel("point 1 speed")).toHaveValue("3000");
  await expect(page.getByLabel("point 1 factor")).toHaveValue("2000");
});

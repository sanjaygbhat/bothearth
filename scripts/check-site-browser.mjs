import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../computer-server/package.json", import.meta.url))("playwright");
const base = process.argv[2];
assert(base && /^https?:\/\//.test(base), "Pass the built site's preview URL");
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || "chrome", headless: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    for (const path of ["", "security/", "about/"]) {
      const url = new URL(path, base).href;
      await page.goto(url);
      const link = page.locator('a[href$=".png"]').filter({ has: page.locator("img") }).first();
      await link.scrollIntoViewIfNeeded();
      const scroll = await page.evaluate(() => scrollY);
      for (const method of ["button", "outside", "Escape"]) {
        await link.click();
        const dialog = page.getByRole("dialog", { name: "Image preview" });
        await dialog.waitFor({ state: "visible" });
        assert.equal(page.url(), url, "Opening the image must not navigate away");
        await dialog.locator("img").evaluate(img => img.decode());
        await page.keyboard.press("Tab");
        assert(await dialog.evaluate(el => el.contains(document.activeElement)), "Focus stays in the modal");
        if (method === "button") await dialog.getByRole("button", { name: "Close ×" }).click();
        else if (method === "outside") await page.mouse.click(2, 2);
        else await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        assert.equal(page.url(), url);
        assert(await link.evaluate(el => el === document.activeElement), "Closing returns focus to the image link");
        assert(Math.abs(await page.evaluate(() => scrollY) - scroll) < 3, "Closing preserves the reading position");
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal overflow");
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Image viewer passed at ${width}px: all image pages, close button, outside click, Escape, focus and scroll`);
  }
} finally { await browser.close(); }

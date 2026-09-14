import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "showcase", "screenshots");

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: "dark" })).newPage();
await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
await page.click('button:has-text("载入示例地图")');
await page.waitForSelector("canvas");
await page.waitForTimeout(2500);

const canvas = page.locator("canvas").first();
const box = await canvas.boundingBox();
if (box) {
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.52);
  await page.waitForTimeout(600);
  const readBtn = page.locator('button:has-text("标记已读")');
  if (await readBtn.count()) {
    await readBtn.first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, "workflow-02-lit.png") });
    console.log("✓ workflow-02-lit.png");
  }
}

await page.click('button[role="tab"]:has-text("去哪儿")');
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(OUT, "09-map-expanded.png") });
console.log("✓ 09-map-expanded.png");

await browser.close();

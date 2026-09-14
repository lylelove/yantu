/**
 * Capture showcase screenshots for Yantu product site.
 * Run: node scripts/capture-showcase.mjs
 */
import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "showcase", "screenshots");
const BASE = "http://localhost:5173";
const VIEWPORT = { width: 1280, height: 720 };

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  ✓ ${name}.png`);
}

async function waitForMap(page) {
  await page.waitForSelector("canvas", { timeout: 15000 });
  // Let force layout settle
  await page.waitForTimeout(2500);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  const page = await context.newPage();

  console.log("Capturing Yantu showcase screenshots…");

  // 1. Welcome / empty state
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await shot(page, "01-welcome");

  // 2. Load sample map
  await page.click('button:has-text("载入示例地图")');
  await waitForMap(page);
  await shot(page, "02-hero-map");

  // 3. Leads panel (default)
  await page.click('button[role="tab"]:has-text("去哪儿")');
  await page.waitForTimeout(500);
  await shot(page, "03-leads-panel");

  // 4. Regions panel
  await page.click('button[role="tab"]:has-text("版图")');
  await page.waitForTimeout(500);
  await shot(page, "04-regions-panel");

  // 5. Expeditions panel
  await page.click('button[role="tab"]:has-text("探索")');
  await page.waitForTimeout(500);
  await shot(page, "05-expeditions-panel");

  // 6. Click a lit node on canvas — select paper
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (box) {
    // Click center-left area where lit nodes typically land
    await page.mouse.click(box.x + box.width * 0.38, box.y + box.height * 0.45);
    await page.waitForTimeout(800);
    await page.click('button[role="tab"]:has-text("详情")');
    await page.waitForTimeout(600);
    await shot(page, "06-paper-detail");
  }

  // 7. Import sheet
  await page.click('button:has-text("导入文献")');
  await page.waitForTimeout(600);
  await shot(page, "07-import-sheet");
  await page.locator('.sheet-backdrop button:has-text("取消"), .sheet-backdrop button[aria-label="关闭"]').first().click({ timeout: 3000 }).catch(() => page.keyboard.press("Escape"));
  await page.waitForSelector('.sheet-backdrop', { state: "hidden", timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);

  // 8. Search interaction
  await page.fill('input[type="search"]', "graph");
  await page.waitForTimeout(600);
  await shot(page, "08-search");

  // 9. Workflow frames for GIF
  await page.fill('input[type="search"]', "");
  await page.waitForTimeout(300);

  // Click a frontier node to show selection
  if (box) {
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.52);
    await page.waitForTimeout(500);
    await shot(page, "workflow-01-select");
  }

  // Mark as read if button exists
  const readBtn = page.locator('button:has-text("标记已读")');
  if (await readBtn.count()) {
    await readBtn.first().click();
    await page.waitForTimeout(1200);
    await shot(page, "workflow-02-lit");
  }

  // Write note
  const noteArea = page.locator("textarea").first();
  if (await noteArea.count()) {
    await noteArea.fill("探索笔记：这篇论文连接了两个区域，写下想法后视野向外扩展。");
    await page.waitForTimeout(800);
    await shot(page, "workflow-03-beacon");
  }

  // Final map state
  await page.click('button[role="tab"]:has-text("去哪儿")');
  await page.waitForTimeout(800);
  await shot(page, "09-map-expanded");

  await browser.close();
  console.log("\nDone! Screenshots saved to showcase/screenshots/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

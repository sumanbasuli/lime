import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsSiteRoot = path.resolve(__dirname, "..");

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    return fallback;
  }
  return process.argv[index + 1];
}

const baseUrl = readArg("--base-url", process.env.LIME_DOCS_UI_URL ?? "http://localhost:13000").replace(/\/$/, "");
const scanId = readArg("--scan-id", process.env.LIME_DOCS_SCAN_ID);
const partialScanId = readArg("--partial-scan-id", process.env.LIME_DOCS_PARTIAL_SCAN_ID ?? scanId);
const outputDir = path.resolve(readArg("--output", path.join(docsSiteRoot, "public", "screenshots")));

if (!scanId) {
  console.error("Missing --scan-id. The docs screenshot runner must target the isolated docs-demo scan explicitly.");
  process.exit(1);
}

async function capture(page, url, fileName, options = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (options.afterLoad) {
    await options.afterLoad(page);
  }
  await page.screenshot({
    path: path.join(outputDir, fileName),
    fullPage: false,
  });
}

async function clickIfVisible(page, locator, timeout = 5_000) {
  try {
    const target = locator.first();
    await target.waitFor({ state: "visible", timeout });
    await target.click();
    return true;
  } catch {
    return false;
  }
}

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});

try {
  await capture(page, `${baseUrl}/`, "dashboard.png");
  await capture(page, `${baseUrl}/scans/new`, "new-scan.png");
  await capture(page, `${baseUrl}/scans/${scanId}`, "scan-detail.png");
  await capture(page, `${baseUrl}/scans/${partialScanId}`, "partial-retry.png", {
    afterLoad: async (currentPage) => {
      await currentPage
        .getByText("Partial scan recovery")
        .waitFor({ state: "visible", timeout: 15_000 });
      await currentPage
        .getByRole("button", { name: /retry failed pages/i })
        .waitFor({ state: "visible", timeout: 10_000 });
    },
  });
  await capture(page, `${baseUrl}/scans/${scanId}/issues`, "issues.png");

  await capture(page, `${baseUrl}/scans/${scanId}/issues`, "expanded-issue.png", {
    afterLoad: async (currentPage) => {
      await clickIfVisible(currentPage, currentPage.locator(".issue-card-trigger"), 10_000);
      await currentPage
        .getByText("Affected elements")
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => currentPage.waitForTimeout(4_000));
    },
  });

  await capture(page, `${baseUrl}/scans/${scanId}/issues`, "reports.png", {
    afterLoad: async (currentPage) => {
      await clickIfVisible(currentPage, currentPage.getByRole("button", { name: /download csv report/i }), 5_000);
      await currentPage.waitForTimeout(700);
    },
  });

  await capture(page, `${baseUrl}/settings`, "settings.png");
} finally {
  await browser.close();
}

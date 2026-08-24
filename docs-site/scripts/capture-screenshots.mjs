import { mkdir, stat } from "node:fs/promises";
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
const outputDir = path.resolve(readArg("--output", path.join(docsSiteRoot, "public", "product-screenshots")));

try {
  new URL(baseUrl);
} catch {
  console.error("Invalid --base-url. Provide an absolute http(s) URL.");
  process.exit(1);
}

if (!scanId) {
  console.error("Missing --scan-id. The docs screenshot runner must target the isolated docs-demo scan explicitly.");
  process.exit(1);
}

const runtimeErrors = [];

function isExpectedOptionalRequest(url) {
  try {
    return new URL(url).pathname === "/_lime/update-check";
  } catch {
    return false;
  }
}

async function capture(page, url, fileName, options = {}) {
  runtimeErrors.length = 0;
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  if (!response?.ok()) {
    throw new Error(`Could not capture ${url}: HTTP ${response?.status() ?? "no response"}.`);
  }
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (options.afterLoad) {
    await options.afterLoad(page);
  }
  const bodyText = (await page.locator("body").innerText()).trim();
  if (bodyText.length < 40) {
    throw new Error(`Could not capture ${url}: the page did not render meaningful content.`);
  }
  if (await page.locator("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay").count()) {
    throw new Error(`Could not capture ${url}: a framework error overlay is visible.`);
  }
  if (runtimeErrors.length) {
    throw new Error(`Could not capture ${url}: browser errors:\n${runtimeErrors.join("\n")}`);
  }
  const outputPath = path.join(outputDir, fileName);
  await page.screenshot({
    path: outputPath,
    fullPage: false,
  });
  const screenshot = await stat(outputPath);
  if (screenshot.size < 10_000) {
    throw new Error(`Screenshot ${fileName} is unexpectedly small (${screenshot.size} bytes).`);
  }
  console.log(`Captured ${fileName} from ${url}`);
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

async function waitForImageReady(locator, timeout = 15_000) {
  await locator.waitFor({ state: "visible", timeout });
  await locator.evaluate(
    (image, timeoutMs) =>
      new Promise((resolve, reject) => {
        const htmlImage = /** @type {HTMLImageElement} */ (image);
        if (htmlImage.complete && htmlImage.naturalWidth > 0) {
          resolve(undefined);
          return;
        }

        const timer = setTimeout(
          () => reject(new Error(`Image did not load: ${htmlImage.currentSrc || htmlImage.src}`)),
          timeoutMs
        );
        const finish = () => {
          clearTimeout(timer);
          if (htmlImage.naturalWidth > 0) {
            resolve(undefined);
          } else {
            reject(new Error(`Image failed to load: ${htmlImage.currentSrc || htmlImage.src}`));
          }
        };
        htmlImage.addEventListener("load", finish, { once: true });
        htmlImage.addEventListener("error", finish, { once: true });
      }),
    timeout
  );
}

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
await page.emulateMedia({ reducedMotion: "reduce" });
page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error" && !isExpectedOptionalRequest(message.location().url)) {
    runtimeErrors.push(`console: ${message.text()}`);
  }
});
page.on("response", (response) => {
  if (response.status() >= 500) {
    runtimeErrors.push(`response: ${response.status()} ${response.url()}`);
  }
});

try {
  await capture(page, `${baseUrl}/`, "dashboard.png", {
    afterLoad: (currentPage) => currentPage.getByRole("heading", { name: /^overview$/i }).waitFor(),
  });
  await capture(page, `${baseUrl}/scans/new`, "new-scan.png", {
    afterLoad: (currentPage) => currentPage.getByRole("heading", { name: /new scan/i }).waitFor(),
  });
  await capture(page, `${baseUrl}/links`, "link-checker.png", {
    afterLoad: async (currentPage) => {
      await currentPage.getByRole("heading", { name: /link checker/i }).waitFor();
      await currentPage.getByRole("button", { name: /start link check/i }).waitFor();
    },
  });
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

      const thumbnail = currentPage.locator('img[alt^="Screenshot of "]').first();
      await waitForImageReady(thumbnail);
      await thumbnail.locator("..").click();

      const lightbox = currentPage.getByRole("dialog");
      await lightbox.waitFor({ state: "visible", timeout: 10_000 });
      await waitForImageReady(lightbox.locator("img"));
      await lightbox.getByRole("button", { name: /close/i }).click();
      await lightbox.waitFor({ state: "hidden", timeout: 10_000 });
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

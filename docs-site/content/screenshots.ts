export interface ProductScreenshot {
  id: string;
  title: string;
  caption: string;
  alt: string;
  src: string;
}

export const productScreenshots: ProductScreenshot[] = [
  {
    id: "dashboard",
    title: "Dashboard",
    caption: "Recent scans, coverage, scores, tags, and actions in one place.",
    alt: "LIME dashboard with recent scans and scan controls.",
    src: "/product-screenshots/dashboard.png",
  },
  {
    id: "new-scan",
    title: "New Scan",
    caption: "Start sitemap or single-page audits with viewport presets, tags, and an optional companion link check.",
    alt: "New scan form in LIME.",
    src: "/product-screenshots/new-scan.png",
  },
  {
    id: "scan-detail",
    title: "Scan Detail",
    caption: "Score, coverage, retry actions, severity summary, and audit results.",
    alt: "Scan detail page with accessibility score and audit summary.",
    src: "/product-screenshots/scan-detail.png",
  },
  {
    id: "partial-retry",
    title: "Retry State",
    caption: "A partial scan shows the in-place retry action for failed pages.",
    alt: "LIME scan detail page where partial scans show the failed-page retry card.",
    src: "/product-screenshots/partial-retry.png",
  },
  {
    id: "issues",
    title: "Issue Details",
    caption: "Large reports load in chunks with issue groups and occurrence paging.",
    alt: "Issue details page with grouped accessibility issues.",
    src: "/product-screenshots/issues.png",
  },
  {
    id: "expanded-issue",
    title: "Expanded Issue",
    caption: "Affected elements, selector, HTML context, ACT guidance, and screenshots.",
    alt: "Expanded issue card with affected element details and screenshot.",
    src: "/product-screenshots/expanded-issue.png",
  },
  {
    id: "reports",
    title: "Reports",
    caption: "Export PDF, small/full CSV, and compact LLM-ready reports.",
    alt: "Report download controls in LIME.",
    src: "/product-screenshots/reports.png",
  },
  {
    id: "settings",
    title: "Settings",
    caption: "Instance-wide report and integration controls, plus a browser-only update notice preference.",
    alt: "LIME settings page with reporting and performance controls.",
    src: "/product-screenshots/settings.png",
  },
  {
    id: "link-checker",
    title: "Link Checker",
    caption: "Start a bounded page or site check and revisit saved runs.",
    alt: "LIME Link checker page for starting and reviewing link checks.",
    src: "/product-screenshots/link-checker.png",
  },
  {
    id: "link-check-results",
    title: "Link Check Results",
    caption: "Saved destination status and grouped source references.",
    alt: "LIME link-check detail page with destination status filters and source references.",
    src: "/product-screenshots/link-check-results.png",
  },
];

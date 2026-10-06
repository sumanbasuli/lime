export interface ProductScreenshot {
  id: string;
  title: string;
  caption: string;
  alt: string;
  src: string;
  width: number;
  height: number;
}

export const productScreenshots: ProductScreenshot[] = [
  {
    id: "dashboard",
    title: "Dashboard",
    caption: "Review recent scans, compare scores, and see how much of your site was checked.",
    alt: "LIME dashboard with recent scans and scan controls.",
    src: "/product-screenshots/dashboard.png",
    width: 1440,
    height: 1000,
  },
  {
    id: "new-scan",
    title: "New Scan",
    caption: "Scan a page or sitemap, choose a screen size, and include a link check if needed.",
    alt: "New scan form in LIME.",
    src: "/product-screenshots/new-scan.png",
    width: 1440,
    height: 1000,
  },
  {
    id: "scan-detail",
    title: "Scan Detail",
    caption: "See your scan’s score, checked pages, and findings, with options to retry failed pages.",
    alt: "Scan detail page with accessibility score and audit summary.",
    src: "/product-screenshots/scan-detail.png",
    width: 1440,
    height: 1000,
  },
  {
    id: "partial-retry",
    title: "Retry Failed Pages",
    caption: "Continue an incomplete scan while keeping the results from pages already checked.",
    alt: "LIME scan detail page with a button to retry failed pages.",
    src: "/product-screenshots/partial-retry.png",
    width: 1440,
    height: 1000,
  },
  {
    id: "issues",
    title: "Issue Details",
    caption: "Browse findings by issue, then open each group to see the affected elements.",
    alt: "Issue details page with grouped accessibility issues.",
    src: "/product-screenshots/issues.png",
    width: 1440,
    height: 1000,
  },
  {
    id: "expanded-issue",
    title: "Expanded Issue",
    caption: "Find the affected element with its CSS selector, HTML, guidance, and screenshot.",
    alt: "Expanded issue card with affected element details and screenshot.",
    src: "/product-screenshots/expanded-issue.png",
    width: 1440,
    height: 1000,
  },
  {
    id: "reports",
    title: "Reports",
    caption: "Share findings as PDF, CSV, or a text report for your AI assistant.",
    alt: "Report download controls in LIME.",
    src: "/product-screenshots/reports.png",
    width: 1440,
    height: 1000,
  },
  {
    id: "settings",
    title: "Settings",
    caption: "Choose report options, connect AI tools, and manage update notifications.",
    alt: "LIME settings page with reporting and performance controls.",
    src: "/product-screenshots/settings.png",
    width: 1440,
    height: 1000,
  },
  {
    id: "link-checker",
    title: "Link Checker",
    caption: "Check a page or follow links across your site, then return to saved results anytime.",
    alt: "LIME Link checker page for starting and reviewing link checks.",
    src: "/product-screenshots/link-checker.png",
    width: 1440,
    height: 1000,
  },
  {
    id: "link-check-results",
    title: "Link Check Results",
    caption: "See which links need attention and find the pages that contain them.",
    alt: "LIME link-check detail page with destination status filters and source references.",
    src: "/product-screenshots/link-check-results.png",
    width: 1440,
    height: 1600,
  },
];

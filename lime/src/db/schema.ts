import {
  boolean,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";

// Enums matching the PostgreSQL enums defined in shopkeeper migrations
export const scanStatusEnum = pgEnum("scan_status", [
  "pending",
  "profiling",
  "scanning",
  "processing",
  "completed",
  "failed",
]);

export const urlStatusEnum = pgEnum("url_status", [
  "pending",
  "scanning",
  "completed",
  "failed",
]);

export const severityEnum = pgEnum("severity", [
  "critical",
  "serious",
  "moderate",
  "minor",
]);

export const auditOutcomeEnum = pgEnum("audit_outcome", [
  "passed",
  "failed",
  "not_applicable",
  "incomplete",
]);

// Tables

export const scans = pgTable("scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  sitemapUrl: text("sitemap_url").notNull(),
  status: scanStatusEnum("status").notNull().default("pending"),
  scanType: text("scan_type").notNull().default("sitemap"),
  tag: text("tag"),
  viewportPreset: text("viewport_preset").notNull().default("desktop"),
  viewportWidth: integer("viewport_width").notNull().default(1440),
  viewportHeight: integer("viewport_height").notNull().default(900),
  totalUrls: integer("total_urls").notNull().default(0),
  scannedUrls: integer("scanned_urls").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const urls = pgTable("urls", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  status: urlStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const issues = pgTable("issues", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  violationType: text("violation_type").notNull(),
  description: text("description").notNull(),
  helpUrl: text("help_url"),
  severity: severityEnum("severity").notNull(),
  isFalsePositive: boolean("is_false_positive").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const issueOccurrences = pgTable("issue_occurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id")
    .notNull()
    .references(() => issues.id, { onDelete: "cascade" }),
  urlId: uuid("url_id")
    .notNull()
    .references(() => urls.id, { onDelete: "cascade" }),
  htmlSnippet: text("html_snippet"),
  screenshotPath: text("screenshot_path"),
  elementScreenshotPath: text("element_screenshot_path"),
  cssSelector: text("css_selector"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const urlAudits = pgTable("url_audits", {
  id: uuid("id").primaryKey().defaultRandom(),
  urlId: uuid("url_id")
    .notNull()
    .references(() => urls.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull(),
  outcome: auditOutcomeEnum("outcome").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const urlAuditOccurrences = pgTable("url_audit_occurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  urlId: uuid("url_id")
    .notNull()
    .references(() => urls.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull(),
  outcome: auditOutcomeEnum("outcome").notNull(),
  htmlSnippet: text("html_snippet"),
  screenshotPath: text("screenshot_path"),
  elementScreenshotPath: text("element_screenshot_path"),
  cssSelector: text("css_selector"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

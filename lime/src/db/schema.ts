import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  uuid,
  text,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Enums matching the PostgreSQL enums defined in shopkeeper migrations
export const scanStatusEnum = pgEnum("scan_status", [
  "pending",
  "profiling",
  "scanning",
  "processing",
  "paused",
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
  pauseRequested: boolean("pause_requested").notNull().default(false),
  scanType: text("scan_type").notNull().default("sitemap"),
  tag: text("tag"),
  viewportPreset: text("viewport_preset").notNull().default("desktop"),
  viewportWidth: integer("viewport_width").notNull().default(1440),
  viewportHeight: integer("viewport_height").notNull().default(900),
  totalUrls: integer("total_urls").notNull().default(0),
  scannedUrls: integer("scanned_urls").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_scans_created_at_desc").on(table.createdAt.desc()),
  index("idx_scans_tag_created_at_desc").on(table.tag, table.createdAt.desc()),
]);

export const urls = pgTable("urls", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  status: urlStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_urls_scan_status").on(table.scanId, table.status),
  index("idx_urls_scan_url").on(table.scanId, table.url),
]);

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
}, (table) => [
  index("idx_issues_scan_false_positive").on(table.scanId, table.isFalsePositive),
  index("idx_issues_scan_violation_type").on(table.scanId, table.violationType),
]);

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
}, (table) => [
  index("idx_issue_occurrences_issue_url_created").on(
    table.issueId,
    table.urlId,
    table.createdAt
  ),
]);

export const urlAudits = pgTable("url_audits", {
  id: uuid("id").primaryKey().defaultRandom(),
  urlId: uuid("url_id")
    .notNull()
    .references(() => urls.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull(),
  outcome: auditOutcomeEnum("outcome").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("idx_url_audits_url_outcome_rule").on(
    table.urlId,
    table.outcome,
    table.ruleId
  ),
]);

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
}, (table) => [
  index("idx_url_audit_occurrences_url_outcome_rule_created").on(
    table.urlId,
    table.outcome,
    table.ruleId,
    table.createdAt
  ),
]);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  fullPdfOccurrenceLimit: integer("full_pdf_occurrence_limit")
    .notNull()
    .default(30),
  singleIssuePdfOccurrenceLimit: integer("single_issue_pdf_occurrence_limit")
    .notNull()
    .default(2000),
  smallCsvOccurrenceLimit: integer("small_csv_occurrence_limit")
    .notNull()
    .default(5),
  llmOccurrenceLimit: integer("llm_occurrence_limit")
    .notNull()
    .default(3),
  pdfReportsEnabled: boolean("pdf_reports_enabled").notNull().default(true),
  csvReportsEnabled: boolean("csv_reports_enabled").notNull().default(true),
  llmReportsEnabled: boolean("llm_reports_enabled").notNull().default(true),
  summaryCacheTtlSeconds: integer("summary_cache_ttl_seconds")
    .notNull()
    .default(60),
  reportDataCacheTtlSeconds: integer("report_data_cache_ttl_seconds")
    .notNull()
    .default(300),
  reportGenerationConcurrency: integer("report_generation_concurrency")
    .notNull()
    .default(1),
  mcpEnabled: boolean("mcp_enabled").notNull().default(false),
  mcpKeyHash: text("mcp_key_hash"),
  mcpKeyHint: text("mcp_key_hint"),
  mcpKeyGeneratedAt: timestamp("mcp_key_generated_at"),
  mcpSessionsRevokedAt: timestamp("mcp_sessions_revoked_at")
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const scanScoreSummaryCache = pgTable("scan_score_summary_cache", {
  scanId: uuid("scan_id")
    .primaryKey()
    .references(() => scans.id, { onDelete: "cascade" }),
  scanUpdatedAt: timestamp("scan_updated_at").notNull(),
  scanStatus: scanStatusEnum("scan_status").notNull(),
  score: integer("score"),
  hasScore: boolean("has_score").notNull(),
  hasAuditData: boolean("has_audit_data").notNull(),
  completedUrlCount: integer("completed_url_count").notNull(),
  failedUrlCount: integer("failed_url_count").notNull(),
  totalUrlCount: integer("total_url_count").notNull(),
  hasFullCoverage: boolean("has_full_coverage").notNull(),
  isPartialScan: boolean("is_partial_scan").notNull(),
  passedCount: integer("passed_count").notNull(),
  failedCount: integer("failed_count").notNull(),
  notApplicableCount: integer("not_applicable_count").notNull(),
  needsReviewCount: integer("needs_review_count").notNull(),
  excludedCount: integer("excluded_count").notNull(),
  weightedPassed: integer("weighted_passed").notNull(),
  weightedFailed: integer("weighted_failed").notNull(),
  weightedTotal: integer("weighted_total").notNull(),
  scoredAuditCount: integer("scored_audit_count").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("idx_scan_score_summary_cache_updated_at").on(table.updatedAt),
]);

export const scanIssueSummaryCache = pgTable("scan_issue_summary_cache", {
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  itemKey: text("item_key").notNull(),
  issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
  ruleId: text("rule_id"),
  title: text("title").notNull(),
  helpUrl: text("help_url"),
  severity: severityEnum("severity"),
  isFalsePositive: boolean("is_false_positive").notNull().default(false),
  occurrenceCount: integer("occurrence_count").notNull(),
  weight: integer("weight").notNull(),
  scored: boolean("scored").notNull(),
  sortBucket: integer("sort_bucket").notNull(),
  sortSeverity: integer("sort_severity").notNull(),
  sortTitle: text("sort_title").notNull(),
  scanUpdatedAt: timestamp("scan_updated_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({
    columns: [table.scanId, table.kind, table.itemKey],
  }),
  index("idx_scan_issue_summary_cache_page").on(
    table.scanId,
    table.sortBucket,
    table.weight.desc(),
    table.sortSeverity,
    table.sortTitle,
    table.itemKey
  ),
  index("idx_scan_issue_summary_cache_updated_at").on(table.updatedAt),
]);

export const scanReportDataCache = pgTable("scan_report_data_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  scanId: uuid("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  scopeKind: text("scope_kind").notNull().default("scan"),
  scopeKey: text("scope_key").notNull().default(""),
  format: text("format").notNull(),
  settingsFingerprint: text("settings_fingerprint").notNull(),
  scanUpdatedAt: timestamp("scan_updated_at").notNull(),
  metadata: jsonb("metadata")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_scan_report_data_cache_unique").on(
    table.scanId,
    table.scopeKind,
    table.scopeKey,
    table.format,
    table.settingsFingerprint
  ),
  index("idx_scan_report_data_cache_lookup").on(
    table.scanId,
    table.format,
    table.scopeKind,
    table.scopeKey,
    table.settingsFingerprint
  ),
  index("idx_scan_report_data_cache_expires_at").on(table.expiresAt),
]);

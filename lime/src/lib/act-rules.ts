import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { cache } from "react";

export interface ACTAccessibilityRequirement {
  id: string;
  title: string;
  forConformance: boolean;
  failed: string;
  passed: string;
  inapplicable: string;
}

export interface ACTRule {
  actRuleId: string;
  title: string;
  status: "approved" | "proposed" | "deprecated";
  ruleUrl: string;
  accessibilityRequirements: ACTAccessibilityRequirement[];
  summary: string;
  suggestedFixes: string[];
}

export interface AccessibilityReference {
  id: string;
  title: string;
  forConformance: boolean;
}

interface RawACTAccessibilityRequirement {
  id: string;
  title: string;
  for_conformance: boolean;
  failed: string;
  passed: string;
  inapplicable: string;
}

interface RawACTRule {
  act_rule_id: string;
  title: string;
  status: "approved" | "proposed" | "deprecated";
  rule_url: string;
  accessibility_requirements: RawACTAccessibilityRequirement[];
  summary: string;
  suggested_fixes: string[];
}

interface RawACTCatalog {
  axe_rule_to_act_rule_ids: Record<string, string[]>;
  act_rules: Record<string, RawACTRule>;
}

interface RawAxeRule {
  ruleId: string;
  description: string;
  help: string;
  helpUrl: string;
  tags?: string[];
}

interface RawAxeCatalogRule {
  rule_id: string;
  description: string;
  help: string;
  help_url: string;
  tags?: string[];
}

interface RawAxeCatalog {
  rules: RawAxeCatalogRule[];
}

interface RawAxeActMappingCatalog {
  procedure_to_act_rule_ids: Record<string, string[]>;
}

interface RawAxeGuidanceRule {
  success_criterion?: string;
  source_url?: string;
}

interface RawAxeGuidanceCatalog {
  rules: Record<string, RawAxeGuidanceRule>;
}

const emptyCatalog: RawACTCatalog = {
  axe_rule_to_act_rule_ids: {},
  act_rules: {},
};

const candidateCatalogPaths = () => [
  process.env.ACT_RULES_PATH,
  "/shared-data/act-rules.json",
  path.resolve(process.cwd(), "data", "act-rules.json"),
  path.resolve(process.cwd(), "..", "data", "act-rules.json"),
];

const candidateAxeBundlePaths = () => [
  process.env.AXE_BUNDLE_PATH,
  path.resolve(process.cwd(), "shopkeeper", "internal", "juicer", "axe.min.js"),
  path.resolve(
    process.cwd(),
    "..",
    "shopkeeper",
    "internal",
    "juicer",
    "axe.min.js"
  ),
];

const candidateAxeCatalogPaths = () => [
  process.env.AXE_RULES_PATH,
  "/shared-data/axe-rules.json",
  path.resolve(process.cwd(), "data", "axe-rules.json"),
  path.resolve(process.cwd(), "..", "data", "axe-rules.json"),
];

const candidateAxeActMappingPaths = () => [
  process.env.AXE_ACT_MAPPING_PATH,
  "/shared-data/axe-act-mapping.json",
  path.resolve(process.cwd(), "data", "axe-act-mapping.json"),
  path.resolve(process.cwd(), "..", "data", "axe-act-mapping.json"),
];

const candidateAxeGuidancePaths = () => [
  process.env.AXE_GUIDANCE_PATH,
  "/shared-data/axe-guidance.json",
  path.resolve(process.cwd(), "data", "axe-guidance.json"),
  path.resolve(process.cwd(), "..", "data", "axe-guidance.json"),
];

const loadCatalog = cache(async (): Promise<RawACTCatalog> => {
  for (const candidatePath of candidateCatalogPaths()) {
    if (!candidatePath) {
      continue;
    }

    try {
      await access(candidatePath);
      const file = await readFile(candidatePath, "utf8");
      return JSON.parse(file) as RawACTCatalog;
    } catch {
      continue;
    }
  }

  return emptyCatalog;
});

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

const loadAxeActMapping = cache(async (): Promise<RawAxeActMappingCatalog> => {
  for (const candidatePath of candidateAxeActMappingPaths()) {
    if (!candidatePath) {
      continue;
    }

    try {
      await access(candidatePath);
      const file = await readFile(candidatePath, "utf8");
      return JSON.parse(file) as RawAxeActMappingCatalog;
    } catch {
      continue;
    }
  }

  return { procedure_to_act_rule_ids: {} };
});

const loadAxeGuidance = cache(async (): Promise<RawAxeGuidanceCatalog> => {
  for (const candidatePath of candidateAxeGuidancePaths()) {
    if (!candidatePath) {
      continue;
    }

    try {
      await access(candidatePath);
      const file = await readFile(candidatePath, "utf8");
      return JSON.parse(file) as RawAxeGuidanceCatalog;
    } catch {
      continue;
    }
  }

  return { rules: {} };
});

const loadAxeRules = cache(async (): Promise<RawAxeRule[]> => {
  for (const candidatePath of candidateAxeCatalogPaths()) {
    if (!candidatePath) {
      continue;
    }

    try {
      await access(candidatePath);
      const file = await readFile(candidatePath, "utf8");
      const catalog = JSON.parse(file) as RawAxeCatalog;

      return (catalog.rules || []).map((rule) => ({
        ruleId: rule.rule_id,
        description: rule.description,
        help: rule.help,
        helpUrl: rule.help_url,
        tags: rule.tags || [],
      }));
    } catch {
      continue;
    }
  }

  for (const candidatePath of candidateAxeBundlePaths()) {
    if (!candidatePath) {
      continue;
    }

    try {
      await access(candidatePath);
      const source = await readFile(candidatePath, "utf8");
      const sandbox: {
        module: { exports: unknown };
        exports: unknown;
        window: { document?: unknown; axe?: unknown };
        self: unknown;
        globalThis: unknown;
        console: Console;
        setTimeout: typeof setTimeout;
        clearTimeout: typeof clearTimeout;
      } = {
        module: { exports: {} },
        exports: {},
        window: {},
        self: {},
        globalThis: {},
        console,
        setTimeout,
        clearTimeout,
      };
      sandbox.exports = sandbox.module.exports;
      sandbox.self = sandbox.window;
      sandbox.globalThis = sandbox.window;
      runInNewContext(source, sandbox, { filename: candidatePath });

      const axeBundle =
        (sandbox.module.exports as { getRules?: () => RawAxeRule[] }) ||
        (sandbox.window.axe as { getRules?: () => RawAxeRule[] } | undefined);

      if (typeof axeBundle?.getRules === "function") {
        return axeBundle.getRules();
      }
    } catch {
      continue;
    }
  }

  return [];
});

function normalizeWcagCriterion(tag: string): string | null {
  const digits = tag.replace(/^wcag/, "");
  if (!/^\d{3,4}$/.test(digits)) {
    return null;
  }

  return `WCAG ${digits[0]}.${digits[1]}.${digits.slice(2)}`;
}

function normalizeWcagLevels(tag: string): string[] {
  const match = tag.match(/^wcag(2|21|22)(a|aa|aaa)$/);
  if (!match) {
    return [];
  }

  const [, versionCode, level] = match;
  const versions =
    versionCode === "2"
      ? ["2.0", "2.1", "2.2"]
      : versionCode === "21"
        ? ["2.1", "2.2"]
        : ["2.2"];

  return versions.map((version) => `WCAG ${version} ${level.toUpperCase()}`);
}

function normalizeENReference(tag: string): string | null {
  if (!tag.startsWith("EN-")) {
    return null;
  }

  return tag.replace(/-/g, " ");
}

function normalizeSection508Reference(tag: string): string | null {
  if (tag === "section508") {
    return "Section 508";
  }

  const match = tag.match(/^section508\.(.+)$/);
  if (!match) {
    return null;
  }

  return `Section 508 ${match[1]}`;
}

function resolveAxeAccessibilityRequirements(
  tags: string[]
): AccessibilityReference[] {
  const wcagLevels = dedupeStrings(
    tags.flatMap((tag) => normalizeWcagLevels(tag))
  );

  const wcagCriteria = dedupeStrings(
    tags
      .map(normalizeWcagCriterion)
      .filter((requirement): requirement is string => Boolean(requirement))
  );

  const enReferences = dedupeStrings(
    tags
      .map(normalizeENReference)
      .filter((requirement): requirement is string => Boolean(requirement))
  );

  const section508References = dedupeStrings(
    tags
      .map(normalizeSection508Reference)
      .filter((requirement): requirement is string => Boolean(requirement))
  );

  return [
    ...wcagLevels,
    ...wcagCriteria,
    ...enReferences,
    ...section508References,
  ].map((title) => ({
    id: title,
    title,
    forConformance: true,
  }));
}

export function normalizeACTAccessibilityRequirements(
  requirements: ACTAccessibilityRequirement[]
): AccessibilityReference[] {
  return requirements.flatMap((requirement) => {
    let title = requirement.title;

    const wcagCriterionMatch = requirement.id.match(/^wcag\d+:(\d+\.\d+\.\d+)$/);
    if (wcagCriterionMatch) {
      title = `WCAG ${wcagCriterionMatch[1]}`;
    }

    if (requirement.id.startsWith("wcag-technique:")) {
      return [];
    }

    return [{
      id: requirement.id,
      title,
      forConformance: requirement.forConformance,
    }];
  });
}

export function mergeAccessibilityReferences(
  ...groups: AccessibilityReference[][]
): AccessibilityReference[] {
  const merged = new Map<string, AccessibilityReference>();

  for (const group of groups) {
    for (const reference of group) {
      const key = reference.title.trim().toLowerCase();
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, reference);
        continue;
      }

      if (reference.forConformance && !existing.forConformance) {
        merged.set(key, {
          ...existing,
          forConformance: true,
        });
      }
    }
  }

  return Array.from(merged.values());
}

function normalizeACTRule(rule: RawACTRule): ACTRule {
  return {
    actRuleId: rule.act_rule_id,
    title: rule.title,
    status: rule.status,
    ruleUrl: rule.rule_url,
    accessibilityRequirements: (rule.accessibility_requirements || []).map(
      (requirement) => ({
        id: requirement.id,
        title: requirement.title,
        forConformance: requirement.for_conformance,
        failed: requirement.failed,
        passed: requirement.passed,
        inapplicable: requirement.inapplicable,
      })
    ),
    summary: rule.summary,
    suggestedFixes: dedupeStrings(rule.suggested_fixes || []),
  };
}

export async function resolveAxeRuleContext(violationType: string): Promise<{
  accessibilityRequirements: AccessibilityReference[];
  successCriterion: string | null;
  ruleDescription: string | null;
}> {
  const axeRules = await loadAxeRules();
  const axeGuidance = await loadAxeGuidance();
  const axeRule = axeRules.find((rule) => rule.ruleId === violationType);
  const successCriterion =
    axeGuidance.rules[violationType]?.success_criterion?.trim() || null;

  return {
    accessibilityRequirements: resolveAxeAccessibilityRequirements(
      axeRule?.tags || []
    ),
    successCriterion,
    ruleDescription: axeRule?.description?.trim() || null,
  };
}

export async function resolveACTContext(violationType: string): Promise<{
  actRules: ACTRule[];
  suggestedFixes: string[];
}> {
  const catalog = await loadCatalog();
  const secondaryMapping = await loadAxeActMapping();
  const actRuleIDs = dedupeStrings([
    ...(catalog.axe_rule_to_act_rule_ids[violationType] || []),
    ...(secondaryMapping.procedure_to_act_rule_ids[violationType] || []),
  ]);

  const actRules = actRuleIDs
    .map((actRuleID) => catalog.act_rules[actRuleID])
    .filter(Boolean)
    .map(normalizeACTRule);

  return {
    actRules,
    suggestedFixes: dedupeStrings(
      actRules.flatMap((rule) => rule.suggestedFixes)
    ),
  };
}

export async function enrichIssueWithACT<
  TIssue extends {
    violationType: string;
  },
>(issue: TIssue): Promise<
  TIssue & {
    actRules: ACTRule[];
    suggestedFixes: string[];
    axeAccessibilityRequirements: AccessibilityReference[];
  }
> {
  const context = await resolveACTContext(issue.violationType);
  const axeContext = await resolveAxeRuleContext(issue.violationType);

  return {
    ...issue,
    actRules: context.actRules,
    suggestedFixes: context.suggestedFixes,
    axeAccessibilityRequirements: axeContext.accessibilityRequirements,
  };
}

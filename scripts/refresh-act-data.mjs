import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const axeSourcePath = path.join(
  repoRoot,
  "shopkeeper",
  "internal",
  "juicer",
  "axe.min.js"
);
const outputPath = path.join(repoRoot, "data", "act-rules.json");
const testcasesURL = "https://act-rules.github.io/testcases.json";
const officialRulesIndexURL =
  "https://www.w3.org/WAI/standards-guidelines/act/rules/";

const curatedFixes = {
  "09o5cg": [
    "Adjust the text and background colors until the reported text meets the minimum contrast ratio in every visible state.",
    "Re-test hover, focus, disabled, and placeholder states separately because color tokens often differ between states.",
  ],
  afw4f7: [
    "Increase contrast for all reported text, including smaller or lighter-weight variants that may fail before larger text does.",
    "Avoid depending on font weight or size changes alone when the base color combination is still below the required ratio.",
  ],
  "2ee8b8": [
    "Keep the accessible name aligned with the visible label so speech-input users can activate the control using the words they see on screen.",
    "When extra context is needed in the accessible name, keep the full visible label intact at the start of that name.",
  ],
  "97a4e1": [
    "Give each button an accessible name from visible text, `aria-label`, or `aria-labelledby`.",
    "Prefer visible button text when possible so both visual and assistive-technology users get the same control name.",
  ],
  e086e5: [
    "Associate each form control with a stable programmatic name using a `<label>`, `aria-label`, or `aria-labelledby`.",
    "Make sure the label describes the control's purpose, not only its current value or placeholder text.",
  ],
  "23a2a8": [
    "Provide a meaningful accessible name for informative images using `alt`, `aria-label`, or `aria-labelledby`.",
    "Keep decorative images out of the accessibility tree instead of giving them misleading alternative text.",
  ],
  "7d6734": [
    "Give SVG or graphics used as images an accessible name with visible text, `<title>`, `aria-label`, or `aria-labelledby`.",
    "If the graphic is purely decorative, remove it from the accessibility tree rather than leaving it unnamed.",
  ],
  cf77f2: [
    "Add a reliable skip mechanism or landmark path that lets keyboard users move past repeated content quickly.",
    "Ensure the bypass target becomes focusable and visible when the skip mechanism is activated.",
  ],
  bc659a: [
    "Remove viewport settings that prevent zoom, especially `user-scalable=no` and restrictive `maximum-scale` values.",
    "Verify the page still works when users zoom to at least 200% on mobile browsers.",
  ],
  bisz58: [
    "Avoid automatic redirects or refresh behavior that changes the page before users can read or interact with it.",
    "If refresh behavior is required, provide user control and enough time to complete the current task.",
  ],
  a25f45: [
    "Use `headers` only when it reflects real data-to-header relationships in complex tables.",
    "Prefer simpler semantic table structures with `th` and `scope` when they can express the same relationships clearly.",
  ],
  d0f69e: [
    "Use header cells only when the table actually contains related data cells that depend on those headers.",
    "Restructure layout tables into semantic content or a proper data table before adding more header markup.",
  ],
  "0ssw9k": [
    "Make scrollable regions keyboard reachable so users can move focus into the region before attempting to scroll it.",
    "Add focusability only where it preserves a predictable tab order and exposes meaningful context to assistive technology.",
  ],
  de46e4: [
    "Set a valid language code that matches the actual language of the page or element content.",
    "If both `lang` and `xml:lang` are present, keep them synchronized to avoid conflicting language metadata.",
  ],
};

function decodeHtmlEntities(input) {
  return input
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_, value) =>
      String.fromCodePoint(Number.parseInt(value, 16))
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function htmlToLines(html) {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  const spaced = withoutScripts
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|header|footer|aside|nav|li|ul|ol|pre|code|h1|h2|h3|h4|h5|h6|table|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(spaced)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractSection(lines, startHeading, endHeadings) {
  const startIndex = lines.indexOf(startHeading);
  if (startIndex === -1) {
    return [];
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (endHeadings.includes(lines[i])) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex + 1, endIndex);
}

function extractExampleText(lines, heading) {
  const startIndex = lines.indexOf(heading);
  if (startIndex === -1) {
    return "";
  }

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^(Passed|Failed|Inapplicable) Example \d+$/i.test(line)) {
      break;
    }
    if (
      line === "Open in a new tab" ||
      /^https?:\/\//.test(line) ||
      line.startsWith("<") ||
      line.startsWith("`")
    ) {
      continue;
    }
    if (line.length > 0) {
      return line;
    }
  }

  return "";
}

function normalizeSentence(text) {
  return text.replace(/\s+/g, " ").trim();
}

function buildKeywordFixes({ title, summary, expectation }) {
  const haystack = `${title} ${summary} ${expectation}`.toLowerCase();

  if (haystack.includes("accessible name")) {
    return [
      "Provide a non-empty accessible name using visible text, an associated label, `aria-label`, or `aria-labelledby`, depending on the control type.",
      "Keep the programmatic name aligned with what users see on screen when the control has a visible label.",
    ];
  }

  if (haystack.includes("contrast")) {
    return [
      "Adjust the foreground and background color combination until the reported content meets the required contrast ratio.",
      "Check the failing text in every visible state, including hover, focus, disabled, and placeholder variants.",
    ];
  }

  if (haystack.includes("zoom") || haystack.includes("viewport")) {
    return [
      "Remove restrictive viewport settings that block zoom or cap the usable scale too aggressively.",
      "Confirm the page remains usable when zoomed without forcing two-dimensional scrolling for the core content.",
    ];
  }

  if (
    haystack.includes("language code") ||
    haystack.includes("page language") ||
    haystack.includes("xml:lang") ||
    /\blang\b/.test(haystack)
  ) {
    return [
      "Set a valid language code that matches the actual language of the content being announced.",
      "Keep page-level and element-level language metadata consistent when both are present.",
    ];
  }

  if (
    haystack.includes("wai-aria") ||
    haystack.includes("aria state") ||
    haystack.includes("aria property")
  ) {
    return [
      "Use only ARIA states and properties that are supported by the element's semantic role or are globally allowed.",
      "If the required ARIA attribute is invalid for the current element, fix the role or remove the unsupported attribute rather than leaving conflicting semantics in place.",
    ];
  }

  if (haystack.includes("table") || haystack.includes("header")) {
    return [
      "Use semantic table markup that accurately matches the relationship between headers and data cells.",
      "Avoid adding header attributes unless the table structure truly requires them and the relationships are correct.",
    ];
  }

  if (
    haystack.includes("skip") ||
    haystack.includes("bypass") ||
    haystack.includes("repeated content")
  ) {
    return [
      "Add a working skip link or landmark path that lets keyboard users bypass repeated blocks of content.",
      "Ensure the bypass target can receive focus and lands at the start of the main destination content.",
    ];
  }

  if (
    haystack.includes("focus") ||
    haystack.includes("keyboard") ||
    haystack.includes("scrollable")
  ) {
    return [
      "Make sure users can reach the reported region or control using the keyboard without getting trapped or skipped.",
      "Apply focusability only where it preserves a predictable tab sequence and exposes meaningful context.",
    ];
  }

  if (haystack.includes("decorative")) {
    return [
      "Hide only genuinely decorative content from assistive technology; otherwise provide a meaningful accessible name or text alternative.",
      "Do not mark content as decorative when it conveys information, state, or a control purpose.",
    ];
  }

  return [];
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean).map((value) => value.trim()))];
}

function buildSuggestedFixes(rule) {
  const fixes = [];

  if (curatedFixes[rule.id]) {
    fixes.push(...curatedFixes[rule.id]);
  }

  fixes.push(...buildKeywordFixes(rule));

  if (rule.expectation) {
    fixes.push(`Meet the ACT expectation: ${rule.expectation}`);
  }

  if (rule.failedExampleSummary && rule.failedExampleSummary.length >= 24) {
    fixes.push(`Avoid failing patterns like: ${rule.failedExampleSummary}`);
  }

  if (rule.passedExampleSummary && rule.passedExampleSummary.length >= 24) {
    fixes.push(`Use the ACT passing pattern as a reference: ${rule.passedExampleSummary}`);
  }

  return dedupe(fixes);
}

function buildImplementationNotes(rule) {
  const notes = [];
  if (rule.passedExampleSummary && rule.passedExampleSummary.length >= 24) {
    notes.push(`Passing ACT example: ${rule.passedExampleSummary}`);
  }
  if (rule.failedExampleSummary && rule.failedExampleSummary.length >= 24) {
    notes.push(`Failing ACT example: ${rule.failedExampleSummary}`);
  }
  return notes;
}

function formatAccessibilityRequirementTitle(id) {
  if (id.startsWith("wcag-technique:")) {
    return `WCAG technique ${id.split(":")[1]}`;
  }

  if (id.startsWith("wcag")) {
    const [prefix, reference] = id.split(":");
    const version = prefix.replace(/^wcag(\d)(\d)$/, "WCAG $1.$2");
    return reference ? `${version} ${reference}` : version.toUpperCase();
  }

  if (id.startsWith("aria")) {
    const [prefix, reference] = id.split(":");
    const version = prefix.replace(/^aria(\d)(\d)$/, "ARIA $1.$2");
    return reference
      ? `${version} ${reference.replace(/_/g, " ")}`
      : version.toUpperCase();
  }

  return id;
}

function parseAccessibilityRequirements(requirementsObject, requirementLines) {
  const entries = Object.entries(requirementsObject || {});
  const titles = requirementLines.filter((line) => {
    return ![
      "Learn more about",
      "Required for conformance",
      "Not required for conformance",
      "Outcome mapping:",
      "Any `failed` outcomes:",
      "All `passed` outcomes:",
      "An `inapplicable` outcome:",
    ].some((prefix) => line.startsWith(prefix));
  });

  return entries.map(([id, value], index) => ({
    id,
    title: titles[index] || formatAccessibilityRequirementTitle(id),
    for_conformance: Boolean(value.forConformance),
    failed: value.failed || "",
    passed: value.passed || "",
    inapplicable: value.inapplicable || "",
  }));
}

function parseAxeMappings(source) {
  const mappings = {};
  const ruleRegex =
    /\{id:"([^"]+)",impact:"[^"]+"[\s\S]*?tags:\[[^\]]*\](?:,actIds:\[([^\]]*)\])?/g;

  for (const match of source.matchAll(ruleRegex)) {
    const ruleId = match[1];
    const rawActIds = match[2];
    if (!rawActIds) {
      continue;
    }

    const actIds = rawActIds
      .split(",")
      .map((value) => value.replace(/"/g, "").trim())
      .filter(Boolean);

    if (actIds.length > 0) {
      mappings[ruleId] = actIds;
    }
  }

  return mappings;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "lime-act-refresh-script",
      accept: "text/html,application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchTextIfExists(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "lime-act-refresh-script",
      accept: "text/html,application/json",
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  return response.text();
}

async function main() {
  const axeSource = await readFile(axeSourcePath, "utf8");
  const axeRuleToActRuleIds = parseAxeMappings(axeSource);
  const allActRuleIds = dedupe(Object.values(axeRuleToActRuleIds).flat());

  const testcasePayload = JSON.parse(await fetchText(testcasesURL));
  const testcaseRules = new Map();

  for (const testcase of testcasePayload.testcases ?? []) {
    if (!allActRuleIds.includes(testcase.ruleId) || testcaseRules.has(testcase.ruleId)) {
      continue;
    }

    testcaseRules.set(testcase.ruleId, {
      title: testcase.ruleName,
      rulePage: testcase.rulePage,
      accessibilityRequirements: testcase.ruleAccessibilityRequirements,
    });
  }

  const actRules = {};
  for (const actRuleId of allActRuleIds) {
    const testcaseRule = testcaseRules.get(actRuleId);
    if (!testcaseRule) {
      continue;
    }

    const approvedRuleURL = `${officialRulesIndexURL}${actRuleId}/`;
    const proposedRuleURL = `${officialRulesIndexURL}${actRuleId}/proposed/`;

    let ruleURL = approvedRuleURL;
    let status = "approved";
    let ruleHTML = await fetchTextIfExists(approvedRuleURL);

    if (!ruleHTML) {
      ruleURL = proposedRuleURL;
      status = "proposed";
      ruleHTML = await fetchTextIfExists(proposedRuleURL);
    }

    if (!ruleHTML) {
      ruleURL = testcaseRule.rulePage;
      status = ruleURL.includes("/proposed/") ? "proposed" : "approved";
      ruleHTML = await fetchText(ruleURL);
    }

    const lines = htmlToLines(ruleHTML);

    const descriptionLines = extractSection(lines, "Description", [
      "Applicability",
      "Expectation",
    ]);
    const expectationLines = extractSection(lines, "Expectation", [
      "Assumptions",
      "Accessibility Support",
      "Background",
      "Accessibility Requirements Mapping",
      "Input Aspects",
      "Glossary",
      "Rule Versions",
    ]);
    const requirementLines = extractSection(lines, "Accessibility Requirements Mapping", [
      "Input Aspects",
      "Examples",
      "Test Cases",
      "Glossary",
      "Rule Versions",
    ]);

    const summary =
      normalizeSentence(descriptionLines.join(" ")) || testcaseRule.title;
    const expectation = normalizeSentence(expectationLines.join(" "));
    const passedExampleSummary = extractExampleText(lines, "Passed Example 1");
    const failedExampleSummary = extractExampleText(lines, "Failed Example 1");

    const normalizedRule = {
      id: actRuleId,
      title: testcaseRule.title,
      status,
      rule_url: ruleURL,
      accessibility_requirements: parseAccessibilityRequirements(
        testcaseRule.accessibilityRequirements,
        requirementLines
      ),
      summary,
      expectation,
      passedExampleSummary,
      failedExampleSummary,
    };

    actRules[actRuleId] = {
      act_rule_id: normalizedRule.id,
      title: normalizedRule.title,
      status: normalizedRule.status,
      rule_url: normalizedRule.rule_url,
      accessibility_requirements: normalizedRule.accessibility_requirements,
      summary: normalizedRule.summary,
      suggested_fixes: buildSuggestedFixes(normalizedRule),
      implementation_notes: buildImplementationNotes(normalizedRule),
    };
  }

  const payload = {
    version: 1,
    generated_at: new Date().toISOString(),
    sources: {
      axe_core_version: "4.10.2",
      axe_mapping_source: "shopkeeper/internal/juicer/axe.min.js",
      act_testcases_json: testcasesURL,
      act_rule_pages: "https://www.w3.org/WAI/standards-guidelines/act/rules/",
    },
    axe_rule_to_act_rule_ids: axeRuleToActRuleIds,
    act_rules: actRules,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(
    `Wrote ${Object.keys(actRules).length} ACT rule entries and ${Object.keys(
      axeRuleToActRuleIds
    ).length} axe mappings to ${outputPath}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

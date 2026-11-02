import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // These existing components hydrate browser preferences or synchronize
  // issue-card state in effects. Keep their behavior while adopting the newer
  // Next lint preset; new files still receive this rule.
  {
    files: [
      "src/components/dashboard-settings-form.tsx",
      "src/components/issue-details-feed.tsx",
      "src/components/issue-false-positive-button.tsx",
      "src/components/update-notice.tsx",
      "src/hooks/use-mobile.ts",
    ],
    rules: { "react-hooks/set-state-in-effect": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;

package repository

import "testing"

func TestPDFReportPolicyUsesSavedSettingsSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	policy, err := r.GetPDFReportPolicy(ctx)
	if err != nil || policy == nil || !policy.Enabled || policy.Concurrency != 1 {
		t.Fatalf("default PDF policy: %+v, %v", policy, err)
	}

	execMCPFixture(t, r, ctx,
		`UPDATE app_settings SET pdf_reports_enabled = false, report_generation_concurrency = 3 WHERE key = 'global'`)
	policy, err = r.GetPDFReportPolicy(ctx)
	if err != nil || policy == nil || policy.Enabled || policy.Concurrency != 3 {
		t.Fatalf("updated PDF policy: %+v, %v", policy, err)
	}
}

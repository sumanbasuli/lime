package repository

import (
	"testing"
)

func TestScreenshotVisibleRequiresCompletedURLAndEvidence(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	const scanID = "11111111-1111-4111-8111-111111111111"
	const otherScanID = "99999999-9999-4999-8999-999999999999"
	const urlID = "22222222-2222-4222-8222-222222222222"
	const issueID = "33333333-3333-4333-8333-333333333333"
	const full = urlID + ".png"
	const issueFocus = urlID + "_focus_0.png"
	const auditFocus = urlID + "_focus_1.png"
	const issuePreview = urlID + "_focus_0_preview.png"
	const auditPreview = urlID + "_focus_1_preview.png"
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status) VALUES
		($1,'https://fixture.test/sitemap.xml','scanning'),
		($2,'https://other.test/sitemap.xml','completed')`, scanID, otherScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO urls(id,scan_id,url,status) VALUES
		($1,$2,'https://fixture.test/page','pending')`, urlID, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,severity) VALUES
		($1,$2,'rule','Rule','serious')`, issueID, scanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences(issue_id,url_id,screenshot_path,element_screenshot_path)
		VALUES($1,$2,$3,$4)`, issueID, urlID, "/app/screenshots/"+scanID+"/"+full, "/app/screenshots/"+scanID+"/"+issueFocus)
	execMCPFixture(t, r, ctx, `INSERT INTO url_audit_occurrences(url_id,rule_id,outcome,element_screenshot_path)
		VALUES($1,'audit','incomplete',$2)`, urlID, "/app/screenshots/"+scanID+"/"+auditFocus)
	check := func(scan, file string, want bool) {
		t.Helper()
		got, err := r.ScreenshotVisible(ctx, scan, file)
		if err != nil || got != want {
			t.Fatalf("ScreenshotVisible(%q, %q) = %v, %v; want %v", scan, file, got, err, want)
		}
	}
	for _, file := range []string{full, issueFocus, auditFocus, issuePreview, auditPreview} {
		check(scanID, file, false)
	}
	execMCPFixture(t, r, ctx, `UPDATE urls SET status='completed' WHERE id=$1`, urlID)
	for _, file := range []string{full, issueFocus, auditFocus, issuePreview, auditPreview} {
		check(scanID, file, true)
		check(otherScanID, file, false)
	}
	check(scanID, urlID+"_focus_2.png", false)
	check(scanID, urlID+"_focus_2_preview.png", false)
	check(scanID, urlID+"_focus_0_preview_preview.png", false)
	check(scanID, urlID+"_preview.png", false)
	check(scanID, "unrelated.png", false)
	execMCPFixture(t, r, ctx, `UPDATE issue_occurrences SET element_screenshot_path=$1 WHERE url_id=$2`, "/app/screenshots/"+otherScanID+"/"+issueFocus, urlID)
	check(scanID, issuePreview, false) // A matching filename in another scan is insufficient.
	execMCPFixture(t, r, ctx, `UPDATE issue_occurrences SET element_screenshot_path=$1 WHERE url_id=$2`, "/app/screenshots/"+scanID+"/"+issueFocus, urlID)
	check(scanID, issuePreview, true)
	execMCPFixture(t, r, ctx, `UPDATE issue_occurrences SET element_screenshot_path=$1 WHERE url_id=$2`, "/app/screenshots/"+scanID+"/"+issuePreview, urlID)
	check(scanID, issuePreview, false) // A persisted preview cannot authorize itself.
	execMCPFixture(t, r, ctx, `DELETE FROM issue_occurrences WHERE url_id=$1`, urlID)
	execMCPFixture(t, r, ctx, `DELETE FROM url_audit_occurrences WHERE url_id=$1`, urlID)
	check(scanID, full, true) // A clean page still has a valid full-page image.
	check(scanID, issueFocus, false)
	check(scanID, auditFocus, false)
	check(scanID, issuePreview, false)
	check(scanID, auditPreview, false)
}

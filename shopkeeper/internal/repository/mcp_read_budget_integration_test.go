package repository

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const mcpBudgetIssueID = "33333333-3333-4333-8333-333333333333"
const mcpBudgetJobID = "66666666-6666-4666-8666-666666666666"
const mcpBudgetResultID = "77777777-7777-4777-8777-777777777777"

func mcpReadBudgetFixture(t *testing.T, r *Repository, ctx context.Context) {
	t.Helper()
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status,created_at)
		VALUES($1,'https://fixture.test/scan','completed','2026-01-01')`, mcpScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO urls(id,scan_id,url,status)
		VALUES($1,$2,'https://fixture.test/page','completed')`, mcpURLID, mcpScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,help_url,severity)
		VALUES($1,$2,'image-alt','Missing alt','https://fixture.test/help','serious')`, mcpBudgetIssueID, mcpScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences(issue_id,url_id,html_snippet,css_selector,created_at)
		VALUES($1,$2,'<img>','#image','2026-01-01')`, mcpBudgetIssueID, mcpURLID)
	execMCPFixture(t, r, ctx, `INSERT INTO url_audit_occurrences(url_id,rule_id,outcome,html_snippet,css_selector,created_at)
		VALUES($1,'review-rule','incomplete','<a>','#link','2026-01-01')`, mcpURLID)
	execMCPFixture(t, r, ctx, `INSERT INTO link_checks(id,scan_id,url,check_type,status,seed_urls,created_at)
		VALUES($1,$2,'https://fixture.test/links','scan','completed','["https://fixture.test/seed"]','2026-01-01')`, mcpBudgetJobID, mcpScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO link_check_results(id,link_check_id,target_url,status,link_type,occurrence_count,sources)
		VALUES($1,$2,'https://fixture.test/target','broken','external',1,
		'[{"page_url":"https://fixture.test/page","element":"a","attribute":"href","text":"Example"}]')`, mcpBudgetResultID, mcpBudgetJobID)
}

func withMCPBudgetRead(t *testing.T, r *Repository, ctx context.Context, read func(context.Context) error) error {
	t.Helper()
	readCtx, finish, err := r.BeginMCPRead(ctx)
	defer finish()
	if err != nil {
		t.Fatal(err)
	}
	return read(readCtx)
}

func requireMCPReadTooLarge(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, ErrMCPReadTooLarge) {
		t.Fatalf("selected oversized data must fail with ErrMCPReadTooLarge: %v", err)
	}
}

func TestMCPScanTextReadBudgetSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	for _, column := range []string{"sitemap_url", "viewport_preset"} {
		t.Run(column, func(t *testing.T) {
			execMCPFixture(t, r, ctx, `UPDATE scans SET `+column+`=repeat('x',6*1024*1024) WHERE id=$1`, mcpScanID)
			if scan, err := r.GetScan(ctx, mcpScanID); err != nil || scan == nil {
				t.Fatalf("ordinary scan read changed: present=%v err=%v", scan != nil, err)
			}
			requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
				_, err := r.GetScan(readCtx, mcpScanID)
				return err
			}))
			_, err := r.ListMCPScans(ctx, 1, 0)
			requireMCPReadTooLarge(t, err)
			execMCPFixture(t, r, ctx, `UPDATE scans SET sitemap_url='https://fixture.test/scan',scan_type='sitemap',tag=NULL,viewport_preset='desktop' WHERE id=$1`, mcpScanID)
		})
	}
	// The old oversized row is outside the requested page, including its total.
	execMCPFixture(t, r, ctx, `UPDATE scans SET sitemap_url=repeat('x',6*1024*1024) WHERE id=$1`, mcpScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status,created_at)
		VALUES($1,'https://fixture.test/small','completed','2026-01-02')`, mcpOtherScanID)
	page, err := r.ListMCPScans(ctx, 1, 0)
	if err != nil || len(page) != 1 || page[0].ID != mcpOtherScanID {
		t.Fatalf("unselected scan poisoned the small page: rows=%d err=%v", len(page), err)
	}
	_, err = r.ListMCPScans(ctx, 1, 1)
	requireMCPReadTooLarge(t, err)
}

func TestMCPIndexedScanTextReadBudgetSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status)
		SELECT md5('budget-scan-' || n)::uuid,'https://fixture.test/scan','completed'
		FROM generate_series(1,99) n`)
	// Keep all real indexes: one compressed indexed value fits, while the
	// selected aggregate of 100 such values exceeds the response budget.
	for _, column := range []string{"tag", "scan_type"} {
		t.Run(column, func(t *testing.T) {
			execMCPFixture(t, r, ctx, `UPDATE scans SET `+column+`=repeat('x',64*1024)`)
			if err := withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
				scan, err := r.GetScan(readCtx, mcpScanID)
				if err == nil && scan == nil {
					t.Fatal("selected indexed scan disappeared")
				}
				return err
			}); err != nil {
				t.Fatalf("single indexed scan should fit: %v", err)
			}
			page, err := r.ListMCPScans(ctx, 1, 0)
			if err != nil || len(page) != 1 {
				t.Fatalf("single indexed scan page should fit: rows=%d err=%v", len(page), err)
			}
			_, err = r.ListMCPScans(ctx, 100, 0)
			requireMCPReadTooLarge(t, err)
			execMCPFixture(t, r, ctx, `UPDATE scans SET tag=NULL,scan_type='sitemap'`)
		})
	}
}

func TestMCPLinkCheckTextReadBudgetSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	for _, field := range []struct{ name, assignment string }{
		{"url", `url=repeat('x',6*1024*1024)`},
		{"error", `error=repeat('x',6*1024*1024)`},
		{"summary", `summary=jsonb_build_object('healthy',1,'padding',repeat('x',6*1024*1024))`},
	} {
		t.Run(field.name, func(t *testing.T) {
			execMCPFixture(t, r, ctx, `UPDATE link_checks SET `+field.assignment+` WHERE id=$1`, mcpBudgetJobID)
			if job, err := r.GetLinkCheck(ctx, mcpBudgetJobID); err != nil || job == nil {
				t.Fatalf("ordinary link check read changed: present=%v err=%v", job != nil, err)
			}
			for _, read := range []struct {
				name string
				read func(context.Context) error
			}{
				{"get", func(ctx context.Context) error { _, err := r.GetLinkCheck(ctx, mcpBudgetJobID); return err }},
				{"scan companion", func(ctx context.Context) error { _, err := r.GetScanLinkCheck(ctx, mcpScanID); return err }},
				{"list", func(ctx context.Context) error { _, _, err := r.ListLinkChecks(ctx, 1, 0); return err }},
			} {
				t.Run(read.name, func(t *testing.T) {
					requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, read.read))
				})
			}
			execMCPFixture(t, r, ctx, `UPDATE link_checks SET url='https://fixture.test/links',error=NULL,summary='{}' WHERE id=$1`, mcpBudgetJobID)
		})
	}
	execMCPFixture(t, r, ctx, `UPDATE link_checks SET error=repeat('x',6*1024*1024) WHERE id=$1`, mcpBudgetJobID)
	execMCPFixture(t, r, ctx, `INSERT INTO link_checks(id,url,check_type,status,created_at)
		VALUES($1,'https://fixture.test/small','single','completed','2026-01-02')`, mcpOtherScanID)
	if err := withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		page, total, err := r.ListLinkChecks(readCtx, 1, 0)
		if err == nil && (total != 2 || len(page) != 1 || page[0].ID != mcpOtherScanID) {
			t.Fatalf("selected small link check page: total=%d rows=%d", total, len(page))
		}
		return err
	}); err != nil {
		t.Fatalf("unselected link check poisoned the page: %v", err)
	}
}

func TestMCPIssueSummaryTextReadBudgetSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	for _, column := range []string{"description", "help_url"} {
		t.Run(column, func(t *testing.T) {
			execMCPFixture(t, r, ctx, `UPDATE issues SET `+column+`=repeat('x',6*1024*1024) WHERE id=$1`, mcpBudgetIssueID)
			_, _, err := r.GetMCPIssueSummaries(ctx, mcpScanID, 1, 0)
			requireMCPReadTooLarge(t, err)
			_, err = r.GetMCPIssueDetail(ctx, mcpScanID, "failed", mcpBudgetIssueID, 1, 0)
			requireMCPReadTooLarge(t, err)
			execMCPFixture(t, r, ctx, `UPDATE issues SET description='Missing alt',help_url='https://fixture.test/help',violation_type='image-alt' WHERE id=$1`, mcpBudgetIssueID)
		})
	}
	t.Run("violation_type", func(t *testing.T) {
		// The real rule-ID index admits these compressed individual values.
		execMCPFixture(t, r, ctx, `UPDATE issues SET violation_type=repeat('r',64*1024) WHERE id=$1`, mcpBudgetIssueID)
		page, total, err := r.GetMCPIssueSummaries(ctx, mcpScanID, 1, 0)
		if err != nil || total != 2 || len(page) != 1 || len(page[0].RuleID) != 64*1024 {
			t.Fatalf("single indexed rule summary should fit: total=%d rows=%d err=%v", total, len(page), err)
		}
		detail, err := r.GetMCPIssueDetail(ctx, mcpScanID, "failed", mcpBudgetIssueID, 1, 0)
		if err != nil || detail == nil || len(detail.Summary.RuleID) != 64*1024 {
			t.Fatalf("single indexed rule detail should fit: present=%v err=%v", detail != nil, err)
		}
		execMCPFixture(t, r, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,severity)
			SELECT md5('budget-rule-' || n)::uuid,$1,n::text || repeat('r',64*1024),'Indexed rule','serious'
			FROM generate_series(1,99) n`, mcpScanID)
		_, _, err = r.GetMCPIssueSummaries(ctx, mcpScanID, 100, 0)
		requireMCPReadTooLarge(t, err)
		execMCPFixture(t, r, ctx, `DELETE FROM issues WHERE scan_id=$1 AND id<>$2`, mcpScanID, mcpBudgetIssueID)
		execMCPFixture(t, r, ctx, `UPDATE issues SET violation_type='image-alt' WHERE id=$1`, mcpBudgetIssueID)
	})
	execMCPFixture(t, r, ctx, `UPDATE issues SET help_url=repeat('x',6*1024*1024) WHERE id=$1`, mcpBudgetIssueID)
	execMCPFixture(t, r, ctx, `INSERT INTO issues(id,scan_id,violation_type,description,severity)
		VALUES($1,$2,'small-rule','Small group','minor')`, mcpOtherScanID, mcpScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences(issue_id,url_id)
		SELECT $1,$2 FROM generate_series(1,2)`, mcpOtherScanID, mcpURLID)
	page, total, err := r.GetMCPIssueSummaries(ctx, mcpScanID, 1, 0)
	if err != nil || total != 3 || len(page) != 1 || page[0].Key != mcpOtherScanID {
		t.Fatalf("unselected issue summary poisoned the page: total=%d rows=%d err=%v", total, len(page), err)
	}
	_, _, err = r.GetMCPIssueSummaries(ctx, mcpScanID, 1, 1)
	requireMCPReadTooLarge(t, err)
	// Indexed rule IDs cannot hold a single 6 MiB value. The real schema admits
	// many smaller compressed values whose repeated key/rule/title exceed budget.
	execMCPFixture(t, r, ctx, `DELETE FROM issues WHERE scan_id=$1`, mcpScanID)
	execMCPFixture(t, r, ctx, `DELETE FROM url_audit_occurrences WHERE url_id=$1`, mcpURLID)
	execMCPFixture(t, r, ctx, `INSERT INTO url_audit_occurrences(url_id,rule_id,outcome)
		SELECT $1,n::text || repeat('r',64*1024),'incomplete' FROM generate_series(1,100) n`, mcpURLID)
	_, _, err = r.GetMCPIssueSummaries(ctx, mcpScanID, 100, 0)
	requireMCPReadTooLarge(t, err)
}

func TestMCPOccurrenceTextReadBudgetSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	for _, kind := range []string{"failed", "needs_review"} {
		t.Run(kind, func(t *testing.T) {
			table, key := "issue_occurrences", mcpBudgetIssueID
			if kind == "needs_review" {
				table, key = "url_audit_occurrences", "review-rule"
			}
			for _, column := range []string{"html_snippet", "screenshot_path", "element_screenshot_path", "css_selector"} {
				t.Run(column, func(t *testing.T) {
					execMCPFixture(t, r, ctx, `UPDATE `+table+` SET `+column+`=repeat('x',6*1024*1024)`)
					_, err := r.GetMCPIssueDetail(ctx, mcpScanID, kind, key, 1, 0)
					requireMCPReadTooLarge(t, err)
					execMCPFixture(t, r, ctx, `UPDATE urls SET url='https://fixture.test/page' WHERE id=$1`, mcpURLID)
					execMCPFixture(t, r, ctx, `UPDATE `+table+` SET html_snippet='<small>',screenshot_path=NULL,element_screenshot_path=NULL,css_selector='#small'`)
				})
			}
			execMCPFixture(t, r, ctx, `UPDATE `+table+` SET html_snippet=repeat('x',6*1024*1024)`)
			if kind == "failed" {
				execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences(issue_id,url_id,html_snippet,created_at)
					VALUES($1,$2,'<small>','2000-01-01')`, mcpBudgetIssueID, mcpURLID)
			} else {
				execMCPFixture(t, r, ctx, `INSERT INTO url_audit_occurrences(url_id,rule_id,outcome,html_snippet,created_at)
					VALUES($1,'review-rule','incomplete','<small>','2000-01-01')`, mcpURLID)
			}
			detail, err := r.GetMCPIssueDetail(ctx, mcpScanID, kind, key, 1, 0)
			if err != nil || detail == nil || len(detail.Occurrences) != 1 || detail.Occurrences[0].HTMLSnippet == nil || *detail.Occurrences[0].HTMLSnippet != "<small>" || !detail.HasMore {
				t.Fatalf("unselected evidence poisoned the page: present=%v err=%v", detail != nil, err)
			}
			_, err = r.GetMCPIssueDetail(ctx, mcpScanID, kind, key, 1, 1)
			requireMCPReadTooLarge(t, err)
		})
	}
}

func TestMCPOccurrencePageURLReadBudgetSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	// URLs have a real (scan_id,url) index, so exercise the URL family using
	// an admissible indexed value repeated across the selected occurrence page.
	execMCPFixture(t, r, ctx, `UPDATE urls SET url='1' || repeat('u',64*1024) WHERE id=$1`, mcpURLID)
	execMCPFixture(t, r, ctx, `INSERT INTO urls(id,scan_id,url,status)
		SELECT md5('budget-url-' || n)::uuid,$1,n::text || repeat('u',64*1024),'completed'
		FROM generate_series(2,100) n`, mcpScanID)
	execMCPFixture(t, r, ctx, `DELETE FROM issue_occurrences`)
	execMCPFixture(t, r, ctx, `DELETE FROM url_audit_occurrences`)
	execMCPFixture(t, r, ctx, `INSERT INTO issue_occurrences(issue_id,url_id,html_snippet)
		SELECT $1,id,'<img>' FROM urls WHERE scan_id=$2`, mcpBudgetIssueID, mcpScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO url_audit_occurrences(url_id,rule_id,outcome,html_snippet)
		SELECT id,'review-rule','incomplete','<a>' FROM urls WHERE scan_id=$1`, mcpScanID)
	for _, kind := range []string{"failed", "needs_review"} {
		t.Run(kind, func(t *testing.T) {
			key := mcpBudgetIssueID
			if kind == "needs_review" {
				key = "review-rule"
			}
			detail, err := r.GetMCPIssueDetail(ctx, mcpScanID, kind, key, 1, 0)
			if err != nil || detail == nil || len(detail.Occurrences) != 1 || len(detail.Occurrences[0].PageURL) < 64*1024 {
				t.Fatalf("single indexed page URL should fit: present=%v err=%v", detail != nil, err)
			}
			_, err = r.GetMCPIssueDetail(ctx, mcpScanID, kind, key, 100, 0)
			requireMCPReadTooLarge(t, err)
		})
	}
}

func TestMCPVisibleSettingsAndAuthTextBudgetSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	execMCPFixture(t, r, ctx, `UPDATE app_settings SET mcp_enabled=TRUE,mcp_allow_writes=TRUE,
		mcp_key_hash=repeat('a',64),mcp_key_hint='test-hint' WHERE key='global'`)
	settings, err := r.GetMCPVisibleSettings(ctx)
	if err != nil || settings == nil || settings.Integrations["mcp_key_hint"] != "test-hint" || settings.Integrations["mcp_mode"] != "read_write" {
		t.Fatalf("ordinary visible settings changed: present=%v err=%v", settings != nil, err)
	}
	auth, err := r.GetMCPAuthSettings(ctx)
	if err != nil || auth == nil || auth.KeyHash == nil || *auth.KeyHash != strings.Repeat("a", 64) {
		t.Fatalf("valid 64-byte auth digest changed: present=%v err=%v", auth != nil, err)
	}
	execMCPFixture(t, r, ctx, `UPDATE app_settings SET mcp_key_hint=repeat('x',6*1024*1024) WHERE key='global'`)
	_, err = r.GetMCPVisibleSettings(ctx)
	requireMCPReadTooLarge(t, err)
	execMCPFixture(t, r, ctx, `UPDATE app_settings SET mcp_key_hint='test-hint',mcp_key_hash=repeat('x',6*1024*1024) WHERE key='global'`)
	auth, err = r.GetMCPAuthSettings(ctx)
	if err != nil || auth == nil || !auth.Enabled || auth.KeyHash != nil {
		t.Fatalf("oversized auth digest must project to NULL and fail closed: present=%v err=%v", auth != nil, err)
	}
	for _, size := range []int{0, 63, 65} {
		execMCPFixture(t, r, ctx, `UPDATE app_settings SET mcp_key_hash=repeat('a',$1) WHERE key='global'`, size)
		auth, err := r.GetMCPAuthSettings(ctx)
		if err != nil || auth == nil || auth.KeyHash != nil {
			t.Fatalf("%d-byte auth digest was admitted: present=%v err=%v", size, auth != nil, err)
		}
	}
}

func TestMCPMetadataReadsSkipUnusedTextSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	execMCPFixture(t, r, ctx, `UPDATE scans SET sitemap_url=repeat('x',6*1024*1024),
		tag=repeat('t',64*1024),include_link_check=TRUE WHERE id=$1`, mcpScanID)
	execMCPFixture(t, r, ctx, `UPDATE app_settings SET mcp_key_hint=repeat('x',6*1024*1024),
		pdf_reports_enabled=TRUE,csv_reports_enabled=FALSE,llm_reports_enabled=TRUE WHERE key='global'`)
	requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		_, err := r.GetScan(readCtx, mcpScanID)
		return err
	}))
	_, err := r.GetMCPVisibleSettings(ctx)
	requireMCPReadTooLarge(t, err)
	if err := withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		scan, err := r.GetMCPScanReference(readCtx, mcpScanID)
		if err != nil {
			return err
		}
		if scan == nil || scan.ID != mcpScanID || !scan.IncludeLinkCheck || scan.SitemapURL != "" || scan.Tag != nil {
			t.Fatal("scan metadata lookup materialized unused scan text or lost its reference")
		}
		settings, err := r.GetMCPReportSettings(readCtx)
		if err == nil && (settings == nil || !reflect.DeepEqual(settings.Reporting, map[string]any{
			"pdf_reports_enabled": true, "csv_reports_enabled": false, "llm_reports_enabled": true,
		})) {
			t.Fatal("report metadata lookup changed report flags")
		}
		return err
	}); err != nil {
		t.Fatalf("unused oversized text poisoned metadata reads: %v", err)
	}
}

func TestMCPLinkResultAndSourceTextReadBudgetSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	for _, column := range []string{"final_url", "error", "error_kind"} {
		t.Run(column, func(t *testing.T) {
			execMCPFixture(t, r, ctx, `UPDATE link_check_results SET `+column+`=repeat('x',6*1024*1024) WHERE id=$1`, mcpBudgetResultID)
			requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
				_, _, err := r.GetLinkResults(readCtx, mcpBudgetJobID, "", 1, 0)
				return err
			}))
			execMCPFixture(t, r, ctx, `UPDATE link_check_results SET final_url=NULL,error=NULL,error_kind=NULL WHERE id=$1`, mcpBudgetResultID)
		})
	}
	for _, field := range []string{"page_url", "element", "attribute", "text"} {
		t.Run("source "+field, func(t *testing.T) {
			execMCPFixture(t, r, ctx, `UPDATE link_check_results SET sources=jsonb_build_array(
				jsonb_build_object($2::text,repeat('x',6*1024*1024))) WHERE id=$1`, mcpBudgetResultID, field)
			requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
				_, _, err := r.GetLinkResults(readCtx, mcpBudgetJobID, "", 1, 0)
				return err
			}))
			requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
				_, _, _, err := r.GetLinkSources(readCtx, mcpBudgetJobID, mcpBudgetResultID, 1, 0)
				return err
			}))
		})
	}
	// Both preview and source admission must measure the selected JSONB slice,
	// rather than rejecting a large reference retained after that slice.
	execMCPFixture(t, r, ctx, `UPDATE link_check_results SET occurrence_count=7,sources=(
		SELECT jsonb_agg(jsonb_build_object('page_url','https://fixture.test/' || n,'element','a',
		'attribute','href','text',CASE WHEN n=7 THEN repeat('x',6*1024*1024) ELSE 'Small' END) ORDER BY n)
		FROM generate_series(1,7) n) WHERE id=$1`, mcpBudgetResultID)
	ordinary, ordinaryTotal, err := r.GetLinkResults(ctx, mcpBudgetJobID, "", 1, 0)
	if err != nil || len(ordinary) != 1 || len(ordinary[0].Sources) != 5 || ordinaryTotal != 1 {
		t.Fatalf("ordinary source preview changed: rows=%d total=%d err=%v", len(ordinary), ordinaryTotal, err)
	}
	if err := withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		page, total, err := r.GetLinkResults(readCtx, mcpBudgetJobID, "", 1, 0)
		if err == nil && (total != ordinaryTotal || !reflect.DeepEqual(page, ordinary)) {
			t.Fatal("MCP source preview changed the ordinary result")
		}
		return err
	}); err != nil {
		t.Fatalf("unselected source poisoned preview: %v", err)
	}
	if err := withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		page, total, found, err := r.GetLinkSources(readCtx, mcpBudgetJobID, mcpBudgetResultID, 1, 5)
		if err == nil && (!found || total != 7 || len(page) != 1 || page[0].Text != "Small") {
			t.Fatalf("selected source slice: found=%v total=%d rows=%d", found, total, len(page))
		}
		return err
	}); err != nil {
		t.Fatalf("unselected source poisoned source page: %v", err)
	}
	requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		_, _, _, err := r.GetLinkSources(readCtx, mcpBudgetJobID, mcpBudgetResultID, 1, 6)
		return err
	}))
	// A large filtered or later result must not affect the selected small page.
	execMCPFixture(t, r, ctx, `UPDATE link_check_results SET sources='[]',error=repeat('x',6*1024*1024) WHERE id=$1`, mcpBudgetResultID)
	execMCPFixture(t, r, ctx, `INSERT INTO link_check_results(id,link_check_id,target_url,status,link_type)
		VALUES($1,$2,'https://fixture.test/first','broken','external')`, mcpOtherScanID, mcpBudgetJobID)
	if err := withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		page, total, err := r.GetLinkResults(readCtx, mcpBudgetJobID, "", 1, 0)
		if err == nil && (total != 2 || len(page) != 1 || page[0].ID != mcpOtherScanID) {
			t.Fatalf("selected result page: total=%d rows=%d", total, len(page))
		}
		return err
	}); err != nil {
		t.Fatalf("unselected result poisoned result page: %v", err)
	}
	execMCPFixture(t, r, ctx, `UPDATE link_check_results SET status='healthy' WHERE id=$1`, mcpBudgetResultID)
	if err := withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		_, _, err := r.GetLinkResults(readCtx, mcpBudgetJobID, "broken", 100, 0)
		return err
	}); err != nil {
		t.Fatalf("filtered result poisoned result page: %v", err)
	}
	// Keep the real unique target-URL index while testing aggregate URL cost.
	execMCPFixture(t, r, ctx, `DELETE FROM link_check_results WHERE link_check_id=$1`, mcpBudgetJobID)
	execMCPFixture(t, r, ctx, `INSERT INTO link_check_results(link_check_id,target_url,status,link_type)
		SELECT $1,n::text || repeat('x',64*1024),'broken','external' FROM generate_series(1,100) n`, mcpBudgetJobID)
	requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		_, _, err := r.GetLinkResults(readCtx, mcpBudgetJobID, "", 100, 0)
		return err
	}))
}

func TestMCPHiddenLinkSeedsStayOutsideReadProjectionSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	for _, seeds := range []struct{ name, expression string }{
		{"malformed seed type", `'{"unexpected":"object"}'::jsonb`},
		{"large hidden seed", `jsonb_build_array(repeat('x',6*1024*1024))`},
	} {
		t.Run(seeds.name, func(t *testing.T) {
			execMCPFixture(t, r, ctx, `UPDATE link_checks SET seed_urls=`+seeds.expression+` WHERE id=$1`, mcpBudgetJobID)
			for _, read := range []struct {
				name string
				read func(context.Context) error
			}{
				{"get", func(ctx context.Context) error {
					job, err := r.GetLinkCheck(ctx, mcpBudgetJobID)
					if err == nil && (job == nil || len(job.SeedURLs) != 0) {
						t.Fatal("MCP get materialized hidden seeds")
					}
					return err
				}},
				{"scan companion", func(ctx context.Context) error {
					job, err := r.GetScanLinkCheck(ctx, mcpScanID)
					if err == nil && (job == nil || len(job.SeedURLs) != 0) {
						t.Fatal("MCP companion materialized hidden seeds")
					}
					return err
				}},
				{"list", func(ctx context.Context) error {
					page, total, err := r.ListLinkChecks(ctx, 1, 0)
					if err == nil && (total != 1 || len(page) != 1 || len(page[0].SeedURLs) != 0) {
						t.Fatal("MCP list materialized hidden seeds")
					}
					return err
				}},
			} {
				t.Run(read.name, func(t *testing.T) {
					if err := withMCPBudgetRead(t, r, ctx, read.read); err != nil {
						t.Fatalf("hidden seeds affected MCP read: %v", err)
					}
				})
			}
			ordinary, err := r.GetLinkCheck(ctx, mcpBudgetJobID)
			if seeds.name == "malformed seed type" {
				if err == nil {
					t.Fatal("ordinary decoder no longer rejects malformed seed types")
				}
			} else if err != nil || ordinary == nil || len(ordinary.SeedURLs) != 1 || len(ordinary.SeedURLs[0]) != 6*1024*1024 {
				t.Fatalf("ordinary worker read lost hidden seeds: present=%v err=%v", ordinary != nil, err)
			}
		})
	}
	execMCPFixture(t, r, ctx, `UPDATE link_checks SET seed_urls='["https://fixture.test/one","https://fixture.test/two"]' WHERE id=$1`, mcpBudgetJobID)
	ordinary, err := r.GetLinkCheck(ctx, mcpBudgetJobID)
	if err != nil || ordinary == nil {
		t.Fatal(err)
	}
	if err := withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		job, err := r.GetLinkCheck(readCtx, mcpBudgetJobID)
		if err != nil {
			return err
		}
		before, beforeErr := json.Marshal(ordinary)
		after, afterErr := json.Marshal(job)
		if beforeErr != nil || afterErr != nil || string(before) != string(after) {
			t.Fatal("omitting hidden seeds changed link check wire output")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	recheck, err := r.CreateLinkCheckFrom(ctx, mcpBudgetJobID)
	if err != nil || recheck == nil || !reflect.DeepEqual(recheck.SeedURLs, ordinary.SeedURLs) {
		t.Fatalf("ordinary recheck lost source seeds: present=%v err=%v", recheck != nil, err)
	}
}

func TestMCPReadBudgetAccumulatesPrerequisitesSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	execMCPFixture(t, r, ctx, `UPDATE scans SET sitemap_url=repeat('x',1024*1024) WHERE id=$1`, mcpScanID)
	execMCPFixture(t, r, ctx, `UPDATE link_checks SET error=repeat('x',1536*1024) WHERE id=$1`, mcpBudgetJobID)
	for _, read := range []func(context.Context) error{
		func(ctx context.Context) error { _, err := r.GetScan(ctx, mcpScanID); return err },
		func(ctx context.Context) error { _, err := r.GetLinkCheck(ctx, mcpBudgetJobID); return err },
	} {
		if err := withMCPBudgetRead(t, r, ctx, read); err != nil {
			t.Fatalf("individual selected prerequisite should fit: %v", err)
		}
	}
	requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		if _, err := r.GetScan(readCtx, mcpScanID); err != nil {
			t.Fatalf("first prerequisite should fit: %v", err)
		}
		// Re-entering a native MCP read must retain the existing request budget.
		nestedCtx, nestedFinish, err := r.BeginMCPRead(readCtx)
		defer nestedFinish()
		if err != nil {
			return err
		}
		_, err = r.GetLinkCheck(nestedCtx, mcpBudgetJobID)
		return err
	}))
	if err := r.pool.Ping(ctx); err != nil {
		t.Fatalf("budget rejection leaked or damaged its connection: %v", err)
	}
}

func TestMCPReadSnapshotAndReadOnlyTransactionSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	execMCPFixture(t, r, ctx, `INSERT INTO scan_score_summary_cache (
		scan_id,scan_updated_at,scan_status,score,has_score,has_audit_data,
		completed_url_count,failed_url_count,total_url_count,has_full_coverage,is_partial_scan,
		passed_count,failed_count,not_applicable_count,needs_review_count,excluded_count,
		weighted_passed,weighted_failed,weighted_total,scored_audit_count)
		SELECT id,updated_at,status,85,TRUE,TRUE,1,0,1,TRUE,FALSE,85,15,0,0,0,85,15,100,100
		FROM scans WHERE id=$1`, mcpScanID)
	readCtx, finish, err := r.BeginMCPRead(ctx)
	if err != nil {
		finish()
		t.Fatal(err)
	}
	defer finish()
	read := r.mcpRead(readCtx)
	var readOnly, isolation string
	if err := read.tx.QueryRow(readCtx, `SELECT current_setting('transaction_read_only'),current_setting('transaction_isolation')`).Scan(&readOnly, &isolation); err != nil || readOnly != "on" || isolation != "repeatable read" {
		t.Fatalf("MCP transaction policy: read_only=%q isolation=%q err=%v", readOnly, isolation, err)
	}
	// Freeze the actual preflight snapshot, then commit a writer separately.
	if err := read.measure(readCtx, `SELECT COUNT(*),COALESCE(SUM(octet_length(sitemap_url)::bigint),0) FROM scans WHERE id=$1`, mcpScanID); err != nil {
		t.Fatal(err)
	}
	execMCPFixture(t, r, ctx, `UPDATE scans SET sitemap_url=repeat('x',6*1024*1024),scanned_urls=100 WHERE id=$1`, mcpScanID)
	execMCPFixture(t, r, ctx, `INSERT INTO scans(id,sitemap_url,status) VALUES($1,'https://fixture.test/new','completed')`, mcpOtherScanID)
	execMCPFixture(t, r, ctx, `UPDATE scan_score_summary_cache SET score=25 WHERE scan_id=$1`, mcpScanID)
	scan, err := r.GetScan(readCtx, mcpScanID)
	if err != nil || scan == nil || scan.SitemapURL != "https://fixture.test/scan" || scan.ScannedURLs != 0 {
		t.Fatalf("fetch escaped its measured snapshot: present=%v err=%v", scan != nil, err)
	}
	stats, err := r.GetStats(readCtx)
	if err != nil || stats == nil || stats.TotalScans != 1 || stats.TotalPages != 0 {
		t.Fatalf("scalar stats escaped the MCP snapshot: stats=%v err=%v", stats, err)
	}
	score, err := r.GetMCPScanScoreSummary(readCtx, mcpScanID)
	if err != nil || score == nil || score.Score == nil || *score.Score != 85 {
		t.Fatalf("scalar score cache escaped the MCP snapshot: present=%v err=%v", score != nil, err)
	}
	page, err := r.ListMCPScans(readCtx, 10, 0)
	if err != nil || len(page) != 1 || page[0].SitemapURL != "https://fixture.test/scan" {
		t.Fatalf("native nested read escaped the MCP snapshot: rows=%d err=%v", len(page), err)
	}
	finish()
	score, err = r.GetMCPScanScoreSummary(ctx, mcpScanID)
	if err != nil || score == nil || score.Score == nil || *score.Score != 25 {
		t.Fatalf("committed score cache writer is not visible to ordinary reads: present=%v err=%v", score != nil, err)
	}
	// The committed oversized writer is visible to the next request.
	requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		_, err := r.GetScan(readCtx, mcpScanID)
		return err
	}))
	writeCtx, writeFinish, err := r.BeginMCPRead(ctx)
	defer writeFinish()
	if err != nil {
		t.Fatal(err)
	}
	_, err = r.mcpRead(writeCtx).tx.Exec(writeCtx, `UPDATE scans SET scanned_urls=999 WHERE id=$1`, mcpScanID)
	var pgError *pgconn.PgError
	if !errors.As(err, &pgError) || pgError.Code != "25006" {
		t.Fatalf("MCP transaction permitted a write: %v", err)
	}
	writeFinish()
	var scanned int
	if err := r.pool.QueryRow(ctx, `SELECT scanned_urls FROM scans WHERE id=$1`, mcpScanID).Scan(&scanned); err != nil || scanned != 100 {
		t.Fatalf("rejected read-only write changed existing data: scanned=%d err=%v", scanned, err)
	}
}

type mcpBudgetTraceQueryKey struct{}

type mcpBudgetQueryTracer struct {
	queries     []string
	beforeQuery func(pgx.TraceQueryStartData)
	afterQuery  func(string, error)
}

func (trace *mcpBudgetQueryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	trace.queries = append(trace.queries, data.SQL)
	if trace.beforeQuery != nil {
		trace.beforeQuery(data)
	}
	return context.WithValue(ctx, mcpBudgetTraceQueryKey{}, data.SQL)
}

func (trace *mcpBudgetQueryTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if trace.afterQuery != nil {
		query, _ := ctx.Value(mcpBudgetTraceQueryKey{}).(string)
		trace.afterQuery(query, data.Err)
	}
}

func TestMCPScanPreflightFetchSnapshotAndAdmissionSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	trace := &mcpBudgetQueryTracer{}
	config := r.pool.Config()
	config.ConnConfig.Tracer = trace
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	traced := New(pool)
	var writerErr error
	wrote := false
	trace.afterQuery = func(query string, err error) {
		if wrote || err != nil || !strings.HasPrefix(query, "SELECT COUNT(*),COALESCE(SUM(") || !strings.Contains(query, "FROM scans WHERE id=$1") {
			return
		}
		// The tracer fires after preflight completes and before GetScan can fetch.
		wrote = true
		_, writerErr = r.pool.Exec(ctx, `UPDATE scans SET sitemap_url=repeat('x',6*1024*1024) WHERE id=$1`, mcpScanID)
	}
	if err := withMCPBudgetRead(t, traced, ctx, func(readCtx context.Context) error {
		scan, err := traced.GetScan(readCtx, mcpScanID)
		if err == nil && (scan == nil || scan.SitemapURL != "https://fixture.test/scan") {
			t.Fatal("same-method fetch escaped its preflight snapshot")
		}
		return err
	}); err != nil {
		t.Fatalf("admitted scan changed between preflight and fetch: %v", err)
	}
	if !wrote || writerErr != nil {
		t.Fatalf("peer writer did not commit after preflight: wrote=%v err=%v", wrote, writerErr)
	}
	fullFetches := 0
	for _, query := range trace.queries {
		if strings.HasPrefix(query, "SELECT "+scanColumns+" FROM scans WHERE id=$1") {
			fullFetches++
		}
	}
	if fullFetches != 1 {
		t.Fatalf("expected one admitted full scan fetch, got %d", fullFetches)
	}
	trace.afterQuery = nil
	trace.queries = nil
	requireMCPReadTooLarge(t, withMCPBudgetRead(t, traced, ctx, func(readCtx context.Context) error {
		_, err := traced.GetScan(readCtx, mcpScanID)
		return err
	}))
	for _, query := range trace.queries {
		if strings.HasPrefix(query, "SELECT "+scanColumns+" FROM scans WHERE id=$1") {
			t.Fatal("oversized preflight proceeded to materialize a full scan row")
		}
	}
}

func TestMCPStatementTimeoutShrinksWithoutChangingPoolSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	var ordinaryBefore, ordinaryAfter string
	if err := r.pool.QueryRow(ctx, `SELECT current_setting('statement_timeout')`).Scan(&ordinaryBefore); err != nil {
		t.Fatal(err)
	}
	deadlineCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	readCtx, finish, err := r.BeginMCPRead(deadlineCtx)
	defer finish()
	if err != nil {
		t.Fatal(err)
	}
	readTimeout := func() time.Duration {
		t.Helper()
		var setting string
		if err := r.mcpQueryer(readCtx).QueryRow(readCtx, `SELECT current_setting('statement_timeout')`).Scan(&setting); err != nil {
			t.Fatal(err)
		}
		duration, err := time.ParseDuration(setting)
		if err != nil {
			t.Fatalf("invalid transaction timeout %q: %v", setting, err)
		}
		return duration
	}
	first := readTimeout()
	time.Sleep(100 * time.Millisecond)
	second := readTimeout()
	if first <= 0 || first > 500*time.Millisecond || second <= 0 || second >= first {
		t.Fatalf("statement timeout did not shrink with the request deadline: first=%v second=%v", first, second)
	}
	finish()
	if err := r.pool.QueryRow(ctx, `SELECT current_setting('statement_timeout')`).Scan(&ordinaryAfter); err != nil {
		t.Fatal(err)
	}
	if ordinaryAfter != ordinaryBefore {
		t.Fatalf("MCP transaction changed ordinary pool defaults: before=%q after=%q", ordinaryBefore, ordinaryAfter)
	}
}

func TestMCPReadCleanupCoversDelayedServerTimeoutSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	config := r.pool.Config()
	config.MaxConns, config.MinConns = 1, 0
	initialDial := config.ConnConfig.DialFunc
	var connected atomic.Bool
	var cancelOnce sync.Once
	cancelDialStarted := make(chan struct{})
	releaseCancelDial := make(chan struct{})
	defer close(releaseCancelDial)
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		if !connected.Load() {
			conn, err := initialDial(ctx, network, address)
			if err == nil {
				connected.Store(true)
			}
			return conn, err
		}
		// Keep the server's query running until its own timeout; release this
		// test-local dial before pool cleanup so pgx can close its connection.
		cancelOnce.Do(func() { close(cancelDialStarted) })
		select {
		case <-releaseCancelDial:
			return nil, errors.New("test disabled cancel-request connection")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	trace := &mcpBudgetQueryTracer{}
	config.ConnConfig.Tracer = trace
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var backendPID uint32
	if err := pool.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&backendPID); err != nil {
		t.Fatal(err)
	}
	traced := New(pool)
	deadlineCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	readCtx, finish, err := traced.BeginMCPRead(deadlineCtx)
	defer finish()
	if err != nil {
		t.Fatal(err)
	}
	originalDeadline, _ := readCtx.Deadline()
	var configured time.Duration
	var queryStarted time.Time
	delayed := false
	trace.beforeQuery = func(data pgx.TraceQueryStartData) {
		if strings.Contains(data.SQL, "set_config('statement_timeout'") {
			if setting, ok := data.Args[0].(string); ok {
				configured, _ = time.ParseDuration(setting)
			}
		}
		if data.SQL == "SELECT pg_sleep(2)" {
			queryStarted = time.Now()
		}
	}
	trace.afterQuery = func(query string, err error) {
		if !delayed && err == nil && strings.Contains(query, "set_config('statement_timeout'") {
			delayed = true
			time.Sleep(200 * time.Millisecond)
		}
	}
	var ignored any
	err = traced.mcpQueryer(readCtx).QueryRow(readCtx, `SELECT pg_sleep(2)`).Scan(&ignored)
	if !errors.Is(err, context.DeadlineExceeded) || !delayed || configured <= 0 || queryStarted.IsZero() {
		t.Fatalf("delayed query did not outlive its client deadline: delayed=%v timeout=%v err=%v", delayed, configured, err)
	}
	select {
	case <-cancelDialStarted:
	case <-time.After(time.Second):
		t.Fatal("pgx did not attempt its asynchronous cancel-request connection")
	}
	lease := finish()
	active := func() bool {
		var running bool
		if err := r.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
			WHERE pid=$1 AND state='active' AND query='SELECT pg_sleep(2)')`, backendPID).Scan(&running); err != nil {
			t.Fatal(err)
		}
		return running
	}
	if !active() {
		t.Fatal("server query stopped before its delayed relative statement timeout")
	}
	latestServerExpiry := queryStarted.Add(configured)
	if !lease.After(originalDeadline.Add(150*time.Millisecond)) || lease.Before(latestServerExpiry) {
		t.Fatalf("cleanup lease ends before the delayed server timeout: original=%v server=%v lease=%v", originalDeadline, latestServerExpiry, lease)
	}
	deadline := time.Now().Add(2 * time.Second)
	for active() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if active() || time.Now().After(lease) {
		t.Fatal("cleanup lease did not cover the server's actual relative timeout")
	}
}

func TestMCPLinkStatsCounterReadBudgetSQL(t *testing.T) {
	r, ctx := mcpTestRepository(t)
	mcpReadBudgetFixture(t, r, ctx)
	execMCPFixture(t, r, ctx, `UPDATE link_checks SET pages_checked=7,links_checked=8,
		summary=jsonb_build_object('broken',2,'redirected',3,'timeout',4,'padding',repeat('x',6*1024*1024)) WHERE id=$1`, mcpBudgetJobID)
	want := map[string]int64{"total_checks": 1, "active_checks": 0, "pages_checked": 7,
		"links_checked": 8, "broken_links": 2, "redirected_links": 3, "timeouts": 4}
	ordinary, err := r.GetLinkCheckStats(ctx)
	if err != nil || !reflect.DeepEqual(ordinary, want) {
		t.Fatalf("ordinary typed link stats changed: stats=%v err=%v", ordinary, err)
	}
	if err := withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
		stats, err := r.GetLinkCheckStats(readCtx)
		if err == nil && !reflect.DeepEqual(stats, want) {
			t.Fatalf("MCP typed link stats changed: %v", stats)
		}
		return err
	}); err != nil {
		t.Fatalf("unselected summary padding poisoned scalar stats: %v", err)
	}
	for _, counter := range []string{"broken", "redirected", "timeout"} {
		t.Run(counter, func(t *testing.T) {
			execMCPFixture(t, r, ctx, `UPDATE link_checks SET summary=jsonb_build_object($2::text,repeat('x',6*1024*1024)) WHERE id=$1`, mcpBudgetJobID, counter)
			requireMCPReadTooLarge(t, withMCPBudgetRead(t, r, ctx, func(readCtx context.Context) error {
				_, err := r.GetLinkCheckStats(readCtx)
				return err
			}))
		})
	}
}

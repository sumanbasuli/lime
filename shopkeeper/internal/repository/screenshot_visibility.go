package repository

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/sumanbasuli/lime/shopkeeper/internal/screenshots"
)

var focusPreviewName = regexp.MustCompile(`^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_focus_[0-9]+_preview\.png$`)

// ScreenshotVisible permits only images belonging to a committed page. Clean
// pages can have a full-page image without any occurrence row; focus images
// must be referenced by persisted issue or review evidence. A derived focus
// preview is visible only through its referenced base image in the same scan.
func (r *Repository) ScreenshotVisible(ctx context.Context, scanID, filename string) (bool, error) {
	var previewURLID, baseFocusPath string
	if match := focusPreviewName.FindStringSubmatch(filename); match != nil {
		previewURLID = match[1]
		baseFocusPath = screenshots.StoredPath(scanID, strings.TrimSuffix(filename, "_preview.png")+".png")
	}
	directEvidenceAllowed := !strings.Contains(filename, "_preview")
	var visible bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM urls u
			WHERE u.scan_id = $1 AND u.status = 'completed'
			  AND (
				u.id::text || '.png' = $2
				OR ($5 AND EXISTS (
					SELECT 1 FROM issue_occurrences io
					WHERE io.url_id = u.id
					  AND (right(io.screenshot_path, length($2) + 1) = '/' || $2
					       OR right(io.element_screenshot_path, length($2) + 1) = '/' || $2)
				))
				OR ($5 AND EXISTS (
					SELECT 1 FROM url_audit_occurrences ao
					WHERE ao.url_id = u.id
					  AND (right(ao.screenshot_path, length($2) + 1) = '/' || $2
					       OR right(ao.element_screenshot_path, length($2) + 1) = '/' || $2)
				))
				OR ($3 <> '' AND u.id::text = $3 AND (
				EXISTS (
					SELECT 1 FROM issue_occurrences io
					WHERE io.url_id = u.id
					  AND (io.screenshot_path = $4 OR io.element_screenshot_path = $4)
				)
				OR EXISTS (
					SELECT 1 FROM url_audit_occurrences ao
					WHERE ao.url_id = u.id
					  AND (ao.screenshot_path = $4 OR ao.element_screenshot_path = $4)
				)
			))
			  )
		)`, scanID, filename, previewURLID, baseFocusPath, directEvidenceAllowed).Scan(&visible)
	if err != nil {
		return false, fmt.Errorf("failed to check screenshot visibility: %w", err)
	}
	return visible, nil
}

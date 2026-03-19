-- Add help_url to issues for linking to axe-core documentation
ALTER TABLE issues ADD COLUMN help_url TEXT;

-- Add element-level screenshot path and CSS selector to issue_occurrences
ALTER TABLE issue_occurrences ADD COLUMN element_screenshot_path TEXT;
ALTER TABLE issue_occurrences ADD COLUMN css_selector TEXT;

ALTER TABLE issue_occurrences DROP COLUMN IF EXISTS css_selector;
ALTER TABLE issue_occurrences DROP COLUMN IF EXISTS element_screenshot_path;
ALTER TABLE issues DROP COLUMN IF EXISTS help_url;

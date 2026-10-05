DROP TABLE IF EXISTS link_check_results;
DROP TABLE IF EXISTS link_checks;
ALTER TABLE scans DROP COLUMN IF EXISTS include_link_check;

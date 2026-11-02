-- Old Shopkeeper processes can still insert rows between migration and restart.
-- Their writes omit this column, so default them to public-only. New writers
-- explicitly opt fresh jobs into private-root eligibility after persisting DNS.
ALTER TABLE scans ADD COLUMN root_public BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE link_checks ADD COLUMN root_public BOOLEAN NOT NULL DEFAULT TRUE;

-- Existing hostname jobs may already have used a public address. A true IP
-- literal has no DNS rebinding history, so retain its previous eligibility.
-- Use PostgreSQL's inet parser for bracketed IPv6: a hex/colon regex alone
-- would mistake malformed hosts such as [1:2] for an IP literal. Dotted IPv4
-- tails are conservatively excluded because its parser accepts some forms
-- that Go's IP parser does not.
UPDATE scans
SET root_public = FALSE
WHERE sitemap_url ~* '^https?://(((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]?|0)\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]?|0))(:[0-9]+)?([/?#]|$)'
   OR (sitemap_url ~* '^https?://\[[0-9a-f]*:[0-9a-f:]+\](:[0-9]+)?([/?#]|$)'
       AND pg_input_is_valid(substring(lower(sitemap_url) from '^https?://\[([0-9a-f]*:[0-9a-f:]+)\]'), 'inet'));

UPDATE link_checks
SET root_public = FALSE
WHERE url ~* '^https?://(((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]?|0)\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]?|0))(:[0-9]+)?([/?#]|$)'
   OR (url ~* '^https?://\[[0-9a-f]*:[0-9a-f:]+\](:[0-9]+)?([/?#]|$)'
       AND pg_input_is_valid(substring(lower(url) from '^https?://\[([0-9a-f]*:[0-9a-f:]+)\]'), 'inet'));

-- A scan and its companion share one policy, even if old stored URLs differ.
UPDATE scans s
SET root_public = TRUE
FROM link_checks j
WHERE j.scan_id = s.id AND j.root_public;

UPDATE link_checks j
SET root_public = TRUE
FROM scans s
WHERE j.scan_id = s.id AND s.root_public;

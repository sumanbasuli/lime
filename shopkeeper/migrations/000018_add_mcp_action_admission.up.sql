-- A single row serializes new MCP request IDs across processes without
-- scanning the permanent idempotency ledger on each action.
CREATE TABLE mcp_action_admission (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  day_utc DATE NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted BETWEEN 0 AND 1000)
);

-- Count existing reservations conservatively during upgrade. The older ledger
-- uses naive timestamps, so a database session outside UTC can place today's
-- request on the adjacent SQL date. This broader one-time count avoids giving
-- the migration day extra IDs; later days use only the constant-size counter.
INSERT INTO mcp_action_admission (singleton, day_utc, accepted)
SELECT TRUE, utc_day, LEAST(1000::BIGINT, COUNT(mcp_action_requests.request_id))::INTEGER
FROM (SELECT (clock_timestamp() AT TIME ZONE 'UTC')::DATE AS utc_day) AS clock
LEFT JOIN mcp_action_requests
  ON created_at >= (utc_day - 1)::TIMESTAMP
 AND created_at < (utc_day + 2)::TIMESTAMP
GROUP BY utc_day;

-- Existing enabled keys remain read-only after upgrade until an owner opts in.
ALTER TABLE app_settings
  ADD COLUMN mcp_allow_writes BOOLEAN NOT NULL DEFAULT FALSE;

-- Reserve before invoking an action and retain responses across server restarts.
-- Deliberately no expiry: reusing an old request ID must never launch another job.
CREATE TABLE mcp_action_requests (
  request_id UUID PRIMARY KEY,
  tool TEXT NOT NULL CHECK (length(tool) BETWEEN 1 AND 100),
  arguments_hash TEXT NOT NULL CHECK (length(arguments_hash) = 64),
  response JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  CHECK ((response IS NULL) = (completed_at IS NULL))
);

package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

const mcpNewRequestIDsPerUTCDay = 1000

// MCPActionRateLimitError means a new request ID was rejected before it could
// reserve a ledger row or start an action. The same ID can be retried at RetryAt.
type MCPActionRateLimitError struct {
	RetryAt           time.Time
	RetryAfterSeconds int
}

func (e *MCPActionRateLimitError) Error() string {
	return fmt.Sprintf("MCP new request ID limit of %d per UTC day reached; retry after %s", mcpNewRequestIDsPerUTCDay, e.RetryAt.Format(time.RFC3339))
}

func mcpActionReservation(ctx context.Context, tx pgx.Tx, requestID string) (*models.MCPActionRequest, error) {
	entry := &models.MCPActionRequest{}
	err := tx.QueryRow(ctx, `SELECT tool, arguments_hash,
		CASE WHEN response IS NOT NULL AND octet_length(response::text) <= $2 THEN response::text END,
		response IS NOT NULL AND octet_length(response::text) > $2
		FROM mcp_action_requests WHERE request_id = $1`, requestID, MaxMCPActionResponseBytes).
		Scan(&entry.Tool, &entry.ArgumentsHash, &entry.Response, &entry.ResponseTooLarge)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return entry, nil
}

// BeginMCPAction serializes new-ID admission on one durable SQL row. Both UUID
// reads use READ COMMITTED snapshots, so a retry waiting for the row lock sees
// the first caller's committed reservation even when the daily quota is full.
func (r *Repository) BeginMCPAction(ctx context.Context, requestID, tool, argumentsHash string) (*models.MCPActionRequest, bool, error) {
	tx, err := r.actionTx(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("begin MCP action reservation: %w", err)
	}
	defer tx.Rollback(ctx)

	entry, err := mcpActionReservation(ctx, tx, requestID)
	if err != nil {
		return nil, false, fmt.Errorf("read MCP action reservation: %w", err)
	}
	if entry != nil {
		if err := tx.Commit(ctx); err != nil {
			return nil, false, fmt.Errorf("commit MCP action replay: %w", err)
		}
		return entry, false, nil
	}

	var day time.Time
	var accepted int
	if err := tx.QueryRow(ctx, `SELECT day_utc, accepted FROM mcp_action_admission WHERE singleton = TRUE FOR UPDATE`).Scan(&day, &accepted); err != nil {
		return nil, false, fmt.Errorf("lock MCP action admission: %w", err)
	}

	// A concurrent request for this UUID may have committed while we waited for
	// the singleton row. Existing reservations always bypass the new-ID quota.
	entry, err = mcpActionReservation(ctx, tx, requestID)
	if err != nil {
		return nil, false, fmt.Errorf("read MCP action reservation after admission lock: %w", err)
	}
	if entry != nil {
		if err := tx.Commit(ctx); err != nil {
			return nil, false, fmt.Errorf("commit MCP action replay: %w", err)
		}
		return entry, false, nil
	}

	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return nil, false, fmt.Errorf("read MCP action admission time: %w", err)
	}
	utc := now.UTC()
	today := time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
	if day.Format("2006-01-02") == today.Format("2006-01-02") && accepted >= mcpNewRequestIDsPerUTCDay {
		retryAt := today.AddDate(0, 0, 1)
		retryAfter := retryAt.Sub(utc)
		return nil, false, &MCPActionRateLimitError{RetryAt: retryAt, RetryAfterSeconds: int((retryAfter + time.Second - 1) / time.Second)}
	}

	// ON CONFLICT still waits for any reservation written outside this gate,
	// then the READ COMMITTED SELECT below observes its committed outcome.
	result, err := tx.Exec(ctx, `INSERT INTO mcp_action_requests (request_id, tool, arguments_hash)
		VALUES ($1, $2, $3) ON CONFLICT (request_id) DO NOTHING`, requestID, tool, argumentsHash)
	if err != nil {
		return nil, false, fmt.Errorf("reserve MCP action: %w", err)
	}
	if result.RowsAffected() == 0 {
		entry, err = mcpActionReservation(ctx, tx, requestID)
		if err != nil {
			return nil, false, fmt.Errorf("read concurrent MCP action reservation: %w", err)
		}
		if entry == nil {
			return nil, false, fmt.Errorf("concurrent MCP action reservation disappeared: %w", pgx.ErrNoRows)
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, false, fmt.Errorf("commit MCP action replay: %w", err)
		}
		return entry, false, nil
	}

	if _, err := tx.Exec(ctx, `UPDATE mcp_action_admission
		SET day_utc = $1, accepted = CASE WHEN day_utc = $1 THEN accepted + 1 ELSE 1 END
		WHERE singleton = TRUE`, today); err != nil {
		return nil, false, fmt.Errorf("count MCP action reservation: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, fmt.Errorf("commit MCP action reservation: %w", err)
	}
	return &models.MCPActionRequest{Tool: tool, ArgumentsHash: argumentsHash}, true, nil
}

func (r *Repository) CompleteMCPAction(ctx context.Context, requestID string, response []byte) error {
	count, err := r.actionExec(ctx, `UPDATE mcp_action_requests SET response = $2::jsonb, completed_at = NOW()
		WHERE request_id = $1 AND response IS NULL`, requestID, string(response))
	if err != nil {
		return fmt.Errorf("complete MCP action: %w", err)
	}
	if count != 1 {
		return fmt.Errorf("complete MCP action: %w", pgx.ErrNoRows)
	}
	return nil
}

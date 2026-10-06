package repository

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

// BeginMCPAction atomically reserves an ID, or returns its original reservation.
// ON CONFLICT waits for a concurrent insert to commit before the subsequent read.
func (r *Repository) BeginMCPAction(ctx context.Context, requestID, tool, argumentsHash string) (*models.MCPActionRequest, bool, error) {
	result, err := r.pool.Exec(ctx, `INSERT INTO mcp_action_requests (request_id, tool, arguments_hash)
		VALUES ($1, $2, $3) ON CONFLICT (request_id) DO NOTHING`, requestID, tool, argumentsHash)
	if err != nil {
		return nil, false, fmt.Errorf("reserve MCP action: %w", err)
	}
	if result.RowsAffected() == 1 {
		return &models.MCPActionRequest{Tool: tool, ArgumentsHash: argumentsHash}, true, nil
	}
	entry := &models.MCPActionRequest{}
	err = r.pool.QueryRow(ctx, `SELECT tool, arguments_hash, response FROM mcp_action_requests WHERE request_id = $1`, requestID).
		Scan(&entry.Tool, &entry.ArgumentsHash, &entry.Response)
	if err != nil {
		return nil, false, fmt.Errorf("read MCP action reservation: %w", err)
	}
	return entry, false, nil
}

func (r *Repository) CompleteMCPAction(ctx context.Context, requestID string, response []byte) error {
	result, err := r.pool.Exec(ctx, `UPDATE mcp_action_requests SET response = $2::jsonb, completed_at = NOW()
		WHERE request_id = $1 AND response IS NULL`, requestID, string(response))
	if err != nil {
		return fmt.Errorf("complete MCP action: %w", err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("complete MCP action: %w", pgx.ErrNoRows)
	}
	return nil
}

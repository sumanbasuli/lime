package repository

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/rootdns"
)

// ErrRootDNSBlocked means a root lookup mixed public and nonpublic addresses,
// or a private root observation or dial followed a public observation.
var ErrRootDNSBlocked = rootdns.ErrBlocked

func validateRootDNSObservation(public, nonPublic bool) error {
	if !public && !nonPublic {
		return errors.New("root DNS observation contained no addresses")
	}
	return nil
}

// A private root dial holds these row locks until its TCP dial completes. A
// public observation needs FOR UPDATE on the same rows and therefore cannot
// commit a public policy while the private dial is in progress.
func releaseRootDNSDialLease(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}

// GuardScanPrivateRootDial leases a scan's private-root policy for one TCP
// dial. The caller must release the lease immediately after the dial returns.
func (r *Repository) GuardScanPrivateRootDial(ctx context.Context, scanID string) (release func(), err error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin scan private root dial guard: %w", err)
	}
	leased := false
	defer func() {
		if !leased {
			releaseRootDNSDialLease(tx)
		}
	}()

	var scanPublic bool
	if err := tx.QueryRow(ctx, `SELECT root_public FROM scans WHERE id=$1 FOR SHARE`, scanID).Scan(&scanPublic); err != nil {
		return nil, fmt.Errorf("lock scan private root dial policy: %w", err)
	}
	var companionPublic bool
	err = tx.QueryRow(ctx, `SELECT root_public FROM link_checks WHERE scan_id=$1 FOR SHARE`, scanID).Scan(&companionPublic)
	if err != nil && err != pgx.ErrNoRows {
		return nil, fmt.Errorf("lock companion private root dial policy: %w", err)
	}
	if scanPublic || companionPublic {
		return nil, ErrRootDNSBlocked
	}
	leased = true
	return sync.OnceFunc(func() { releaseRootDNSDialLease(tx) }), nil
}

// GuardLinkCheckPrivateRootDial leases a link check's private-root policy for
// one TCP dial. Companion checks also lock their parent scan first.
func (r *Repository) GuardLinkCheckPrivateRootDial(ctx context.Context, jobID string) (release func(), err error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin link-check private root dial guard: %w", err)
	}
	leased := false
	defer func() {
		if !leased {
			releaseRootDNSDialLease(tx)
		}
	}()

	var parentID *string
	if err := tx.QueryRow(ctx, `SELECT scan_id FROM link_checks WHERE id=$1`, jobID).Scan(&parentID); err != nil {
		return nil, fmt.Errorf("find link-check private root dial policy: %w", err)
	}
	var scanPublic bool
	if parentID != nil {
		if err := tx.QueryRow(ctx, `SELECT root_public FROM scans WHERE id=$1 FOR SHARE`, *parentID).Scan(&scanPublic); err != nil {
			return nil, fmt.Errorf("lock parent scan private root dial policy: %w", err)
		}
	}
	var jobPublic bool
	var lockedParentID *string
	if err := tx.QueryRow(ctx, `SELECT scan_id,root_public FROM link_checks WHERE id=$1 FOR SHARE`, jobID).
		Scan(&lockedParentID, &jobPublic); err != nil {
		return nil, fmt.Errorf("lock link-check private root dial policy: %w", err)
	}
	if (lockedParentID == nil) != (parentID == nil) ||
		(lockedParentID != nil && *lockedParentID != *parentID) {
		return nil, errors.New("link-check parent changed during private root dial guard")
	}
	if scanPublic || jobPublic {
		return nil, ErrRootDNSBlocked
	}
	leased = true
	return sync.OnceFunc(func() { releaseRootDNSDialLease(tx) }), nil
}

// ObserveScanRootDNS commits a root lookup's policy before the caller dials.
// The scan row is always locked before its companion row.
func (r *Repository) ObserveScanRootDNS(ctx context.Context, scanID string, public, nonPublic bool) error {
	if err := validateRootDNSObservation(public, nonPublic); err != nil {
		return err
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin scan root DNS observation: %w", err)
	}
	defer tx.Rollback(ctx)

	var scanPublic bool
	if err := tx.QueryRow(ctx, `SELECT root_public FROM scans WHERE id=$1 FOR UPDATE`, scanID).Scan(&scanPublic); err != nil {
		return fmt.Errorf("lock scan root DNS policy: %w", err)
	}
	var companionPublic bool
	err = tx.QueryRow(ctx, `SELECT root_public FROM link_checks WHERE scan_id=$1 FOR UPDATE`, scanID).Scan(&companionPublic)
	if err != nil && err != pgx.ErrNoRows {
		return fmt.Errorf("lock companion root DNS policy: %w", err)
	}
	blocked := nonPublic && (public || scanPublic || companionPublic)
	if public {
		if _, err := tx.Exec(ctx, `UPDATE scans SET root_public=TRUE WHERE id=$1`, scanID); err != nil {
			return fmt.Errorf("mark scan root public: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE link_checks SET root_public=TRUE WHERE scan_id=$1`, scanID); err != nil {
			return fmt.Errorf("mark companion root public: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit scan root DNS observation: %w", err)
	}
	if blocked {
		return ErrRootDNSBlocked
	}
	return nil
}

// ObserveLinkCheckRootDNS shares a companion's policy with its parent scan.
// Detached checks keep their own policy. The parent lock precedes the job lock
// so concurrent scan and link-check observations serialize without deadlock.
func (r *Repository) ObserveLinkCheckRootDNS(ctx context.Context, jobID string, public, nonPublic bool) error {
	if err := validateRootDNSObservation(public, nonPublic); err != nil {
		return err
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin link-check root DNS observation: %w", err)
	}
	defer tx.Rollback(ctx)

	var parentID *string
	if err := tx.QueryRow(ctx, `SELECT scan_id FROM link_checks WHERE id=$1`, jobID).Scan(&parentID); err != nil {
		return fmt.Errorf("find link-check root DNS policy: %w", err)
	}
	var scanPublic bool
	if parentID != nil {
		if err := tx.QueryRow(ctx, `SELECT root_public FROM scans WHERE id=$1 FOR UPDATE`, *parentID).Scan(&scanPublic); err != nil {
			return fmt.Errorf("lock parent scan root DNS policy: %w", err)
		}
	}
	var jobPublic bool
	var lockedParentID *string
	if err := tx.QueryRow(ctx, `SELECT scan_id,root_public FROM link_checks WHERE id=$1 FOR UPDATE`, jobID).
		Scan(&lockedParentID, &jobPublic); err != nil {
		return fmt.Errorf("lock link-check root DNS policy: %w", err)
	}
	if (lockedParentID == nil) != (parentID == nil) ||
		(lockedParentID != nil && *lockedParentID != *parentID) {
		return errors.New("link-check parent changed during root DNS observation")
	}
	blocked := nonPublic && (public || scanPublic || jobPublic)
	if public {
		if parentID != nil {
			if _, err := tx.Exec(ctx, `UPDATE scans SET root_public=TRUE WHERE id=$1`, *parentID); err != nil {
				return fmt.Errorf("mark parent scan root public: %w", err)
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE link_checks SET root_public=TRUE WHERE id=$1`, jobID); err != nil {
			return fmt.Errorf("mark link-check root public: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit link-check root DNS observation: %w", err)
	}
	if blocked {
		return ErrRootDNSBlocked
	}
	return nil
}

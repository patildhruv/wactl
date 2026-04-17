package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// LIDResolver caches WhatsApp's lid↔phone-number mapping from whatsmeow's
// session.db::whatsmeow_lid_map table.
//
// Background: WhatsApp migrated 1:1 chats to LID (Linked Identifier) JIDs around
// March 2026. Incoming messages now carry `<num>@lid` instead of `<phone>@s.whatsapp.net`,
// while whatsmeow keeps a phone↔lid mapping in its store. This resolver exposes
// that mapping so the bridge can normalize stored JIDs back to phone form, which
// keeps search_contacts / get_chat consistent with the pre-migration world.
type LIDResolver struct {
	db     *sql.DB
	logger waLog.Logger

	mu  sync.RWMutex
	l2p map[string]string // lid user-part -> phone
	p2l map[string]string // phone -> lid user-part
}

// NewLIDResolver opens session.db read-only and returns a resolver. The caller
// should invoke Refresh once before relying on the maps.
func NewLIDResolver(sessionDBPath string, logger waLog.Logger) (*LIDResolver, error) {
	// mode=ro + PRAGMA query_only keeps us strictly a reader; whatsmeow owns
	// writes via its own connection. No journal-mode override — we let whatsmeow
	// control that to avoid fighting over locks.
	dsn := fmt.Sprintf("file:%s?mode=ro&_query_only=1", sessionDBPath)
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open session db: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping session db: %w", err)
	}
	return &LIDResolver{
		db:     db,
		logger: logger,
		l2p:    map[string]string{},
		p2l:    map[string]string{},
	}, nil
}

// Close releases the read-only session.db connection.
func (r *LIDResolver) Close() error {
	if r == nil || r.db == nil {
		return nil
	}
	return r.db.Close()
}

// Refresh reloads the lid↔pn map from session.db.
func (r *LIDResolver) Refresh(ctx context.Context) error {
	if r == nil {
		return nil
	}
	rows, err := r.db.QueryContext(ctx, `SELECT lid, pn FROM whatsmeow_lid_map`)
	if err != nil {
		return fmt.Errorf("query lid_map: %w", err)
	}
	defer rows.Close()

	l2p := make(map[string]string, 4096)
	p2l := make(map[string]string, 4096)
	for rows.Next() {
		var lid, pn string
		if err := rows.Scan(&lid, &pn); err != nil {
			return err
		}
		l2p[lid] = pn
		p2l[pn] = lid
	}
	if err := rows.Err(); err != nil {
		return err
	}

	r.mu.Lock()
	r.l2p = l2p
	r.p2l = p2l
	r.mu.Unlock()
	if r.logger != nil {
		r.logger.Infof("LIDResolver: loaded %d lid↔pn mappings", len(l2p))
	}
	return nil
}

// StartAutoRefresh refreshes the cache on the given interval until ctx is done.
func (r *LIDResolver) StartAutoRefresh(ctx context.Context, interval time.Duration) {
	if r == nil {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.Refresh(ctx); err != nil && r.logger != nil {
				r.logger.Warnf("LIDResolver refresh failed: %v", err)
			}
		}
	}
}

// PhoneForLID returns the phone-number user-part for a given LID user-part.
// Second return is false when no mapping is known.
func (r *LIDResolver) PhoneForLID(lid string) (string, bool) {
	if r == nil {
		return "", false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	pn, ok := r.l2p[lid]
	return pn, ok
}

// LIDForPhone returns the LID user-part for a given phone number.
func (r *LIDResolver) LIDForPhone(phone string) (string, bool) {
	if r == nil {
		return "", false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	lid, ok := r.p2l[phone]
	return lid, ok
}

// Snapshot returns a copy of the lid→pn map, safe to iterate without holding the lock.
func (r *LIDResolver) Snapshot() map[string]string {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string]string, len(r.l2p))
	for k, v := range r.l2p {
		out[k] = v
	}
	return out
}

// Classify inspects a bare user-part and returns what kind of identity it is
// plus the resolved phone and LID user-parts when a mapping is known.
//
//   - If the user-part is an LID we've seen, jidType="lid", phone=<resolved>, lid=userPart.
//   - If the user-part is a phone with a known LID counterpart, jidType="phone",
//     phone=userPart, lid=<counterpart>.
//   - Otherwise, jidType="phone" (best guess; most user-parts without a mapping
//     are just phones the bridge hasn't seen LIDs for yet), phone=userPart, lid="".
//
// Callers use this to enrich MessageRecord.from with a typed JID + resolved phone.
func (r *LIDResolver) Classify(userPart string) (jidType, phone, lid string) {
	if userPart == "" {
		return "phone", "", ""
	}
	if r == nil {
		return "phone", userPart, ""
	}
	if p, ok := r.PhoneForLID(userPart); ok {
		return "lid", p, userPart
	}
	if l, ok := r.LIDForPhone(userPart); ok {
		return "phone", userPart, l
	}
	return "phone", userPart, ""
}

// Normalize converts a types.JID from the @lid namespace to @s.whatsapp.net
// when a mapping is known. Other JIDs (groups, newsletters, already-phone)
// are returned unchanged.
func (r *LIDResolver) Normalize(jid types.JID) types.JID {
	if r == nil {
		return jid
	}
	if jid.Server != types.HiddenUserServer {
		return jid
	}
	pn, ok := r.PhoneForLID(jid.User)
	if !ok {
		return jid
	}
	jid.User = pn
	jid.Server = types.DefaultUserServer
	return jid
}

// NormalizeString accepts a JID string and returns the normalized form.
// If parsing fails or no mapping applies, the input is returned verbatim.
func (r *LIDResolver) NormalizeString(jid string) string {
	if r == nil || !strings.HasSuffix(jid, "@lid") {
		return jid
	}
	parsed, err := types.ParseJID(jid)
	if err != nil {
		return jid
	}
	return r.Normalize(parsed).String()
}

// NormalizeUser takes a bare user-part (possibly an LID) and returns the
// phone equivalent when known, otherwise the input unchanged. Useful for the
// `sender` column where we store bare user-parts, not full JIDs.
func (r *LIDResolver) NormalizeUser(user string) string {
	if r == nil || user == "" {
		return user
	}
	// Group-participant users can look like "<lid>:<deviceId>"; strip the device.
	bare := user
	if idx := strings.IndexByte(user, ':'); idx >= 0 {
		bare = user[:idx]
	}
	if pn, ok := r.PhoneForLID(bare); ok {
		return pn
	}
	return user
}

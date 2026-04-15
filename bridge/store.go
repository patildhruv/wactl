package main

import (
	"database/sql"
	"fmt"
	"os"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// MessageStore handles SQLite operations for messages and chats.
type MessageStore struct {
	db *sql.DB
}

// NewMessageStore opens or creates the message database at the given directory.
func NewMessageStore(dataDir string) (*MessageStore, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	dbPath := fmt.Sprintf("file:%s/messages.db?_foreign_keys=on&_journal_mode=WAL", dataDir)
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open message db: %w", err)
	}

	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS chats (
			jid TEXT PRIMARY KEY,
			name TEXT,
			last_message_time TIMESTAMP,
			unread_count INTEGER DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS messages (
			id TEXT,
			chat_jid TEXT,
			sender TEXT,
			content TEXT,
			timestamp TIMESTAMP,
			is_from_me BOOLEAN,
			media_type TEXT,
			filename TEXT,
			url TEXT,
			media_key BLOB,
			file_sha256 BLOB,
			file_enc_sha256 BLOB,
			file_length INTEGER,
			PRIMARY KEY (id, chat_jid)
		);
		CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp DESC);
		CREATE TABLE IF NOT EXISTS contacts (
			jid TEXT PRIMARY KEY,
			push_name TEXT,
			full_name TEXT,
			updated_at TIMESTAMP
		);
		CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(push_name, full_name);
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name TEXT PRIMARY KEY,
			applied_at TIMESTAMP
		);
	`); err != nil {
		db.Close()
		return nil, fmt.Errorf("create tables: %w", err)
	}

	return &MessageStore{db: db}, nil
}

// migrationApplied reports whether a named migration has already run.
func (s *MessageStore) migrationApplied(name string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE name = ?`, name).Scan(&n)
	return n > 0, err
}

// markMigrationApplied records that a named migration has run.
func (s *MessageStore) markMigrationApplied(name string) error {
	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
		name, time.Now(),
	)
	return err
}

// MigrateLIDChats is a one-time backfill that rewrites legacy @lid rows in
// chats / messages / contacts to their @s.whatsapp.net equivalents, using the
// resolver's lid→pn snapshot. Idempotent — guarded by schema_migrations.
//
// Runs once per messages.db. New mappings that appear later are handled at
// write time by the resolver in handlers.go, so re-running isn't necessary.
func (s *MessageStore) MigrateLIDChats(resolver *LIDResolver) error {
	const migrationName = "lid_backfill_v1"
	if resolver == nil {
		return nil
	}
	applied, err := s.migrationApplied(migrationName)
	if err != nil {
		return fmt.Errorf("check migration: %w", err)
	}
	if applied {
		return nil
	}

	snapshot := resolver.Snapshot()
	if len(snapshot) == 0 {
		// Nothing to migrate; still mark done so we don't retry forever.
		return s.markMigrationApplied(migrationName)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Prepared statements — SQLite needs one Exec per mapping row since each
	// UPDATE targets a specific (lid, pn) pair. The phone-side row may already
	// exist (pre-migration), so we UPDATE-then-DELETE to handle the collision.

	updateChats, err := tx.Prepare(`UPDATE OR IGNORE chats SET jid = ? WHERE jid = ?`)
	if err != nil {
		return err
	}
	defer updateChats.Close()

	deleteDupChats, err := tx.Prepare(`DELETE FROM chats WHERE jid = ?`)
	if err != nil {
		return err
	}
	defer deleteDupChats.Close()

	updateMessagesChat, err := tx.Prepare(`UPDATE OR IGNORE messages SET chat_jid = ? WHERE chat_jid = ?`)
	if err != nil {
		return err
	}
	defer updateMessagesChat.Close()

	// Clean up messages whose (id, chat_jid) clashed with an existing phone row.
	deleteDupMessages, err := tx.Prepare(`DELETE FROM messages WHERE chat_jid = ?`)
	if err != nil {
		return err
	}
	defer deleteDupMessages.Close()

	updateMessageSender, err := tx.Prepare(`UPDATE messages SET sender = ? WHERE sender = ?`)
	if err != nil {
		return err
	}
	defer updateMessageSender.Close()

	updateContacts, err := tx.Prepare(`UPDATE OR IGNORE contacts SET jid = ? WHERE jid = ?`)
	if err != nil {
		return err
	}
	defer updateContacts.Close()

	deleteDupContacts, err := tx.Prepare(`DELETE FROM contacts WHERE jid = ?`)
	if err != nil {
		return err
	}
	defer deleteDupContacts.Close()

	chatCount := 0
	msgCount := 0
	for lid, pn := range snapshot {
		lidChatJID := lid + "@lid"
		pnChatJID := pn + "@s.whatsapp.net"

		// chats: rewrite; if phone row already exists UPDATE OR IGNORE leaves
		// the lid row intact, so we drop it explicitly.
		res, err := updateChats.Exec(pnChatJID, lidChatJID)
		if err != nil {
			return fmt.Errorf("update chats: %w", err)
		}
		n, _ := res.RowsAffected()
		chatCount += int(n)
		if _, err := deleteDupChats.Exec(lidChatJID); err != nil {
			return fmt.Errorf("delete dup chats: %w", err)
		}

		// messages: same pattern on chat_jid (primary key is (id, chat_jid)).
		res, err = updateMessagesChat.Exec(pnChatJID, lidChatJID)
		if err != nil {
			return fmt.Errorf("update messages.chat_jid: %w", err)
		}
		n, _ = res.RowsAffected()
		msgCount += int(n)
		if _, err := deleteDupMessages.Exec(lidChatJID); err != nil {
			return fmt.Errorf("delete dup messages: %w", err)
		}

		// messages.sender: stored bare (user-part only). No unique constraint,
		// plain UPDATE is safe.
		if _, err := updateMessageSender.Exec(pn, lid); err != nil {
			return fmt.Errorf("update messages.sender: %w", err)
		}

		// contacts: same PK collision handling.
		if _, err := updateContacts.Exec(pnChatJID, lidChatJID); err != nil {
			return fmt.Errorf("update contacts: %w", err)
		}
		if _, err := deleteDupContacts.Exec(lidChatJID); err != nil {
			return fmt.Errorf("delete dup contacts: %w", err)
		}
	}

	if _, err := tx.Exec(
		`INSERT OR REPLACE INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
		migrationName, time.Now(),
	); err != nil {
		return fmt.Errorf("mark migration: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration: %w", err)
	}

	fmt.Printf("[LID migration] rewrote %d chats, %d messages across %d lid↔pn pairs\n",
		chatCount, msgCount, len(snapshot))
	return nil
}

// Close releases the database connection.
func (s *MessageStore) Close() error {
	return s.db.Close()
}

// UpsertChat inserts or updates a chat record.
func (s *MessageStore) UpsertChat(jid, name string, lastMsgTime time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
		 ON CONFLICT(jid) DO UPDATE SET
			name = COALESCE(NULLIF(excluded.name, ''), chats.name),
			last_message_time = MAX(chats.last_message_time, excluded.last_message_time)`,
		jid, name, lastMsgTime,
	)
	return err
}

// ContactEntry is used for bulk contact imports.
type ContactEntry struct {
	JID      string
	PushName string
	FullName string
}

// UpsertContact inserts or updates a contact record.
func (s *MessageStore) UpsertContact(jid, pushName, fullName string) error {
	_, err := s.db.Exec(
		`INSERT INTO contacts (jid, push_name, full_name, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(jid) DO UPDATE SET
			push_name = COALESCE(NULLIF(excluded.push_name, ''), contacts.push_name),
			full_name = COALESCE(NULLIF(excluded.full_name, ''), contacts.full_name),
			updated_at = excluded.updated_at`,
		jid, pushName, fullName, time.Now(),
	)
	return err
}

// BulkUpsertContacts inserts or updates multiple contacts in a single transaction.
func (s *MessageStore) BulkUpsertContacts(entries []ContactEntry) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(
		`INSERT INTO contacts (jid, push_name, full_name, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(jid) DO UPDATE SET
			push_name = COALESCE(NULLIF(excluded.push_name, ''), contacts.push_name),
			full_name = COALESCE(NULLIF(excluded.full_name, ''), contacts.full_name),
			updated_at = excluded.updated_at`,
	)
	if err != nil {
		return err
	}
	defer stmt.Close()

	now := time.Now()
	for _, e := range entries {
		if _, err := stmt.Exec(e.JID, e.PushName, e.FullName, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetContactName returns the best available name for a single JID.
func (s *MessageStore) GetContactName(jid string) string {
	var name string
	err := s.db.QueryRow(
		`SELECT COALESCE(NULLIF(full_name,''), NULLIF(push_name,''), '') FROM contacts WHERE jid = ?`,
		jid,
	).Scan(&name)
	if err != nil {
		return ""
	}
	return name
}

// GetContactNames returns a map of JID → display name for a set of sender identifiers.
// Senders can be bare phone numbers (e.g., "1234567890") or full JIDs.
func (s *MessageStore) GetContactNames(senders []string) map[string]string {
	result := make(map[string]string)
	if len(senders) == 0 {
		return result
	}

	// Normalize bare numbers to full JIDs for lookup
	jids := make([]string, len(senders))
	jidToSender := make(map[string]string)
	for i, sender := range senders {
		jid := sender
		if !strings.Contains(sender, "@") {
			jid = sender + "@s.whatsapp.net"
		}
		jids[i] = jid
		jidToSender[jid] = sender
	}

	// Build query with placeholders
	placeholders := make([]string, len(jids))
	args := make([]interface{}, len(jids))
	for i, jid := range jids {
		placeholders[i] = "?"
		args[i] = jid
	}

	rows, err := s.db.Query(
		`SELECT jid, COALESCE(NULLIF(full_name,''), NULLIF(push_name,''), '')
		 FROM contacts WHERE jid IN (`+strings.Join(placeholders, ",")+`)`,
		args...,
	)
	if err != nil {
		return result
	}
	defer rows.Close()

	for rows.Next() {
		var jid, name string
		if err := rows.Scan(&jid, &name); err == nil && name != "" {
			// Map back to the original sender key
			if sender, ok := jidToSender[jid]; ok {
				result[sender] = name
			}
		}
	}
	return result
}

// StoreMessage inserts a message, skipping empty ones.
func (s *MessageStore) StoreMessage(id, chatJID, sender, content string, ts time.Time, isFromMe bool,
	mediaType, filename, url string, mediaKey, fileSHA256, fileEncSHA256 []byte, fileLength uint64) error {
	if content == "" && mediaType == "" {
		return nil
	}
	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO messages
		 (id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename, url, media_key, file_sha256, file_enc_sha256, file_length)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, chatJID, sender, content, ts, isFromMe, mediaType, filename, url, mediaKey, fileSHA256, fileEncSHA256, fileLength,
	)
	return err
}

// ChatSummary is returned by GetChats.
type ChatSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	LastMessage string `json:"lastMessage"`
	Timestamp   int64  `json:"timestamp"`
	Unread      int    `json:"unread"`
}

// GetChats returns all chats ordered by most recent message.
// Names are resolved from the contacts table when the chats table has no name.
func (s *MessageStore) GetChats() ([]ChatSummary, error) {
	rows, err := s.db.Query(`
		SELECT c.jid,
			COALESCE(
				NULLIF(ct.full_name,''),
				NULLIF(ct.push_name,''),
				NULLIF(c.name,''),
				c.jid
			),
			COALESCE((
				SELECT m.content FROM messages m
				WHERE m.chat_jid = c.jid
				ORDER BY m.timestamp DESC LIMIT 1
			), ''),
			c.last_message_time, c.unread_count
		FROM chats c
		LEFT JOIN contacts ct ON ct.jid = c.jid
		ORDER BY c.last_message_time DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var chats []ChatSummary
	for rows.Next() {
		var c ChatSummary
		var ts time.Time
		if err := rows.Scan(&c.ID, &c.Name, &c.LastMessage, &ts, &c.Unread); err != nil {
			return nil, err
		}
		c.Timestamp = ts.Unix()
		chats = append(chats, c)
	}
	return chats, rows.Err()
}

// MessageRecord is returned by GetMessages.
type MessageRecord struct {
	ID         string `json:"id"`
	From       string `json:"from"`
	SenderName string `json:"senderName,omitempty"`
	Body       string `json:"body"`
	Timestamp  int64  `json:"timestamp"`
	IsFromMe   bool   `json:"isFromMe"`
	HasMedia   bool   `json:"hasMedia"`
	MediaType  string `json:"mediaType,omitempty"`
}

// GetMessages returns messages for a chat, newest first, with sender names resolved.
func (s *MessageStore) GetMessages(chatJID string, limit int, before int64) ([]MessageRecord, error) {
	var rows *sql.Rows
	var err error

	if before > 0 {
		rows, err = s.db.Query(
			`SELECT id, sender, content, timestamp, is_from_me, media_type
			 FROM messages WHERE chat_jid = ? AND timestamp < ?
			 ORDER BY timestamp DESC LIMIT ?`,
			chatJID, time.Unix(before, 0), limit,
		)
	} else {
		rows, err = s.db.Query(
			`SELECT id, sender, content, timestamp, is_from_me, media_type
			 FROM messages WHERE chat_jid = ?
			 ORDER BY timestamp DESC LIMIT ?`,
			chatJID, limit,
		)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []MessageRecord
	senderSet := make(map[string]bool)
	for rows.Next() {
		var m MessageRecord
		var ts time.Time
		var mediaType sql.NullString
		if err := rows.Scan(&m.ID, &m.From, &m.Body, &ts, &m.IsFromMe, &mediaType); err != nil {
			return nil, err
		}
		m.Timestamp = ts.Unix()
		if mediaType.Valid && mediaType.String != "" {
			m.HasMedia = true
			m.MediaType = mediaType.String
		}
		senderSet[m.From] = true
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Resolve sender names in batch
	senders := make([]string, 0, len(senderSet))
	for sender := range senderSet {
		senders = append(senders, sender)
	}
	nameMap := s.GetContactNames(senders)
	for i := range msgs {
		if name, ok := nameMap[msgs[i].From]; ok {
			msgs[i].SenderName = name
		}
	}

	return msgs, nil
}

// ContactRecord is returned by SearchContacts.
type ContactRecord struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Number  string `json:"number"`
	IsGroup bool   `json:"isGroup"`
}

// SearchContacts searches contacts and chats by name or phone number.
func (s *MessageStore) SearchContacts(query string) ([]ContactRecord, error) {
	var pattern string
	if query == "" {
		pattern = "%"
	} else {
		pattern = "%" + query + "%"
	}
	rows, err := s.db.Query(
		`SELECT sub.jid,
			COALESCE(NULLIF(sub.full_name,''), NULLIF(sub.push_name,''), NULLIF(sub.chat_name,''), sub.jid) AS display_name
		FROM (
			SELECT ct.jid, ct.full_name, ct.push_name, COALESCE(ch.name,'') AS chat_name, ch.last_message_time
			FROM contacts ct
			LEFT JOIN chats ch ON ch.jid = ct.jid
			WHERE ct.full_name LIKE ? OR ct.push_name LIKE ? OR ct.jid LIKE ?
			UNION
			SELECT ch.jid, '' AS full_name, '' AS push_name, ch.name AS chat_name, ch.last_message_time
			FROM chats ch
			WHERE ch.jid NOT IN (SELECT jid FROM contacts)
				AND (ch.name LIKE ? OR ch.jid LIKE ?)
		) sub
		ORDER BY sub.last_message_time DESC NULLS LAST
		LIMIT 50`,
		pattern, pattern, pattern, pattern, pattern,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var contacts []ContactRecord
	for rows.Next() {
		var c ContactRecord
		if err := rows.Scan(&c.ID, &c.Name); err != nil {
			return nil, err
		}
		c.IsGroup = len(c.ID) > 0 && c.ID[len(c.ID)-4:] == "g.us"
		if !c.IsGroup {
			for i, ch := range c.ID {
				if ch == '@' {
					c.Number = c.ID[:i]
					break
				}
			}
		}
		contacts = append(contacts, c)
	}
	return contacts, rows.Err()
}

// GetMediaInfo retrieves media metadata for a message.
func (s *MessageStore) GetMediaInfo(messageID string) (mediaType, filename, url string, mediaKey, fileSHA256, fileEncSHA256 []byte, fileLength uint64, err error) {
	err = s.db.QueryRow(
		`SELECT media_type, filename, url, media_key, file_sha256, file_enc_sha256, file_length
		 FROM messages WHERE id = ? AND media_type != '' LIMIT 1`,
		messageID,
	).Scan(&mediaType, &filename, &url, &mediaKey, &fileSHA256, &fileEncSHA256, &fileLength)
	return
}

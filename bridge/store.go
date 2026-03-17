package main

import (
	"database/sql"
	"fmt"
	"os"
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
	`); err != nil {
		db.Close()
		return nil, fmt.Errorf("create tables: %w", err)
	}

	return &MessageStore{db: db}, nil
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
func (s *MessageStore) GetChats() ([]ChatSummary, error) {
	rows, err := s.db.Query(`
		SELECT c.jid, c.name,
			COALESCE((
				SELECT m.content FROM messages m
				WHERE m.chat_jid = c.jid
				ORDER BY m.timestamp DESC LIMIT 1
			), ''),
			c.last_message_time, c.unread_count
		FROM chats c
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
	ID        string `json:"id"`
	From      string `json:"from"`
	Body      string `json:"body"`
	Timestamp int64  `json:"timestamp"`
	IsFromMe  bool   `json:"isFromMe"`
	HasMedia  bool   `json:"hasMedia"`
	MediaType string `json:"mediaType,omitempty"`
}

// GetMessages returns messages for a chat, newest first, with limit and optional before-timestamp filter.
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
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}

// ContactRecord is returned by SearchContacts.
type ContactRecord struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Number  string `json:"number"`
	IsGroup bool   `json:"isGroup"`
}

// SearchContacts searches chats by name (used as a contacts proxy).
// An empty query returns all contacts.
func (s *MessageStore) SearchContacts(query string) ([]ContactRecord, error) {
	var pattern string
	if query == "" {
		pattern = "%"
	} else {
		pattern = "%" + query + "%"
	}
	rows, err := s.db.Query(
		`SELECT jid, name FROM chats WHERE name LIKE ? ORDER BY last_message_time DESC LIMIT 50`,
		pattern,
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
			// Extract number from JID (user@s.whatsapp.net)
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

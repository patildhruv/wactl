package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"

	waProto "go.mau.fi/whatsmeow/binary/proto"
)

// BridgeState holds the runtime state accessible by handlers and API.
type BridgeState struct {
	Client      *whatsmeow.Client
	Store       *MessageStore
	Logger      waLog.Logger
	CallbackURL string
	StartTime   time.Time

	mu sync.Mutex // protects QR state, Connected, LoggedIn, Account

	// QR state
	QRCode    string // raw QR string for encoding to PNG on demand
	QRExpires time.Time

	Connected bool
	LoggedIn  bool
	Account   string // phone number / push name
}

// RegisterEventHandlers wires up all whatsmeow event handlers.
func (b *BridgeState) RegisterEventHandlers() {
	b.Client.AddEventHandler(func(evt interface{}) {
		switch v := evt.(type) {
		case *events.QR:
			b.handleQR(v)
		case *events.PairSuccess:
			b.handlePairSuccess(v)
		case *events.Connected:
			b.handleConnected()
		case *events.LoggedOut:
			b.handleLoggedOut()
		case *events.KeepAliveTimeout:
			b.Logger.Warnf("Keep-alive timeout (auto-reconnect handled by whatsmeow)")
		case *events.StreamReplaced:
			b.handleStreamReplaced()
		case *events.Message:
			b.handleMessage(v)
		case *events.HistorySync:
			b.handleHistorySync(v)
		}
	})
}

func (b *BridgeState) handleQR(evt *events.QR) {
	if len(evt.Codes) > 0 {
		b.mu.Lock()
		b.QRCode = evt.Codes[0]
		b.QRExpires = time.Now().Add(20 * time.Second)
		b.Connected = false
		b.LoggedIn = false
		b.mu.Unlock()
		b.Logger.Infof("QR code updated, expires at %s", b.QRExpires.Format(time.RFC3339))
		b.notifyCallback("qr_ready", map[string]interface{}{
			"expiresAt": b.QRExpires.Unix(),
		})
	}
}

func (b *BridgeState) handlePairSuccess(evt *events.PairSuccess) {
	b.mu.Lock()
	b.QRCode = ""
	b.LoggedIn = true
	b.Account = evt.ID.User
	b.mu.Unlock()
	b.Logger.Infof("Pair success: %s", evt.ID.User)
}

func (b *BridgeState) handleConnected() {
	b.mu.Lock()
	b.Connected = true
	b.LoggedIn = true
	b.QRCode = ""
	if b.Client.Store.ID != nil {
		b.Account = b.Client.Store.ID.User
	}
	account := b.Account
	b.mu.Unlock()
	b.Logger.Infof("Connected to WhatsApp (account: %s)", account)
	b.notifyCallback("connected", map[string]interface{}{
		"account": account,
	})
}

func (b *BridgeState) handleLoggedOut() {
	b.mu.Lock()
	b.Connected = false
	b.LoggedIn = false
	b.Account = ""
	b.mu.Unlock()
	b.Logger.Warnf("Logged out from WhatsApp")
	b.notifyCallback("logged_out", nil)

	// Attempt to get a new QR channel for re-authentication
	go func() {
		time.Sleep(2 * time.Second)
		qrChan, err := b.Client.GetQRChannel(context.Background())
		if err != nil {
			b.Logger.Warnf("Failed to get QR channel after logout: %v", err)
			return
		}
		if err := b.Client.Connect(); err != nil {
			b.Logger.Warnf("Failed to reconnect after logout: %v", err)
			return
		}
		for evt := range qrChan {
			if evt.Event == "code" {
				b.mu.Lock()
				b.QRCode = evt.Code
				b.QRExpires = time.Now().Add(20 * time.Second)
				b.mu.Unlock()
				b.notifyCallback("qr_ready", map[string]interface{}{
					"expiresAt": b.QRExpires.Unix(),
				})
			} else {
				break
			}
		}
	}()
}

func (b *BridgeState) handleStreamReplaced() {
	b.mu.Lock()
	b.Connected = false
	b.mu.Unlock()
	b.Logger.Warnf("Stream replaced — another client took over this session")
	b.notifyCallback("stream_replaced", nil)
}

func (b *BridgeState) handleMessage(msg *events.Message) {
	chatJID := msg.Info.Chat.String()
	sender := msg.Info.Sender.User

	name := resolveChatName(b.Client, b.Store, msg.Info.Chat, chatJID, nil, sender, b.Logger)
	_ = b.Store.UpsertChat(chatJID, name, msg.Info.Timestamp)

	content := extractText(msg.Message)
	mediaType, filename, url, mediaKey, fileSHA256, fileEncSHA256, fileLength := extractMediaInfo(msg.Message)

	if content == "" && mediaType == "" {
		return
	}

	if err := b.Store.StoreMessage(
		msg.Info.ID, chatJID, sender, content, msg.Info.Timestamp, msg.Info.IsFromMe,
		mediaType, filename, url, mediaKey, fileSHA256, fileEncSHA256, fileLength,
	); err != nil {
		b.Logger.Warnf("Store message error: %v", err)
	}

	dir := "←"
	if msg.Info.IsFromMe {
		dir = "→"
	}
	if mediaType != "" {
		b.Logger.Infof("[%s] %s %s: [%s: %s] %s", msg.Info.Timestamp.Format("15:04:05"), dir, sender, mediaType, filename, content)
	} else {
		b.Logger.Infof("[%s] %s %s: %s", msg.Info.Timestamp.Format("15:04:05"), dir, sender, content)
	}

	b.notifyCallback("message", map[string]interface{}{
		"chatJID":   chatJID,
		"sender":    sender,
		"content":   content,
		"timestamp": msg.Info.Timestamp.Unix(),
		"isFromMe":  msg.Info.IsFromMe,
		"mediaType": mediaType,
	})
}

func (b *BridgeState) handleHistorySync(evt *events.HistorySync) {
	count := 0
	for _, conv := range evt.Data.Conversations {
		if conv.ID == nil {
			continue
		}
		chatJID := *conv.ID
		jid, err := types.ParseJID(chatJID)
		if err != nil {
			continue
		}

		name := resolveChatName(b.Client, b.Store, jid, chatJID, conv, "", b.Logger)

		for _, msg := range conv.Messages {
			if msg == nil || msg.Message == nil {
				continue
			}

			var content string
			if msg.Message.Message != nil {
				content = extractText(msg.Message.Message)
			}
			var mType, fname, mURL string
			var mKey, fSHA, fEncSHA []byte
			var fLen uint64
			if msg.Message.Message != nil {
				mType, fname, mURL, mKey, fSHA, fEncSHA, fLen = extractMediaInfo(msg.Message.Message)
			}
			if content == "" && mType == "" {
				continue
			}

			var sender string
			var isFromMe bool
			if msg.Message.Key != nil {
				if msg.Message.Key.FromMe != nil {
					isFromMe = *msg.Message.Key.FromMe
				}
				if !isFromMe && msg.Message.Key.Participant != nil && *msg.Message.Key.Participant != "" {
					sender = *msg.Message.Key.Participant
				} else if isFromMe && b.Client.Store.ID != nil {
					sender = b.Client.Store.ID.User
				} else {
					sender = jid.User
				}
			} else {
				sender = jid.User
			}

			ts := time.Time{}
			if t := msg.Message.GetMessageTimestamp(); t != 0 {
				ts = time.Unix(int64(t), 0)
			} else {
				continue
			}

			msgID := ""
			if msg.Message.Key != nil && msg.Message.Key.ID != nil {
				msgID = *msg.Message.Key.ID
			}

			_ = b.Store.UpsertChat(chatJID, name, ts)
			if err := b.Store.StoreMessage(msgID, chatJID, sender, content, ts, isFromMe, mType, fname, mURL, mKey, fSHA, fEncSHA, fLen); err == nil {
				count++
			}
		}
	}
	b.Logger.Infof("History sync: stored %d messages from %d conversations", count, len(evt.Data.Conversations))
}

// notifyCallback sends an event to the configured callback URL.
func (b *BridgeState) notifyCallback(event string, data map[string]interface{}) {
	if b.CallbackURL == "" {
		return
	}
	payload := map[string]interface{}{
		"event":     event,
		"timestamp": time.Now().Unix(),
	}
	if data != nil {
		for k, v := range data {
			payload[k] = v
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.CallbackURL, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			b.Logger.Warnf("Callback notify failed: %v", err)
			return
		}
		resp.Body.Close()
	}()
}

// --- Helper functions ---

func extractText(msg *waProto.Message) string {
	if msg == nil {
		return ""
	}
	if t := msg.GetConversation(); t != "" {
		return t
	}
	if ext := msg.GetExtendedTextMessage(); ext != nil {
		return ext.GetText()
	}
	return ""
}

func extractMediaInfo(msg *waProto.Message) (mediaType, filename, url string, mediaKey, fileSHA256, fileEncSHA256 []byte, fileLength uint64) {
	if msg == nil {
		return
	}
	ts := time.Now().Format("20060102_150405")
	if img := msg.GetImageMessage(); img != nil {
		return "image", "image_" + ts + ".jpg", img.GetURL(), img.GetMediaKey(), img.GetFileSHA256(), img.GetFileEncSHA256(), img.GetFileLength()
	}
	if vid := msg.GetVideoMessage(); vid != nil {
		return "video", "video_" + ts + ".mp4", vid.GetURL(), vid.GetMediaKey(), vid.GetFileSHA256(), vid.GetFileEncSHA256(), vid.GetFileLength()
	}
	if aud := msg.GetAudioMessage(); aud != nil {
		return "audio", "audio_" + ts + ".ogg", aud.GetURL(), aud.GetMediaKey(), aud.GetFileSHA256(), aud.GetFileEncSHA256(), aud.GetFileLength()
	}
	if doc := msg.GetDocumentMessage(); doc != nil {
		fn := doc.GetFileName()
		if fn == "" {
			fn = "document_" + ts
		}
		return "document", fn, doc.GetURL(), doc.GetMediaKey(), doc.GetFileSHA256(), doc.GetFileEncSHA256(), doc.GetFileLength()
	}
	return
}

// resolveChatName determines a human-readable name for a chat.
func resolveChatName(client *whatsmeow.Client, store *MessageStore, jid types.JID, chatJID string, conversation interface{}, sender string, logger waLog.Logger) string {
	// Check existing name in DB
	var existing string
	if err := store.db.QueryRow("SELECT name FROM chats WHERE jid = ?", chatJID).Scan(&existing); err == nil && existing != "" {
		return existing
	}

	if jid.Server == "g.us" {
		// Group chat — try to extract name from conversation protobuf
		if conversation != nil {
			if conv, ok := conversation.(*waProto.Conversation); ok && conv != nil {
				if dn := conv.GetDisplayName(); dn != "" {
					return dn
				}
				if n := conv.GetName(); n != "" {
					return n
				}
			}
		}
		info, err := client.GetGroupInfo(context.Background(), jid)
		if err == nil && info.Name != "" {
			return info.Name
		}
		return fmt.Sprintf("Group %s", jid.User)
	}

	// Individual contact
	contact, err := client.Store.Contacts.GetContact(context.Background(), jid)
	if err == nil && contact.FullName != "" {
		return contact.FullName
	}
	if sender != "" {
		return sender
	}
	return jid.User
}

// mediaTypeToWA converts our string media type to whatsmeow MediaType.
func mediaTypeToWA(t string) whatsmeow.MediaType {
	switch t {
	case "image":
		return whatsmeow.MediaImage
	case "video":
		return whatsmeow.MediaVideo
	case "audio":
		return whatsmeow.MediaAudio
	default:
		return whatsmeow.MediaDocument
	}
}

// mimeForExt returns the MIME type and whatsmeow MediaType for a file extension.
func mimeForExt(ext string) (string, whatsmeow.MediaType) {
	ext = strings.ToLower(ext)
	switch ext {
	case "jpg", "jpeg":
		return "image/jpeg", whatsmeow.MediaImage
	case "png":
		return "image/png", whatsmeow.MediaImage
	case "gif":
		return "image/gif", whatsmeow.MediaImage
	case "webp":
		return "image/webp", whatsmeow.MediaImage
	case "ogg":
		return "audio/ogg; codecs=opus", whatsmeow.MediaAudio
	case "mp3":
		return "audio/mpeg", whatsmeow.MediaAudio
	case "mp4":
		return "video/mp4", whatsmeow.MediaVideo
	case "mov":
		return "video/quicktime", whatsmeow.MediaVideo
	case "avi":
		return "video/avi", whatsmeow.MediaVideo
	case "pdf":
		return "application/pdf", whatsmeow.MediaDocument
	default:
		return "application/octet-stream", whatsmeow.MediaDocument
	}
}

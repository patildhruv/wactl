package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
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

	// qrNotified gates the "qr_ready" callback to one push per pairing episode.
	// whatsmeow rotates codes every 20s and runQRLoop re-arms forever, so
	// notifying per code would spam ntfy. The process exits once a session is
	// deleted, making "once per process" exactly once per episode.
	qrNotified bool

	// Resolver maps @lid ↔ @s.whatsapp.net JIDs using whatsmeow's lid_map table.
	// Nil when session.db has not yet been opened (e.g., first-run QR pairing).
	Resolver *LIDResolver
}

// RegisterEventHandlers wires up all whatsmeow event handlers.
func (b *BridgeState) RegisterEventHandlers() {
	// *events.QR is deliberately not handled here: whatsmeow's QR channel
	// (see runQRLoop) consumes the same event and is the single source of truth
	// for QR state. Handling both raced to set QRExpires.
	b.Client.AddEventHandler(func(evt interface{}) {
		switch v := evt.(type) {
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

// setQR publishes a code for the /qr endpoint. timeout is whatsmeow's own
// validity window for this specific code — 60s for the first of a batch, 20s for
// each one after. Trusting it stops /qr from reporting a still-scannable code as
// expired, which a hardcoded 20s did for the first 40 seconds of every pairing.
func (b *BridgeState) setQR(code string, timeout time.Duration) {
	b.mu.Lock()
	b.QRCode = code
	b.QRExpires = time.Now().Add(timeout)
	b.Connected = false
	b.LoggedIn = false
	expires := b.QRExpires
	notify := !b.qrNotified
	b.qrNotified = true
	b.mu.Unlock()

	b.Logger.Infof("QR code updated, expires at %s", expires.Format(time.RFC3339))
	if notify {
		b.notifyCallback("qr_ready", map[string]interface{}{
			"expiresAt": expires.Unix(),
		})
	}
}

func (b *BridgeState) clearQR() {
	b.mu.Lock()
	b.QRCode = ""
	b.QRExpires = time.Time{}
	b.mu.Unlock()
}

// runQRLoop drives QR pairing until it succeeds.
//
// whatsmeow hands out a batch of ~6 codes (the first valid 60s, the rest 20s
// each), then closes the channel with a "timeout" event and disconnects the
// socket. A single pass therefore leaves /qr dead after roughly 2.5 minutes,
// with no way back short of restarting the process. Re-arming a fresh channel on
// every non-success outcome keeps a scannable code on the admin panel for as
// long as the device stays unpaired.
func (b *BridgeState) runQRLoop(ctx context.Context) {
	const retryDelay = 5 * time.Second

	// whatsmeow's QR emitter returns without closing the channel when the client
	// is expected to disconnect (a stream error, say), so ranging it to
	// completion can block forever. Codes arrive at most 60s apart, so silence
	// well past that means the batch died quietly and we should re-arm.
	const silenceTimeout = 2 * time.Minute

	for ctx.Err() == nil {
		// Check before disconnecting: pairing can complete via an event rather
		// than a "success" on the channel (e.g. the batch closes on *events.
		// Disconnected right as PairSuccess lands). Tearing the socket down here
		// would strand a freshly paired client offline.
		if b.Client.Store.ID != nil {
			b.Logger.Infof("Device is paired, stopping QR loop")
			return
		}

		// GetQRChannel refuses to run while the socket is up, and whatsmeow leaves
		// it connected after some terminal events.
		b.Client.Disconnect()

		qrChan, err := b.Client.GetQRChannel(ctx)
		if err != nil {
			if errors.Is(err, whatsmeow.ErrQRStoreContainsID) {
				// Paired between the check above and here. Restore the socket we
				// just closed and hand off to the normal reconnect path.
				b.Logger.Infof("Device paired while re-arming, stopping QR loop")
				if cerr := b.Client.Connect(); cerr != nil {
					b.Logger.Warnf("Failed to reconnect after pairing: %v", cerr)
				}
				return
			}
			b.Logger.Warnf("Failed to get QR channel: %v (retrying in %s)", err, retryDelay)
			sleepCtx(ctx, retryDelay)
			continue
		}

		if err := b.Client.Connect(); err != nil {
			b.Logger.Warnf("Failed to connect for QR pairing: %v (retrying in %s)", err, retryDelay)
			sleepCtx(ctx, retryDelay)
			continue
		}

		// The channel is buffered and whatsmeow normally closes it after a terminal
		// event, so draining it also releases the emitter goroutine. The last
		// non-code event is the outcome; the watchdog covers the paths where the
		// emitter bails without closing.
		var outcome string
		var pairErr error
	drain:
		for {
			select {
			case evt, ok := <-qrChan:
				if !ok {
					break drain
				}
				if evt.Event == whatsmeow.QRChannelEventCode {
					b.setQR(evt.Code, evt.Timeout)
					continue
				}
				outcome, pairErr = evt.Event, evt.Error
			case <-time.After(silenceTimeout):
				b.Logger.Warnf("QR channel went silent for %s without closing, re-arming", silenceTimeout)
				outcome = ""
				break drain
			case <-ctx.Done():
				return
			}
		}
		b.clearQR()

		switch outcome {
		case whatsmeow.QRChannelSuccess.Event:
			b.Logger.Infof("QR pairing successful")
			return
		case whatsmeow.QRChannelClientOutdated.Event:
			b.Logger.Errorf("whatsmeow is too old for WhatsApp's pairing protocol; upgrade the bridge")
			return
		case whatsmeow.QRChannelTimeout.Event, whatsmeow.QRChannelErrUnexpectedEvent.Event, "":
			b.Logger.Infof("QR batch expired without a scan, requesting a new one")
		default:
			b.Logger.Warnf("QR pairing ended with %q (%v), retrying", outcome, pairErr)
			sleepCtx(ctx, retryDelay)
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// restartForFreshDevice exits so the supervisor can bring the bridge back up.
//
// Once WhatsApp removes the device (or the operator logs out), whatsmeow calls
// store.Device.Delete(), which sets Deleted and swaps every session store for a
// no-op. From that point Connect() short-circuits to store.ErrDeviceDeleted
// forever, so this client can never re-pair — a new Device has to come from the
// container. Rather than swap b.Client out from under every in-flight handler,
// exit: the unit is Restart=always, and main() creates a fresh device and enters
// runQRLoop on the way back up.
func (b *BridgeState) restartForFreshDevice(reason string) {
	go func() {
		// Give notifyCallback's POST (and any in-flight HTTP response) time to land.
		time.Sleep(2 * time.Second)
		b.Logger.Warnf("%s; exiting so the supervisor can restart with a fresh device", reason)
		os.Exit(0)
	}()
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
	go b.SyncContacts()
	b.notifyCallback("connected", map[string]interface{}{
		"account": account,
	})
}

func (b *BridgeState) handleLoggedOut() {
	b.mu.Lock()
	b.Connected = false
	b.LoggedIn = false
	b.Account = ""
	b.QRCode = ""
	b.mu.Unlock()
	b.Logger.Warnf("Logged out from WhatsApp")
	b.notifyCallback("logged_out", nil)

	// whatsmeow has already deleted the device by the time this fires, so
	// re-pairing on this client is impossible. Restart into a fresh one.
	b.restartForFreshDevice("Session deleted by WhatsApp")
}

func (b *BridgeState) handleStreamReplaced() {
	b.mu.Lock()
	b.Connected = false
	b.mu.Unlock()
	b.Logger.Warnf("Stream replaced — another client took over this session")
	b.notifyCallback("stream_replaced", nil)
}

func (b *BridgeState) handleMessage(msg *events.Message) {
	// Normalize @lid → @s.whatsapp.net so 1:1 history unifies under phone JIDs.
	chatJID := b.Resolver.Normalize(msg.Info.Chat)
	senderJID := b.Resolver.Normalize(msg.Info.Sender)
	chatJIDStr := chatJID.String()
	sender := senderJID.User

	// Capture sender's push name
	if msg.Info.PushName != "" && !msg.Info.IsFromMe {
		_ = b.Store.UpsertContact(senderJID.String(), msg.Info.PushName, "")
	}

	name := resolveChatName(b.Client, b.Store, chatJID, chatJIDStr, nil, sender, b.Logger)
	_ = b.Store.UpsertChat(chatJIDStr, name, msg.Info.Timestamp)

	content := extractText(msg.Message)
	mediaType, filename, url, mediaKey, fileSHA256, fileEncSHA256, fileLength := extractMediaInfo(msg.Message)
	quotedID := extractQuotedID(msg.Message)

	if content == "" && mediaType == "" {
		return
	}

	if err := b.Store.StoreMessage(
		msg.Info.ID, chatJIDStr, sender, content, msg.Info.Timestamp, msg.Info.IsFromMe,
		mediaType, filename, url, mediaKey, fileSHA256, fileEncSHA256, fileLength, quotedID,
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
		"chatJID":   chatJIDStr,
		"sender":    sender,
		"content":   content,
		"timestamp": msg.Info.Timestamp.Unix(),
		"isFromMe":  msg.Info.IsFromMe,
		"mediaType": mediaType,
	})
}

func (b *BridgeState) handleHistorySync(evt *events.HistorySync) {
	syncType := ""
	if evt.Data != nil && evt.Data.SyncType != nil {
		syncType = evt.Data.SyncType.String()
	}
	b.Logger.Infof("HistorySync received: type=%s conversations=%d", syncType, len(evt.Data.GetConversations()))
	count := 0
	for _, conv := range evt.Data.Conversations {
		if conv.ID == nil {
			continue
		}
		jid, err := types.ParseJID(*conv.ID)
		if err != nil {
			continue
		}
		// Normalize @lid chats so history merges with the phone-JID conversation.
		jid = b.Resolver.Normalize(jid)
		chatJID := jid.String()
		b.Logger.Infof("HistorySync conv: id=%s rawMessages=%d", chatJID, len(conv.Messages))

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
			sender = b.Resolver.NormalizeUser(sender)

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

			quotedID := ""
			if msg.Message.Message != nil {
				quotedID = extractQuotedID(msg.Message.Message)
			}
			_ = b.Store.UpsertChat(chatJID, name, ts)
			if err := b.Store.StoreMessage(msgID, chatJID, sender, content, ts, isFromMe, mType, fname, mURL, mKey, fSHA, fEncSHA, fLen, quotedID); err == nil {
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
	// Captions ride on the media message itself, not in a wrapper. Without
	// these, image/video/document messages land with body="" and the LLM has
	// no idea what the sender said alongside the attachment.
	if img := msg.GetImageMessage(); img != nil {
		if c := img.GetCaption(); c != "" {
			return c
		}
	}
	if vid := msg.GetVideoMessage(); vid != nil {
		if c := vid.GetCaption(); c != "" {
			return c
		}
	}
	if doc := msg.GetDocumentMessage(); doc != nil {
		if c := doc.GetCaption(); c != "" {
			return c
		}
	}
	return ""
}

// extractQuotedID pulls the stanza ID of the message being replied to, if any.
// whatsmeow stores context info on every message type that can carry a reply
// (extended text, image, video, audio, document). Empty string when not a reply.
func extractQuotedID(msg *waProto.Message) string {
	if msg == nil {
		return ""
	}
	if ext := msg.GetExtendedTextMessage(); ext != nil {
		if ctx := ext.GetContextInfo(); ctx != nil {
			return ctx.GetStanzaID()
		}
	}
	if img := msg.GetImageMessage(); img != nil {
		if ctx := img.GetContextInfo(); ctx != nil {
			return ctx.GetStanzaID()
		}
	}
	if vid := msg.GetVideoMessage(); vid != nil {
		if ctx := vid.GetContextInfo(); ctx != nil {
			return ctx.GetStanzaID()
		}
	}
	if aud := msg.GetAudioMessage(); aud != nil {
		if ctx := aud.GetContextInfo(); ctx != nil {
			return ctx.GetStanzaID()
		}
	}
	if doc := msg.GetDocumentMessage(); doc != nil {
		if ctx := doc.GetContextInfo(); ctx != nil {
			return ctx.GetStanzaID()
		}
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

// SyncContacts reads all contacts from whatsmeow's local store and persists them.
// JIDs are normalized to @s.whatsapp.net via the LID resolver so rows line up
// with the (normalized) chat/message storage keys.
func (b *BridgeState) SyncContacts() {
	contacts, err := b.Client.Store.Contacts.GetAllContacts(context.Background())
	if err != nil {
		b.Logger.Warnf("Failed to get contacts: %v", err)
		return
	}
	entries := make([]ContactEntry, 0, len(contacts))
	for jid, contact := range contacts {
		if contact.FullName == "" && contact.PushName == "" {
			continue
		}
		normalized := b.Resolver.Normalize(jid)
		entries = append(entries, ContactEntry{
			JID:      normalized.String(),
			PushName: contact.PushName,
			FullName: contact.FullName,
		})
	}
	if err := b.Store.BulkUpsertContacts(entries); err != nil {
		b.Logger.Warnf("BulkUpsertContacts error: %v", err)
		return
	}
	b.Logger.Infof("Synced %d contacts from whatsmeow store", len(entries))
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

	// Individual contact — check our contacts table first
	if name := store.GetContactName(chatJID); name != "" {
		return name
	}

	// Fall back to whatsmeow contact store
	contact, err := client.Store.Contacts.GetContact(context.Background(), jid)
	if err == nil {
		if contact.FullName != "" {
			_ = store.UpsertContact(chatJID, contact.PushName, contact.FullName)
			return contact.FullName
		}
		if contact.PushName != "" {
			_ = store.UpsertContact(chatJID, contact.PushName, "")
			return contact.PushName
		}
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

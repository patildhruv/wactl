package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	waProto "go.mau.fi/whatsmeow/binary/proto"
)

// StartAPI registers HTTP routes and starts the bridge API server.
func (b *BridgeState) StartAPI(port int) {
	mux := http.NewServeMux()

	mux.HandleFunc("/status", b.handleStatus)
	mux.HandleFunc("/qr", b.handleQREndpoint)
	mux.HandleFunc("/chats", b.handleChats)
	mux.HandleFunc("/contacts", b.handleContacts)
	mux.HandleFunc("/send", b.handleSend)
	mux.HandleFunc("/send-file", b.handleSendFile)
	mux.HandleFunc("/logout", b.handleLogout)

	// Pattern-based routes
	mux.HandleFunc("/chats/", b.handleChatMessages)
	mux.HandleFunc("/media/", b.handleMedia)

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	b.Logger.Infof("Bridge API listening on %s", addr)

	go func() {
		if err := http.ListenAndServe(addr, mux); err != nil {
			b.Logger.Errorf("API server error: %v", err)
		}
	}()
}

func jsonResp(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func jsonErr(w http.ResponseWriter, status int, msg string) {
	jsonResp(w, status, map[string]string{"error": msg})
}

// GET /status
func (b *BridgeState) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	uptime := int(time.Since(b.StartTime).Seconds())
	jsonResp(w, http.StatusOK, map[string]interface{}{
		"connected": b.Connected,
		"loggedIn":  b.LoggedIn,
		"uptime":    uptime,
		"account":   b.Account,
	})
}

// GET /qr
func (b *BridgeState) handleQREndpoint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	if b.QRCode == "" || time.Now().After(b.QRExpires) {
		jsonResp(w, http.StatusOK, map[string]interface{}{
			"qr":        nil,
			"expiresAt": nil,
		})
		return
	}

	// Generate base64 PNG from QR code string
	png, err := qrcode.Encode(b.QRCode, qrcode.Medium, 512)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, "failed to generate QR PNG")
		return
	}
	b64 := base64.StdEncoding.EncodeToString(png)

	jsonResp(w, http.StatusOK, map[string]interface{}{
		"qr":        b64,
		"expiresAt": b.QRExpires.Unix(),
	})
}

// GET /chats
func (b *BridgeState) handleChats(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	chats, err := b.Store.GetChats()
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if chats == nil {
		chats = []ChatSummary{}
	}
	jsonResp(w, http.StatusOK, chats)
}

// GET /chats/:id/messages
func (b *BridgeState) handleChatMessages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// Parse chat ID from path: /chats/{id}/messages
	path := strings.TrimPrefix(r.URL.Path, "/chats/")
	parts := strings.SplitN(path, "/", 2)
	if len(parts) < 2 || parts[1] != "messages" {
		jsonErr(w, http.StatusBadRequest, "invalid path, expected /chats/:id/messages")
		return
	}
	chatID := parts[0]

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	var before int64
	if b := r.URL.Query().Get("before"); b != "" {
		if n, err := strconv.ParseInt(b, 10, 64); err == nil {
			before = n
		}
	}

	msgs, err := b.Store.GetMessages(chatID, limit, before)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if msgs == nil {
		msgs = []MessageRecord{}
	}
	jsonResp(w, http.StatusOK, msgs)
}

// GET /contacts?q=searchterm
func (b *BridgeState) handleContacts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	query := r.URL.Query().Get("q")
	if query == "" {
		query = "%"
	}
	contacts, err := b.Store.SearchContacts(query)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if contacts == nil {
		contacts = []ContactRecord{}
	}
	jsonResp(w, http.StatusOK, contacts)
}

// POST /send
func (b *BridgeState) handleSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		To   string `json:"to"`
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.To == "" || body.Body == "" {
		jsonErr(w, http.StatusBadRequest, "to and body are required")
		return
	}
	if !b.Client.IsConnected() {
		jsonErr(w, http.StatusServiceUnavailable, "not connected to WhatsApp")
		return
	}

	jid, err := parseRecipient(body.To)
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}

	msg := &waProto.Message{
		Conversation: proto.String(body.Body),
	}
	resp, err := b.Client.SendMessage(context.Background(), jid, msg)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, fmt.Sprintf("send failed: %v", err))
		return
	}

	jsonResp(w, http.StatusOK, map[string]interface{}{
		"messageId": resp.ID,
		"timestamp": resp.Timestamp.Unix(),
	})
}

// POST /send-file (multipart: to, file, caption)
func (b *BridgeState) handleSendFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !b.Client.IsConnected() {
		jsonErr(w, http.StatusServiceUnavailable, "not connected to WhatsApp")
		return
	}

	if err := r.ParseMultipartForm(32 << 20); err != nil { // 32MB max
		jsonErr(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	to := r.FormValue("to")
	caption := r.FormValue("caption")
	if to == "" {
		jsonErr(w, http.StatusBadRequest, "to is required")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		jsonErr(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, "failed to read file")
		return
	}

	jid, err := parseRecipient(to)
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}

	ext := filepath.Ext(header.Filename)
	if len(ext) > 0 {
		ext = ext[1:] // strip leading dot
	}
	mime, mediaType := mimeForExt(ext)

	uploaded, err := b.Client.Upload(context.Background(), data, mediaType)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, fmt.Sprintf("upload failed: %v", err))
		return
	}

	msg := buildMediaMessage(caption, mime, header.Filename, mediaType, uploaded)
	resp, err := b.Client.SendMessage(context.Background(), jid, msg)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, fmt.Sprintf("send failed: %v", err))
		return
	}

	jsonResp(w, http.StatusOK, map[string]interface{}{
		"messageId": resp.ID,
		"timestamp": resp.Timestamp.Unix(),
	})
}

// GET /media/:messageId
func (b *BridgeState) handleMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	messageID := strings.TrimPrefix(r.URL.Path, "/media/")
	if messageID == "" {
		jsonErr(w, http.StatusBadRequest, "messageId is required")
		return
	}

	mediaType, filename, url, mediaKey, fileSHA256, fileEncSHA256, fileLength, err := b.Store.GetMediaInfo(messageID)
	if err != nil {
		jsonErr(w, http.StatusNotFound, "media not found")
		return
	}

	// Check data dir for cached file
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}
	cacheDir := filepath.Join(dataDir, "media")
	cachedPath := filepath.Join(cacheDir, messageID+"_"+filename)

	if fileData, err := os.ReadFile(cachedPath); err == nil {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(fileData)
		return
	}

	if url == "" || len(mediaKey) == 0 {
		jsonErr(w, http.StatusBadRequest, "incomplete media metadata")
		return
	}

	waType := mediaTypeToWA(mediaType)
	directPath := extractDirectPath(url)

	dl := &mediaDownloader{
		url: url, directPath: directPath, mediaKey: mediaKey,
		fileLength: fileLength, fileSHA256: fileSHA256,
		fileEncSHA256: fileEncSHA256, mediaType: waType,
	}
	data, err := b.Client.Download(context.Background(), dl)
	if err != nil {
		jsonErr(w, http.StatusInternalServerError, fmt.Sprintf("download failed: %v", err))
		return
	}

	// Cache the file
	os.MkdirAll(cacheDir, 0755)
	os.WriteFile(cachedPath, data, 0644)

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(data)
}

// POST /logout
func (b *BridgeState) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	b.Client.Logout(context.Background())
	b.Connected = false
	b.LoggedIn = false
	b.Account = ""
	jsonResp(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- Internal helpers ---

func parseRecipient(recipient string) (types.JID, error) {
	if strings.Contains(recipient, "@") {
		return types.ParseJID(recipient)
	}
	return types.JID{
		User:   recipient,
		Server: "s.whatsapp.net",
	}, nil
}

func buildMediaMessage(caption, mime, filename string, mediaType whatsmeow.MediaType, resp whatsmeow.UploadResponse) *waProto.Message {
	msg := &waProto.Message{}
	switch mediaType {
	case whatsmeow.MediaImage:
		msg.ImageMessage = &waProto.ImageMessage{
			Caption:       proto.String(caption),
			Mimetype:      proto.String(mime),
			URL:           &resp.URL,
			DirectPath:    &resp.DirectPath,
			MediaKey:      resp.MediaKey,
			FileEncSHA256: resp.FileEncSHA256,
			FileSHA256:    resp.FileSHA256,
			FileLength:    &resp.FileLength,
		}
	case whatsmeow.MediaVideo:
		msg.VideoMessage = &waProto.VideoMessage{
			Caption:       proto.String(caption),
			Mimetype:      proto.String(mime),
			URL:           &resp.URL,
			DirectPath:    &resp.DirectPath,
			MediaKey:      resp.MediaKey,
			FileEncSHA256: resp.FileEncSHA256,
			FileSHA256:    resp.FileSHA256,
			FileLength:    &resp.FileLength,
		}
	case whatsmeow.MediaAudio:
		msg.AudioMessage = &waProto.AudioMessage{
			Mimetype:      proto.String(mime),
			URL:           &resp.URL,
			DirectPath:    &resp.DirectPath,
			MediaKey:      resp.MediaKey,
			FileEncSHA256: resp.FileEncSHA256,
			FileSHA256:    resp.FileSHA256,
			FileLength:    &resp.FileLength,
		}
	default:
		msg.DocumentMessage = &waProto.DocumentMessage{
			Title:         proto.String(filename),
			Caption:       proto.String(caption),
			Mimetype:      proto.String(mime),
			URL:           &resp.URL,
			DirectPath:    &resp.DirectPath,
			MediaKey:      resp.MediaKey,
			FileEncSHA256: resp.FileEncSHA256,
			FileSHA256:    resp.FileSHA256,
			FileLength:    &resp.FileLength,
		}
	}
	return msg
}

func extractDirectPath(url string) string {
	parts := strings.SplitN(url, ".net/", 2)
	if len(parts) < 2 {
		return url
	}
	path := strings.SplitN(parts[1], "?", 2)[0]
	return "/" + path
}

// mediaDownloader implements whatsmeow's DownloadableMessage interface.
type mediaDownloader struct {
	url           string
	directPath    string
	mediaKey      []byte
	fileLength    uint64
	fileSHA256    []byte
	fileEncSHA256 []byte
	mediaType     whatsmeow.MediaType
}

func (d *mediaDownloader) GetDirectPath() string        { return d.directPath }
func (d *mediaDownloader) GetURL() string               { return d.url }
func (d *mediaDownloader) GetMediaKey() []byte           { return d.mediaKey }
func (d *mediaDownloader) GetFileLength() uint64         { return d.fileLength }
func (d *mediaDownloader) GetFileSHA256() []byte         { return d.fileSHA256 }
func (d *mediaDownloader) GetFileEncSHA256() []byte      { return d.fileEncSHA256 }
func (d *mediaDownloader) GetMediaType() whatsmeow.MediaType { return d.mediaType }

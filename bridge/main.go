package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func main() {
	logger := waLog.Stdout("Bridge", "INFO", true)
	logger.Infof("Starting wactl-bridge...")

	dataDir := envOrDefault("DATA_DIR", "./data")
	port := envIntOrDefault("BRIDGE_PORT", 4000)
	callbackURL := os.Getenv("CALLBACK_URL")

	// Initialize session store (whatsmeow)
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		logger.Errorf("Failed to create data directory: %v", err)
		os.Exit(1)
	}

	dbLog := waLog.Stdout("Database", "WARN", true)
	sessionDB := fmt.Sprintf("file:%s/session.db?_foreign_keys=on", dataDir)
	container, err := sqlstore.New(context.Background(), "sqlite3", sessionDB, dbLog)
	if err != nil {
		logger.Errorf("Failed to open session database: %v", err)
		os.Exit(1)
	}

	device, err := container.GetFirstDevice(context.Background())
	if err != nil {
		if err == sql.ErrNoRows {
			device = container.NewDevice()
			logger.Infof("Created new device")
		} else {
			logger.Errorf("Failed to get device: %v", err)
			os.Exit(1)
		}
	}

	client := whatsmeow.NewClient(device, waLog.Stdout("WhatsApp", "INFO", true))
	if client == nil {
		logger.Errorf("Failed to create WhatsApp client")
		os.Exit(1)
	}

	// Initialize message store
	msgStore, err := NewMessageStore(dataDir)
	if err != nil {
		logger.Errorf("Failed to initialize message store: %v", err)
		os.Exit(1)
	}
	defer msgStore.Close()

	// Build bridge state
	bridge := &BridgeState{
		Client:      client,
		Store:       msgStore,
		Logger:      logger,
		CallbackURL: callbackURL,
		StartTime:   time.Now(),
	}

	// Register event handlers
	bridge.RegisterEventHandlers()

	// Connect to WhatsApp
	if client.Store.ID == nil {
		// New device — need QR pairing
		logger.Infof("No existing session, waiting for QR scan...")
		qrChan, err := client.GetQRChannel(context.Background())
		if err != nil {
			logger.Errorf("Failed to get QR channel: %v", err)
			os.Exit(1)
		}
		if err := client.Connect(); err != nil {
			logger.Errorf("Failed to connect: %v", err)
			os.Exit(1)
		}

		// Process QR events - the event handler will also capture these
		go func() {
			for evt := range qrChan {
				if evt.Event == "code" {
					bridge.mu.Lock()
					bridge.QRCode = evt.Code
					bridge.QRExpires = time.Now().Add(20 * time.Second)
					bridge.mu.Unlock()
					logger.Infof("QR code ready (scan via admin panel or /qr endpoint)")
				} else if evt.Event == "success" {
					logger.Infof("QR pairing successful")
					break
				}
			}
		}()
	} else {
		// Existing session — just connect
		if err := client.Connect(); err != nil {
			logger.Errorf("Failed to connect: %v", err)
			os.Exit(1)
		}
		bridge.mu.Lock()
		bridge.Connected = true
		bridge.LoggedIn = true
		if client.Store.ID != nil {
			bridge.Account = client.Store.ID.User
		}
		bridge.mu.Unlock()
		logger.Infof("Reconnected with existing session (account: %s)", bridge.Account)
		go bridge.SyncContacts()
	}

	// Start HTTP API
	httpServer := bridge.StartAPI(port)

	// Wait for shutdown signal
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	logger.Infof("Bridge running. Press Ctrl+C to stop.")
	<-sig

	logger.Infof("Shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		logger.Warnf("HTTP server shutdown error: %v", err)
	}
	client.Disconnect()
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envIntOrDefault(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

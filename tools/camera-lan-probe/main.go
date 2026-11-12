package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	tuyalan "github.com/luukvisser/tuya-lan"
)

type cameraConfig struct {
	DeviceID    string `json:"device_id"`
	Host        string `json:"host"`
	Version     string `json:"version"`
	LocalKey    string `json:"local_key"`
	P2PPassword string `json:"p2p_password"`
	UID         string `json:"uid"`
}

type measurement struct {
	mu            sync.Mutex
	Packets       int     `json:"video_packets"`
	Bytes         int     `json:"video_bytes"`
	Frames        int     `json:"video_timestamps"`
	Width         int     `json:"width"`
	Height        int     `json:"height"`
	Seconds       float64 `json:"video_span_seconds"`
	first         time.Time
	lastTimestamp uint64
}

func (m *measurement) record(frame *tuyalan.VideoFrame) {
	if len(frame.NAL) == 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if m.Packets == 0 {
		m.first = now
	}
	if m.Packets == 0 || frame.Timestamp != m.lastTimestamp {
		m.Frames++
	}
	m.lastTimestamp = frame.Timestamp
	m.Packets++
	m.Bytes += len(frame.NAL)
	if frame.Width > 0 && frame.Height > 0 {
		m.Width, m.Height = frame.Width, frame.Height
	}
	m.Seconds = now.Sub(m.first).Seconds()
}

func (m *measurement) passed() bool {
	return m.Packets >= 10 && m.Frames >= 5 && m.Width > 0 && m.Height > 0 && m.Seconds >= 5
}

func loadConfig(path string, handshakeOnly bool) (cameraConfig, error) {
	var config cameraConfig
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return config, errors.New("config must be a private regular file with mode 0600")
	}
	file, err := os.Open(path)
	if err != nil {
		return config, errors.New("cannot open camera config")
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, errors.New("invalid camera config JSON")
	}
	address, err := netip.ParseAddr(config.Host)
	if err != nil || !address.IsPrivate() || !address.Is4() {
		return config, errors.New("host must be a private IPv4 address")
	}
	if config.DeviceID == "" || len(config.LocalKey) != 16 || config.Version == "" {
		return config, errors.New("device_id, a 16-byte local_key, and version are required")
	}
	if !handshakeOnly && (config.P2PPassword == "" || config.UID == "") {
		return config, errors.New("streaming requires the camera P2P password and user ID")
	}
	return config, nil
}

func probe(config cameraConfig, handshakeOnly bool, duration time.Duration) (map[string]any, error) {
	version, err := tuyalan.ParseVersion(config.Version)
	if err != nil || version == 0 {
		return nil, errors.New("select an explicit camera protocol version")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	result := map[string]any{"host": config.Host, "version": config.Version, "passed": false}
	if handshakeOnly {
		result["phase"] = "authenticated_lan_handshake"
		session, err := tuyalan.Dial(startup, tuyalan.DialConfig{
			Addr: config.Host, DeviceID: config.DeviceID, LocalKey: config.LocalKey, Version: version,
		})
		if err != nil {
			return result, err
		}
		defer session.Close()
		result["passed"] = true
		return result, nil
	}
	result["phase"] = "local_video"
	video := &measurement{}
	client := tuyalan.NewClient(config.DeviceID, config.LocalKey, config.P2PPassword, config.UID,
		[]string{config.Host}, []tuyalan.Version{version}, video.record, nil)
	ended := make(chan error, 1)
	client.OnError = func(err error) {
		select {
		case ended <- err:
		default:
		}
	}
	defer client.Close()
	if err := client.Start(startup); err != nil {
		result["phase"] = "local_stream_start"
		return result, err
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case err = <-ended:
	case <-ctx.Done():
		err = ctx.Err()
	case <-timer.C:
	}
	client.Close()
	video.mu.Lock()
	defer video.mu.Unlock()
	result["video"] = video
	result["passed"] = err == nil && video.passed()
	if err == nil && !video.passed() {
		err = errors.New("no sustained video received")
	}
	return result, err
}

func main() {
	path := flag.String("config", "/run/secrets/camera.json", "private camera config file")
	handshakeOnly := flag.Bool("handshake-only", false, "authenticate on LAN without requesting video")
	duration := flag.Duration("duration", 20*time.Second, "video observation period, minimum 10 seconds")
	flag.Parse()
	if *duration < 10*time.Second || *duration > 5*time.Minute {
		fmt.Fprintln(os.Stderr, "duration must be between 10 seconds and 5 minutes")
		os.Exit(2)
	}
	config, err := loadConfig(*path, *handshakeOnly)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	result, err := probe(config, *handshakeOnly, *duration)
	if result == nil {
		result = map[string]any{"passed": false}
	}
	if err != nil {
		message := err.Error()
		for _, secret := range []string{config.LocalKey, config.P2PPassword, config.UID, config.DeviceID} {
			if secret != "" {
				message = strings.ReplaceAll(message, secret, "[redacted]")
			}
		}
		result["error"] = message
	}
	if json.NewEncoder(os.Stdout).Encode(result) != nil || err != nil {
		os.Exit(1)
	}
}

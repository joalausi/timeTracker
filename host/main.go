package main

import (
	"bufio"
	"path/filepath"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"
)

const Max = 1024 * 1024

func readMsg(r io.Reader) ([]byte, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(lenBuf[:])
	if n == 0 || n > Max {
		return nil, fmt.Errorf("bad length: %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func writeMsg(w io.Writer, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(b)))
	if _, err := w.Write(lenBuf[:]); err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

func eventsPath() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(exePath), "events.jsonl"), nil
}

func appendJSONL(path string, payload any) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()

	w := bufio.NewWriter(f)
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := w.Write(b); err != nil {
		return err
	}
	if err := w.WriteByte('\n'); err != nil {
		return err
	}
	return w.Flush()
}

func toInt(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case int64:
		return n, true
	case int:
		return int64(n), true
	default:
		return 0, false
	}
}

func validateEvent(payload map[string]any) error {
	name, ok := payload["name"].(string)
	if !ok || name == "" {
		return fmt.Errorf("missing/invalid event name")
	}

	allowed := map[string]bool{
		"tab_activated":        true,
		"tab_updated":          true,
		"window_focus_changed": true,
		"idle_state_changed":   true,
	}
	if !allowed[name] {
		return fmt.Errorf("unsupported event name: %s", name)
	}

	if _, ok := toInt(payload["ts"]); !ok {
		return fmt.Errorf("missing/invalid event ts")
	}

	if url, ok := payload["url"]; ok && url != nil {
		if _, ok := url.(string); !ok {
			return fmt.Errorf("invalid url")
		}
	}

	return nil
}

func handleMessage(msg []byte, eventsFile string) map[string]any {
	var payload map[string]any
	if err := json.Unmarshal(msg, &payload); err != nil {
		return map[string]any{
			"ok":    false,
			"error": "invalid json",
		}
	}

	msgType, _ := payload["type"].(string)
	switch msgType {
	case "ping":
		return map[string]any{
			"ok":   true,
			"type": "pong",
			"ts":   time.Now().Format(time.RFC3339Nano),
			"echo": payload,
		}
	case "event":
		if err := validateEvent(payload); err != nil {
			return map[string]any{
				"ok":    false,
				"type":  "event_ack",
				"error": err.Error(),
			}
		}
		if err := appendJSONL(eventsFile, payload); err != nil {
			return map[string]any{
				"ok":    false,
				"type":  "event_ack",
				"error": "failed to persist event",
			}
		}
		return map[string]any{
			"ok":   true,
			"type": "event_ack",
		}
	default:
		return map[string]any{
			"ok":    false,
			"error": "unsupported message type",
		}
	}
}

func main() {
	eventsFile, err := eventsPath()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[TT] events path error:", err)
		return
	}
	fmt.Fprintln(os.Stderr, "[TT] host boot, events file:", eventsFile)
	for {
		msg, err := readMsg(os.Stdin)
		if err != nil {
			//EOF = Chrome закрыл порт
			fmt.Fprintln(os.Stderr, "[TT] read:", err)
			return
		}
		fmt.Fprintln(os.Stderr, "[TT] got:", string(msg))

		resp := handleMessage(msg, eventsFile)
		if err := writeMsg(os.Stdout, resp); err != nil {
			fmt.Fprintln(os.Stderr, "[TT] write:", err)
			return
		}
	}
}
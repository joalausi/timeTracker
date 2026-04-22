package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

const Max = 1024 * 1024

type finalizedSegment struct {
	StartTsMs  int64
	EndTsMs    int64
	DurationMs int64
	URL        string
	Hostname   string
	Title      string
	Category   string
	Rule       string
	Reason     string
}

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

func logPath(filename string) (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(exePath), filename), nil
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

func getString(payload map[string]any, key string) (string, bool) {
	raw, ok := payload[key]
	if !ok || raw == nil {
		return "", false
	}
	value, ok := raw.(string)
	if !ok {
		return "", false
	}
	return value, true
}

func validateEvent(payload map[string]any) error {
	name, ok := getString(payload, "name")
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

	if rawURL, ok := payload["url"]; ok && rawURL != nil {
		if _, ok := rawURL.(string); !ok {
			return fmt.Errorf("invalid url")
		}
	}

	return nil
}

func parseSegment(payload map[string]any) (finalizedSegment, error) {
	startTs, ok := toInt(payload["start_ts_ms"])
	if !ok {
		return finalizedSegment{}, fmt.Errorf("missing/invalid start_ts_ms")
	}
	endTs, ok := toInt(payload["end_ts_ms"])
	if !ok {
		return finalizedSegment{}, fmt.Errorf("missing/invalid end_ts_ms")
	}
	if endTs <= startTs {
		return finalizedSegment{}, fmt.Errorf("invalid segment duration")
	}
	duration := endTs - startTs
	if providedDuration, ok := toInt(payload["duration_ms"]); ok && providedDuration > 0 {
		duration = providedDuration
	}

	requiredStrings := []string{"url", "category", "rule", "reason"}
	values := map[string]string{}
	for _, key := range requiredStrings {
		value, ok := getString(payload, key)
		if !ok || value == "" {
			return finalizedSegment{}, fmt.Errorf("missing/invalid %s", key)
		}
		values[key] = value
	}

	title, _ := getString(payload, "title")
	hostname, _ := getString(payload, "hostname")
	if hostname == "" {
		parsed, err := url.Parse(values["url"])
		if err == nil {
			hostname = parsed.Hostname()
		}
	}
	if hostname == "" {
		hostname = "unknown"
	}

	return finalizedSegment{
		StartTsMs:  startTs,
		EndTsMs:    endTs,
		DurationMs: duration,
		URL:        values["url"],
		Hostname:   hostname,
		Title:      title,
		Category:   values["category"],
		Rule:       values["rule"],
		Reason:     values["reason"],
	}, nil
}

type store struct {
	eventsFile string
	sqlite     *sqliteStore
	logFile    string
}

func (s store) logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, line)
	if s.logFile == "" {
		return
	}
	entry := map[string]any{
		"ts":   time.Now().UnixMilli(),
		"line": line,
	}
	_ = appendJSONL(s.logFile, entry)
}

func (s store) handleMessage(msg []byte) map[string]any {
	var payload map[string]any
	if err := json.Unmarshal(msg, &payload); err != nil {
		s.logf("[TT] invalid json: %v", err)
		return map[string]any{
			"ok":    false,
			"error": "invalid json",
		}
	}
	if payload == nil {
		s.logf("[TT] empty payload")
		return map[string]any{
			"ok":    false,
			"type":  "ack",
			"error": "empty payload",
		}
	}

	requestID, _ := payload["request_id"].(string)
	ack := func(body map[string]any) map[string]any {
		if requestID != "" {
			body["request_id"] = requestID
		}
		if _, ok := body["type"]; !ok {
			body["type"] = "ack"
		}
		return body
	}

	msgType, _ := payload["type"].(string)
	if msgType == "" {
		s.logf("[TT] missing type in payload")
		return ack(map[string]any{
			"ok":    false,
			"error": "missing message type",
		})
	}
	switch msgType {
	case "ping":
		stats := statsToday{Day: time.Now().Format("2006-01-02"), ByCategory: map[string]int64{}, ByHour: map[string]int64{}}
		if s.sqlite != nil {
			var err error
			stats, err = s.sqlite.queryStatsToday(time.Now())
			if err != nil {
				s.logf("[TT] stats query error: %v", err)
			}
		}
		return ack(map[string]any{
			"ok":          true,
			"type":        "ack",
			"ts":          time.Now().UnixMilli(),
			"stats_today": stats,
		})
	case "event":
		if err := validateEvent(payload); err != nil {
			s.logf("[TT] event validation error: %v", err)
			return ack(map[string]any{
				"ok":    false,
				"type":  "event_ack",
				"error": err.Error(),
			})
		}
		if err := appendJSONL(s.eventsFile, payload); err != nil {
			s.logf("[TT] event persist error: %v", err)
			return ack(map[string]any{
				"ok":    false,
				"type":  "event_ack",
				"error": "failed to persist event",
			})
		}
		return ack(map[string]any{
			"ok":   true,
			"type": "event_ack",
		})
	case "segment":
		seg, err := parseSegment(payload)
		if err != nil {
			s.logf("[TT] segment parse error: %v", err)
			return ack(map[string]any{
				"ok":    false,
				"type":  "segment_ack",
				"error": err.Error(),
			})
		}
		if s.sqlite == nil {
			s.logf("[TT] sqlite unavailable; segment accepted without persistence")
			return ack(map[string]any{
				"ok":   true,
				"type": "segment_ack",
			})
		}
		if err := s.sqlite.insertSegment(seg); err != nil {
			s.logf("[TT] sqlite insert error: %v", err)
			return ack(map[string]any{
				"ok":    false,
				"type":  "segment_ack",
				"error": "failed to persist segment",
			})
		}
		stats, err := s.sqlite.queryStatsToday(time.Now())
		if err != nil {
			s.logf("[TT] sqlite stats query error: %v", err)
			return ack(map[string]any{
				"ok":    false,
				"type":  "segment_ack",
				"error": "failed to query stats",
			})
		}
		return ack(map[string]any{
			"ok":          true,
			"type":        "segment_ack",
			"stats_today": stats,
		})
	case "stats_today":
		if s.sqlite == nil {
			return ack(map[string]any{
				"ok":          true,
				"type":        "stats_today_ack",
				"stats_today": statsToday{Day: time.Now().Format("2006-01-02"), ByCategory: map[string]int64{}, ByHour: map[string]int64{}},
			})
		}
		stats, err := s.sqlite.queryStatsToday(time.Now())
		if err != nil {
			s.logf("[TT] sqlite stats_today query error: %v", err)
			return ack(map[string]any{
				"ok":    false,
				"type":  "stats_today_ack",
				"error": "failed to query stats",
			})
		}
		return ack(map[string]any{
			"ok":          true,
			"type":        "stats_today_ack",
			"stats_today": stats,
		})
	default:
		s.logf("[TT] unknown message type: %s", msgType)
		return ack(map[string]any{
			"ok":      true,
			"type":    "ack",
			"ignored": true,
		})
	}
}

func main() {
	eventsFile, err := logPath("events.jsonl")
	if err != nil {
		fmt.Fprintln(os.Stderr, "[TT] events path error:", err)
		return
	}
	hostLogFile, err := logPath("host.log.jsonl")
	if err != nil {
		fmt.Fprintln(os.Stderr, "[TT] host log path error:", err)
		return
	}
	sqliteStore, dbPath, err := openSQLiteStore()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[TT] sqlite init warning:", err)
	}
	if sqliteStore != nil {
		defer func() {
			if err := sqliteStore.close(); err != nil {
				fmt.Fprintln(os.Stderr, "[TT] sqlite close error:", err)
			}
		}()
	}
	storage := store{
		eventsFile: eventsFile,
		sqlite:     sqliteStore,
		logFile:    hostLogFile,
	}
	if err != nil {
		storage.logf("[TT] sqlite init warning (continuing without sqlite): %v", err)
	}
	storage.logf("[TT] host boot, events file: %s", eventsFile)
	if dbPath != "" {
		storage.logf("[TT] host boot, sqlite: %s", dbPath)
	}
	for {
		msg, err := readMsg(os.Stdin)
		if err != nil {
			//EOF = Chrome закрыл порт
			storage.logf("[TT] read: %v", err)
			return
		}
		storage.logf("[TT] got: %s", string(msg))

		resp := storage.handleMessage(msg)
		if err := writeMsg(os.Stdout, resp); err != nil {
			storage.logf("[TT] write: %v", err)
			return
		}
	}
}

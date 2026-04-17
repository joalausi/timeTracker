package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

//go:embed schema.sql
var schemaSQL string

type statsToday struct {
	Day        string           `json:"day"`
	TotalMs    int64            `json:"total_ms"`
	ByCategory map[string]int64 `json:"by_category"`
	ByHour     map[string]int64 `json:"by_hour"`
}

type sqliteStore struct {
	dbPath string
}

func openSQLiteStore() (*sqliteStore, string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return nil, "", err
	}
	dbPath := filepath.Join(filepath.Dir(exePath), "tt.sqlite3")
	store := &sqliteStore{dbPath: dbPath}
	if err := store.execSQL(schemaSQL); err != nil {
		return nil, "", fmt.Errorf("init schema: %w", err)
	}
	return store, dbPath, nil
}

func (s *sqliteStore) close() error {
	return nil
}

func quoteSQL(value string) string {
	escaped := strings.ReplaceAll(value, "'", "''")
	return "'" + escaped + "'"
}

func (s *sqliteStore) execSQL(sqlText string) error {
	if s == nil || s.dbPath == "" {
		return errors.New("sqlite not initialized")
	}
	cmd := exec.Command("sqlite3", s.dbPath)
	cmd.Stdin = strings.NewReader(sqlText)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("sqlite3 exec failed: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (s *sqliteStore) queryJSON(sqlText string, target any) error {
	if s == nil || s.dbPath == "" {
		return errors.New("sqlite not initialized")
	}
	cmd := exec.Command("sqlite3", "-json", s.dbPath, sqlText)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("sqlite3 query failed: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	if len(out) == 0 {
		return nil
	}
	return json.Unmarshal(out, target)
}

func (s *sqliteStore) insertSegment(seg finalizedSegment) error {
	if s == nil || s.dbPath == "" {
		return errors.New("sqlite not initialized")
	}
	query := fmt.Sprintf(`
INSERT INTO segments (
  start_ts_ms, end_ts_ms, duration_ms, url, hostname, title, category, rule, reason, created_at_ms
) VALUES (
  %d, %d, %d, %s, %s, %s, %s, %s, %s, %d
);`,
		seg.StartTsMs,
		seg.EndTsMs,
		seg.DurationMs,
		quoteSQL(seg.URL),
		quoteSQL(seg.Hostname),
		quoteSQL(seg.Title),
		quoteSQL(seg.Category),
		quoteSQL(seg.Rule),
		quoteSQL(seg.Reason),
		time.Now().UnixMilli(),
	)
	return s.execSQL(query)
}

func localDayBounds(ts time.Time) (time.Time, time.Time, string) {
	loc := time.Local
	now := ts.In(loc)
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	end := start.Add(24 * time.Hour)
	return start, end, start.Format("2006-01-02")
}

func (s *sqliteStore) queryStatsToday(now time.Time) (statsToday, error) {
	if s == nil || s.dbPath == "" {
		return statsToday{}, errors.New("sqlite not initialized")
	}
	start, end, day := localDayBounds(now)
	startMs := start.UnixMilli()
	endMs := end.UnixMilli()

	result := statsToday{
		Day:        day,
		ByCategory: map[string]int64{},
		ByHour:     map[string]int64{},
	}

	type totalRow struct {
		TotalMs int64 `json:"total_ms"`
	}
	var totals []totalRow
	if err := s.queryJSON(fmt.Sprintf(`
SELECT COALESCE(SUM(duration_ms), 0) AS total_ms
FROM segments
WHERE start_ts_ms >= %d AND start_ts_ms < %d;`, startMs, endMs), &totals); err != nil {
		return result, err
	}
	if len(totals) > 0 {
		result.TotalMs = totals[0].TotalMs
	}

	type categoryRow struct {
		Category string `json:"category"`
		TotalMs  int64  `json:"total_ms"`
	}
	var categories []categoryRow
	if err := s.queryJSON(fmt.Sprintf(`
SELECT category, COALESCE(SUM(duration_ms), 0) AS total_ms
FROM segments
WHERE start_ts_ms >= %d AND start_ts_ms < %d
GROUP BY category
ORDER BY total_ms DESC;`, startMs, endMs), &categories); err != nil {
		return result, err
	}
	for _, row := range categories {
		category := row.Category
		if category == "" {
			category = "uncategorized"
		}
		result.ByCategory[category] = row.TotalMs
	}

	type hourRow struct {
		Hour    string `json:"hour"`
		TotalMs int64  `json:"total_ms"`
	}
	var hours []hourRow
	if err := s.queryJSON(fmt.Sprintf(`
SELECT strftime('%%H', start_ts_ms / 1000, 'unixepoch', 'localtime') AS hour, COALESCE(SUM(duration_ms), 0) AS total_ms
FROM segments
WHERE start_ts_ms >= %d AND start_ts_ms < %d
GROUP BY hour
ORDER BY hour;`, startMs, endMs), &hours); err != nil {
		return result, err
	}
	for _, row := range hours {
		if row.Hour != "" {
			result.ByHour[row.Hour] = row.TotalMs
		}
	}

	return result, nil
}

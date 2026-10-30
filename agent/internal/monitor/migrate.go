package monitor

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type MigrationPreview struct {
	Interfaces int64    `json:"interfaces"`
	MinuteRows int64    `json:"minute_rows"`
	RX         string   `json:"rx_bytes"`
	TX         string   `json:"tx_bytes"`
	Settings   Settings `json:"settings"`
	Applied    bool     `json:"applied"`
}

func Migrate(legacyDB, settingsPath, target string, apply, stopped bool) (MigrationPreview, error) {
	var preview MigrationPreview
	abs, err := filepath.Abs(legacyDB)
	if err != nil {
		return preview, err
	}
	if _, err = os.Stat(abs); err != nil {
		return preview, err
	}
	u := url.URL{Scheme: "file", Path: abs, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return preview, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err = db.QueryRow("SELECT COUNT(*),CAST(COALESCE(SUM(rx_bytes),0) AS TEXT),CAST(COALESCE(SUM(tx_bytes),0) AS TEXT) FROM totals").Scan(&preview.Interfaces, &preview.RX, &preview.TX); err != nil {
		return preview, errors.New("旧数据库结构无效")
	}
	if err = db.QueryRow("SELECT COUNT(*) FROM minutes").Scan(&preview.MinuteRows); err != nil {
		return preview, err
	}
	body, err := os.ReadFile(settingsPath)
	if err != nil {
		return preview, err
	}
	if err = json.Unmarshal(body, &preview.Settings); err != nil {
		return preview, errors.New("旧配置 JSON 无效")
	}
	if err = preview.Settings.Validate(); err != nil {
		return preview, err
	}
	if !apply {
		return preview, nil
	}
	if !stopped {
		return preview, errors.New("请先停止旧采集服务，再使用 --legacy-stopped 确认")
	}
	if target == "" {
		return preview, errors.New("正式迁移需要 --target 新数据目录")
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return preview, err
	}
	if absTarget == filepath.Dir(abs) {
		return preview, errors.New("目标必须与旧数据目录不同")
	}
	if _, err = os.Stat(absTarget); err == nil {
		return preview, errors.New("目标目录已存在；为避免覆盖，请使用新目录")
	}
	if err = os.MkdirAll(filepath.Dir(absTarget), 0700); err != nil {
		return preview, err
	}
	stage, err := os.MkdirTemp(filepath.Dir(absTarget), ".agent-migrate-*")
	if err != nil {
		return preview, err
	}
	defer os.RemoveAll(stage)
	backup := filepath.Join(stage, "legacy-backup.db")
	if _, err = db.Exec("VACUUM INTO '" + strings.ReplaceAll(backup, "'", "''") + "'"); err != nil {
		return preview, fmt.Errorf("数据库一致性备份失败: %w", err)
	}
	data, err := os.ReadFile(backup)
	if err != nil {
		return preview, err
	}
	if err = os.WriteFile(filepath.Join(stage, "traffic.db"), data, 0600); err != nil {
		return preview, err
	}
	if err = os.WriteFile(filepath.Join(stage, "legacy-settings.json"), body, 0600); err != nil {
		return preview, err
	}
	store, err := OpenStore(filepath.Join(stage, "traffic.db"))
	if err != nil {
		return preview, err
	}
	err = store.DB.Close()
	if err != nil {
		return preview, err
	}
	if err = SaveConfig(filepath.Join(stage, "agent.json"), Config{DataDir: absTarget, Settings: preview.Settings}); err != nil {
		return preview, err
	}
	if err = os.Rename(stage, absTarget); err != nil {
		return preview, err
	}
	preview.Applied = true
	return preview, nil
}

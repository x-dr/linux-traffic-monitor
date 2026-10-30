package monitor

import (
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationPreviewApplyAndRetrySafety(t *testing.T) {
	root := t.TempDir()
	oldPath := filepath.Join(root, "legacy", "traffic.db")
	old, err := OpenStore(oldPath)
	if err != nil {
		t.Fatal(err)
	}
	sample(t, old, 1793380020, "a", []string{"ens3"}, map[string]Counters{"ens3": {100, 100}})
	sample(t, old, 1793380021, "a", []string{"ens3"}, map[string]Counters{"ens3": {400, 600}})
	old.DB.Close()
	settingsPath := filepath.Join(root, "settings.json")
	body, _ := json.Marshal(DefaultSettings())
	if err = os.WriteFile(settingsPath, body, 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(oldPath)
	target := filepath.Join(root, "new-agent")
	preview, err := Migrate(oldPath, settingsPath, target, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Applied || preview.RX != "300" || preview.TX != "500" {
		t.Fatal("preview mismatch")
	}
	if _, err = os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("dry run created target")
	}
	if _, err = Migrate(oldPath, settingsPath, target, true, false); err == nil {
		t.Fatal("migration did not require stopped-service confirmation")
	}
	applied, err := Migrate(oldPath, settingsPath, target, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if !applied.Applied {
		t.Fatal("not applied")
	}
	after, _ := os.ReadFile(oldPath)
	if sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("source modified")
	}
	copy, err := OpenStore(filepath.Join(target, "traffic.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer copy.DB.Close()
	rx, tx := total(t, copy, "ens3")
	if rx != 300 || tx != 500 {
		t.Fatal("migration lost history")
	}
	if _, err = Migrate(oldPath, settingsPath, target, true, true); err == nil {
		t.Fatal("retry overwrote target")
	}
	if _, err = os.Stat(filepath.Join(target, "legacy-backup.db")); err != nil {
		t.Fatal("backup missing")
	}
}

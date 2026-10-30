package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"trafficmon/agent/internal/monitor"
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if err := execute(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
func execute() error {
	command := "run"
	args := os.Args[1:]
	if len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		command = args[0]
		args = args[1:]
	}
	switch command {
	case "version":
		fmt.Println(monitor.Version)
		return nil
	case "run":
		flags := flag.NewFlagSet("run", flag.ContinueOnError)
		path := flags.String("config", "/etc/trafficmon/agent.json", "Agent 凭据配置路径")
		once := flags.Bool("once", false, "采集并上报一次后退出")
		if err := flags.Parse(args); err != nil {
			return err
		}
		cfg, err := monitor.LoadConfig(*path)
		if err != nil {
			return err
		}
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		return monitor.Run(ctx, cfg, *path, *once)
	case "migrate":
		flags := flag.NewFlagSet("migrate", flag.ContinueOnError)
		db := flags.String("legacy-db", "", "旧 traffic.db 路径")
		settings := flags.String("legacy-settings", "", "旧 settings.json 路径")
		target := flags.String("target", "", "新 Agent 数据目录")
		apply := flags.Bool("apply", false, "正式执行；默认只读预览")
		stopped := flags.Bool("legacy-stopped", false, "确认旧采集服务已经停止")
		if err := flags.Parse(args); err != nil {
			return err
		}
		if *db == "" || *settings == "" {
			return fmt.Errorf("需要 --legacy-db 和 --legacy-settings")
		}
		preview, err := monitor.Migrate(*db, *settings, *target, *apply, *stopped)
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(preview)
	default:
		return fmt.Errorf("支持的命令: run、migrate、version")
	}
}

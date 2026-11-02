package monitor

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

func reportRejection(status int, body io.Reader) error {
	message := fmt.Sprintf("中心拒绝上报（HTTP %d），本地同步进度保持不变", status)
	raw, err := io.ReadAll(io.LimitReader(body, 4097))
	if status != http.StatusConflict || err != nil || len(raw) > 4096 {
		return errors.New(message)
	}
	var response struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &response) != nil {
		return errors.New(message)
	}
	// Only known, fixed center messages may reach logs. Never echo an arbitrary
	// response, which could contain credentials, request bodies or proxy details.
	switch response.Error {
	case "采集源发生变化，请创建新节点以保留原历史",
		"扩展配置确认超出中心版本，请检查是否恢复过中心数据库",
		"指标配置版本超出中心版本",
		"探测结果身份或 revision 冲突",
		"探测结果身份冲突",
		"探测 revision 冲突":
		message += "；原因：" + response.Error
	}
	return errors.New(message)
}

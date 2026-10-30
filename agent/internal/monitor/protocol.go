package monitor

type Snapshot struct {
	ObservedAt         float64          `json:"observed_at"`
	Revision           int64            `json:"revision"`
	Hostname           string           `json:"hostname"`
	OS                 string           `json:"os"`
	Arch               string           `json:"arch"`
	Kernel             string           `json:"kernel"`
	AgentVersion       string           `json:"agent_version"`
	CPUCores           int              `json:"cpu_cores"`
	Uptime             float64          `json:"uptime_seconds"`
	CPUPercent         *float64         `json:"cpu_percent"`
	MemoryPercent      *float64         `json:"memory_percent"`
	SwapPercent        *float64         `json:"swap_percent"`
	MemoryTotal        string           `json:"memory_total"`
	MemoryAvailable    string           `json:"memory_available"`
	SwapTotal          string           `json:"swap_total"`
	Load               [3]*float64      `json:"load"`
	RxBPS              float64          `json:"rx_bps"`
	TxBPS              float64          `json:"tx_bps"`
	Interfaces         []string         `json:"interfaces"`
	SelectedInterfaces []string         `json:"selected_interfaces"`
	ReadableInterfaces []string         `json:"readable_interfaces"`
	Disks              []Disk           `json:"disks"`
	DiskIO             []DiskIOSnapshot `json:"disk_io,omitempty"`
	DiskIOSupported    bool             `json:"disk_io_supported,omitempty"`
	Error              *string          `json:"error"`
}
type Disk struct {
	Mount   string   `json:"mount"`
	FS      string   `json:"fs"`
	Total   string   `json:"total_bytes"`
	Used    string   `json:"used_bytes"`
	Free    string   `json:"free_bytes"`
	Percent *float64 `json:"used_percent"`
}
type DiskIOSnapshot struct {
	Device   string   `json:"device"`
	ReadBPS  *float64 `json:"read_bps"`
	WriteBPS *float64 `json:"write_bps"`
}
type DiskMinute struct {
	Device          string  `json:"device"`
	Minute          int64   `json:"minute_ts"`
	Revision        int64   `json:"revision"`
	ReadBytes       string  `json:"read_bytes"`
	WriteBytes      string  `json:"write_bytes"`
	ObservedSeconds float64 `json:"observed_seconds"`
}
type Stats struct {
	Avg   *float64 `json:"avg"`
	Max   *float64 `json:"max"`
	Count int64    `json:"count"`
}
type ResourceMinute struct {
	Minute   int64            `json:"minute_ts"`
	Revision int64            `json:"revision"`
	Values   map[string]Stats `json:"values"`
}
type TrafficMinute struct {
	Interface string `json:"interface"`
	Minute    int64  `json:"minute_ts"`
	Revision  int64  `json:"revision"`
	RX        string `json:"rx_bytes"`
	TX        string `json:"tx_bytes"`
}
type Total struct {
	Interface string `json:"interface"`
	Revision  int64  `json:"revision"`
	RX        string `json:"rx_bytes"`
	TX        string `json:"tx_bytes"`
}
type Report struct {
	ProtocolVersion int              `json:"protocol_version"`
	SourceID        string           `json:"source_id"`
	Snapshot        Snapshot         `json:"snapshot"`
	Traffic         []TrafficMinute  `json:"traffic"`
	Resources       []ResourceMinute `json:"resources"`
	Totals          []Total          `json:"totals"`
	DiskIO          []DiskMinute     `json:"disk_io,omitempty"`
	AppliedVersion  int64            `json:"applied_config_version"`
	ConfigError     *string          `json:"config_error"`
	ImportedConfig  *Settings        `json:"imported_config,omitempty"`
}
type Ack struct {
	Traffic   int64 `json:"traffic"`
	Resources int64 `json:"resources"`
	Totals    int64 `json:"totals"`
	DiskIO    int64 `json:"disk_io,omitempty"`
}
type Reply struct {
	Ack           Ack      `json:"ack"`
	Config        Settings `json:"config"`
	ConfigVersion int64    `json:"config_version"`
	ReceivedAt    float64  `json:"received_at"`
}

var MetricKeys = []string{"cpu_percent", "memory_percent", "swap_percent", "load1", "rx_bps", "tx_bps"}

func number(value float64) *float64 { return &value }

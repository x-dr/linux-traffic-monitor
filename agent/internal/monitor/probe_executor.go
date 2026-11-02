package monitor

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/netip"
	"net/url"
	"strconv"
	"sync/atomic"
	"time"
)

type ProbeResolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}
type ProbeExecutor struct {
	AllowCIDRs []string
	Resolver   ProbeResolver
}

func (e ProbeExecutor) allowed(ip netip.Addr) bool {
	ip = ip.Unmap()
	// These ranges remain blocked even when an operator allows private networks.
	if !ip.IsValid() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	for _, cidr := range []string{"169.254.0.0/16", "100.100.100.200/32", "168.63.129.16/32", "64:ff9b::/96", "64:ff9b:1::/48", "2002::/16", "fe80::/10"} {
		if netip.MustParsePrefix(cidr).Contains(ip) {
			return false
		}
	}
	for _, cidr := range e.AllowCIDRs {
		if p, err := netip.ParsePrefix(cidr); err == nil && p.Contains(ip) {
			return true
		}
	}
	if ip.IsPrivate() || ip.IsLoopback() || !ip.IsGlobalUnicast() {
		return false
	}
	for _, cidr := range []string{"100.64.0.0/10", "198.18.0.0/15", "0.0.0.0/8", "240.0.0.0/4"} {
		if netip.MustParsePrefix(cidr).Contains(ip) {
			return false
		}
	}
	return true
}
func (e ProbeExecutor) resolve(ctx context.Context, host, family string) (netip.Addr, string) {
	resolver := e.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	network := "ip4"
	if family == "ipv6" {
		network = "ip6"
	}
	addresses, err := resolver.LookupNetIP(ctx, network, host)
	if err != nil || len(addresses) == 0 {
		return netip.Addr{}, "dns"
	}
	var selected netip.Addr
	for _, ip := range addresses {
		ip = ip.Unmap()
		if ip.Is4() != (family == "ipv4") {
			continue
		}
		if !e.allowed(ip) {
			return netip.Addr{}, "blocked"
		}
		if !selected.IsValid() {
			selected = ip
		}
	}
	if !selected.IsValid() {
		return netip.Addr{}, "dns"
	}
	return selected, ""
}
func (e ProbeExecutor) Execute(parent context.Context, p ProbeAssignment, scheduled float64) ProbeResult {
	start := time.Now()
	result := ProbeResult{SampleID: newSampleID(), TaskID: p.ID, TaskVersion: p.Version, ScheduledAt: scheduled, StartedAt: seconds(start), Status: "success"}
	ctx, cancel := context.WithTimeout(parent, time.Duration(p.Timeout)*time.Second)
	defer cancel()
	host := p.Target
	var u *url.URL
	if p.Kind == "http" {
		u, _ = url.Parse(p.Target)
		host = u.Hostname()
	}
	ip, status := e.resolve(ctx, host, p.Family)
	if status != "" {
		result.Status = status
		if status != "blocked" {
			result.Attempts = 1
		}
		result.CompletedAt = seconds(time.Now())
		return result
	}
	result.Attempts = 1
	var err error
	switch p.Kind {
	case "icmp":
		result.Status, err = pingEcho(ctx, ip, openPingSocket)
		if result.Status == "unsupported" {
			result.Attempts = 0
		}
	case "tcp":
		var conn net.Conn
		conn, err = (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), strconv.Itoa(p.Port)))
		if conn != nil {
			conn.Close()
		}
		if err != nil {
			result.Status = "tcp"
		}
	case "http":
		// Resolve once, then connect only to that verified address. No proxy or redirect.
		transport := &http.Transport{DisableKeepAlives: true, DisableCompression: true, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				_, port, err := net.SplitHostPort(address)
				if err != nil {
					return nil, err
				}
				return (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			}}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, p.Target, nil)
		var stage atomic.Value
		stage.Store("tcp")
		req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
			TLSHandshakeStart: func() { stage.Store("tls") },
			GotConn:           func(httptrace.GotConnInfo) { stage.Store("http") },
		}))
		var response *http.Response
		response, err = client.Do(req)
		if err != nil {
			result.Status = stage.Load().(string)
			var verify *tls.CertificateVerificationError
			if errors.As(err, &verify) {
				result.Status = "tls"
				if len(verify.UnverifiedCertificates) > 0 {
					result.CertificateExpiresAt = number(seconds(verify.UnverifiedCertificates[0].NotAfter))
				}
			}
			var invalid x509.CertificateInvalidError
			if errors.As(err, &invalid) {
				result.Status = "tls"
				result.CertificateExpiresAt = number(seconds(invalid.Cert.NotAfter))
			}
		} else {
			result.HTTPStatus = &response.StatusCode
			if response.TLS != nil && len(response.TLS.PeerCertificates) > 0 {
				result.CertificateExpiresAt = number(seconds(response.TLS.PeerCertificates[0].NotAfter))
			}
			_, err = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
			response.Body.Close()
			if response.StatusCode < 200 || response.StatusCode >= 300 || err != nil {
				result.Status = "http"
			}
		}
	}
	if err != nil {
		var timeout net.Error
		if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &timeout) && timeout.Timeout() {
			result.Status = "timeout"
		}
	}
	result.CompletedAt = seconds(time.Now())
	if result.Status == "success" {
		result.LatencyMS = number(float64(time.Since(start).Microseconds()) / 1000)
	}
	return result
}
func seconds(t time.Time) float64 { return float64(t.UnixMicro()) / 1e6 }

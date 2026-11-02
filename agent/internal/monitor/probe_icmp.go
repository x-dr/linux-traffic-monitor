package monitor

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"net"
	"net/netip"
	"os"
	"syscall"
)

func newSampleID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("系统随机源不可用")
	}
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

type pingOpener func(int, int, int) (int, error)

func openPingSocket(family, kind, protocol int) (int, error) {
	return syscall.Socket(family, kind, protocol)
}
func pingEcho(ctx context.Context, ip netip.Addr, open pingOpener) (string, error) {
	family, protocol, requestType, replyType := syscall.AF_INET, syscall.IPPROTO_ICMP, byte(8), byte(0)
	var addr syscall.Sockaddr = &syscall.SockaddrInet4{}
	if !ip.Is4() {
		family, protocol, requestType, replyType = syscall.AF_INET6, syscall.IPPROTO_ICMPV6, 128, 129
		addr = &syscall.SockaddrInet6{}
	}
	fd, err := open(family, syscall.SOCK_DGRAM, protocol)
	if err != nil {
		return "unsupported", err
	}
	if err = syscall.Bind(fd, addr); err != nil {
		syscall.Close(fd)
		return "unsupported", err
	}
	file := os.NewFile(uintptr(fd), "icmp-ping")
	conn, err := net.FilePacketConn(file)
	file.Close()
	if err != nil {
		return "unsupported", err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		conn.SetDeadline(deadline)
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	packet := make([]byte, 24)
	packet[0] = requestType
	binary.BigEndian.PutUint16(packet[6:8], 1)
	if _, err = rand.Read(packet[8:]); err != nil {
		return "icmp", err
	}
	if ip.Is4() {
		var sum uint32
		for i := 0; i < len(packet); i += 2 {
			sum += uint32(binary.BigEndian.Uint16(packet[i : i+2]))
		}
		for sum>>16 != 0 {
			sum = sum&65535 + sum>>16
		}
		binary.BigEndian.PutUint16(packet[2:4], ^uint16(sum))
	}
	if _, err = conn.WriteTo(packet, &net.UDPAddr{IP: net.IP(ip.AsSlice())}); err != nil {
		return "icmp", err
	}
	buffer := make([]byte, 1500)
	for {
		n, peer, err := conn.ReadFrom(buffer)
		if err != nil {
			return "icmp", err
		}
		udp, ok := peer.(*net.UDPAddr)
		if ok && udp.IP.Equal(net.IP(ip.AsSlice())) && n >= len(packet) && buffer[0] == replyType && buffer[1] == 0 && binary.BigEndian.Uint16(buffer[6:8]) == 1 && bytes.Equal(buffer[8:24], packet[8:]) {
			return "success", nil
		}
	}
}

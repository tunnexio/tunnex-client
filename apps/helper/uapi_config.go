package helper

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
)

// uapiConfig renders the wireguard-go IpcSet string. Keys are HEX in the uapi, so
// the base64 config keys are converted. Pure serialization is shared across
// builds; this does not enable a tunnel backend on unsupported platforms.
func uapiConfig(cfg *TunnelConfig) (string, error) {
	priv, err := b64ToHex(cfg.PrivateKey)
	if err != nil {
		return "", &ProtocolError{Code: "bad_private_key", Msg: err.Error()}
	}
	pub, err := b64ToHex(cfg.PeerPublicKey)
	if err != nil {
		return "", &ProtocolError{Code: "bad_peer_key", Msg: err.Error()}
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "private_key=%s\n", priv)
	fmt.Fprintf(&sb, "listen_port=0\n")
	fmt.Fprintf(&sb, "replace_peers=true\n")
	fmt.Fprintf(&sb, "public_key=%s\n", pub)
	fmt.Fprintf(&sb, "endpoint=%s\n", cfg.Endpoint)
	if cfg.PersistentKeepalive > 0 {
		fmt.Fprintf(&sb, "persistent_keepalive_interval=%d\n", cfg.PersistentKeepalive)
	}
	for _, aip := range cfg.AllowedIPs {
		fmt.Fprintf(&sb, "allowed_ip=%s\n", aip)
	}
	return sb.String(), nil
}

func b64ToHex(k string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(k)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

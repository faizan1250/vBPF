// Package server exposes the agent HTTP and WebSocket API.
package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// DefaultTokenFile is the bearer token location relative to the repo root.
const DefaultTokenFile = "run/agent.token"

// TokenFilePath resolves the token file location.
func TokenFilePath() string {
	if p := os.Getenv("AGENT_TOKEN_FILE"); p != "" {
		return p
	}
	return DefaultTokenFile
}

// LoadOrCreateToken reads the bearer token or generates one with 0600 perms.
func LoadOrCreateToken(path string) (string, error) {
	if raw, err := os.ReadFile(path); err == nil {
		if tok := strings.TrimSpace(string(raw)); tok != "" {
			_ = os.Chmod(path, 0o600)
			return tok, nil
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(buf)
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return "", err
		}
	}
	if err := os.WriteFile(path, []byte(tok+"\n"), 0o600); err != nil {
		return "", err
	}
	return tok, nil
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	parts := strings.SplitN(h, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

// tokensEqual compares without leaking timing info.
func tokensEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized", "code": "UNAUTHORIZED"})
}

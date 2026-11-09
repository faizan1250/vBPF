package server

import (
	"os"
	"strings"
)

// AllowedOriginsEnv is read when the serve flag is absent.
const AllowedOriginsEnv = "AGENT_ALLOWED_ORIGINS"

// AllowedOriginsFromEnv parses AGENT_ALLOWED_ORIGINS as a comma-separated
// allowlist. Unset or blank means none: every browser origin is refused,
// while Origin-less server-to-server dials keep working.
func AllowedOriginsFromEnv() []string {
	return SplitOrigins(os.Getenv(AllowedOriginsEnv))
}

// SplitOrigins splits a comma-separated origin list, dropping blanks.
func SplitOrigins(raw string) []string {
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

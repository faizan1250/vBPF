package server

import "testing"

func TestBindAllowed(t *testing.T) {
	allowed := []string{"127.0.0.1", "::1", "0.0.0.0", "::"}
	for _, host := range allowed {
		if !bindAllowed(host) {
			t.Errorf("bindAllowed(%q) = false, want true", host)
		}
	}
	denied := []string{"", "localhost", "10.0.0.5", "192.168.1.10", "example.com"}
	for _, host := range denied {
		if bindAllowed(host) {
			t.Errorf("bindAllowed(%q) = true, want false", host)
		}
	}
}

package server

import "testing"

func TestBindAllowed(t *testing.T) {
	t.Run("loopback without flag", func(t *testing.T) {
		t.Setenv(WildcardBindEnv, "")
		for _, host := range []string{"127.0.0.1", "::1"} {
			if !bindAllowed(host) {
				t.Errorf("bindAllowed(%q) = false, want true", host)
			}
		}
	})
	t.Run("loopback with flag", func(t *testing.T) {
		t.Setenv(WildcardBindEnv, "1")
		for _, host := range []string{"127.0.0.1", "::1"} {
			if !bindAllowed(host) {
				t.Errorf("bindAllowed(%q) = false, want true", host)
			}
		}
	})
	t.Run("wildcard refused without flag", func(t *testing.T) {
		t.Setenv(WildcardBindEnv, "")
		for _, host := range []string{"0.0.0.0", "::"} {
			if bindAllowed(host) {
				t.Errorf("bindAllowed(%q) = true, want false", host)
			}
		}
	})
	t.Run("wildcard allowed with flag", func(t *testing.T) {
		t.Setenv(WildcardBindEnv, "1")
		for _, host := range []string{"0.0.0.0", "::"} {
			if !bindAllowed(host) {
				t.Errorf("bindAllowed(%q) = false, want true", host)
			}
		}
	})
	t.Run("wildcard refused on non-1 values", func(t *testing.T) {
		for _, v := range []string{"true", "yes", "0", " 1", "1 "} {
			t.Setenv(WildcardBindEnv, v)
			if bindAllowed("0.0.0.0") {
				t.Errorf("bindAllowed(%q) with %s=%q = true, want false", "0.0.0.0", WildcardBindEnv, v)
			}
		}
	})
	t.Run("non-loopback refused", func(t *testing.T) {
		for _, v := range []string{"", "1"} {
			t.Setenv(WildcardBindEnv, v)
			denied := []string{"", "localhost", "10.0.0.5", "192.168.1.10", "example.com"}
			for _, host := range denied {
				if bindAllowed(host) {
					t.Errorf("bindAllowed(%q) with %s=%q = true, want false", host, WildcardBindEnv, v)
				}
			}
		}
	})
}

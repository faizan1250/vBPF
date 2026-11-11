package server

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoadOrCreateToken_PreExistingEmptyBroadPerms(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.token")
	require.NoError(t, os.WriteFile(path, []byte{}, 0o666))
	if runtime.GOOS != "windows" {
		require.NoError(t, os.Chmod(path, 0o666))
	}

	tok, err := LoadOrCreateToken(path)
	require.NoError(t, err)
	require.NotEmpty(t, tok)

	content, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, tok+"\n", string(content))

	fi, err := os.Stat(path)
	require.NoError(t, err)
	if runtime.GOOS != "windows" {
		require.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
	} else {
		require.NotZero(t, fi.Size())
	}
}

func TestLoadOrCreateToken_PreExistingNonEmptyBroadPerms(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.token")
	const existingToken = "existing-secret-bearer-token-12345"
	require.NoError(t, os.WriteFile(path, []byte(existingToken+"\n"), 0o666))
	if runtime.GOOS != "windows" {
		require.NoError(t, os.Chmod(path, 0o666))
	}

	tok, err := LoadOrCreateToken(path)
	require.NoError(t, err)
	require.Equal(t, existingToken, tok)

	fi, err := os.Stat(path)
	require.NoError(t, err)
	if runtime.GOOS != "windows" {
		require.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
	} else {
		require.NotZero(t, fi.Size())
	}
}

func TestLoadOrCreateToken_WhitespaceOnlyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.token")
	require.NoError(t, os.WriteFile(path, []byte("   \n\t  \r\n  \n"), 0o644))
	if runtime.GOOS != "windows" {
		require.NoError(t, os.Chmod(path, 0o644))
	}

	tok, err := LoadOrCreateToken(path)
	require.NoError(t, err)
	require.NotEmpty(t, tok)
	require.False(t, strings.ContainsAny(tok, " \t\r\n"))

	content, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, tok+"\n", string(content))

	fi, err := os.Stat(path)
	require.NoError(t, err)
	if runtime.GOOS != "windows" {
		require.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
	} else {
		require.NotZero(t, fi.Size())
	}
}

func TestLoadOrCreateToken_ChmodOrPermError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission checks and chmod failure tests are not applicable on Windows")
	}

	// On POSIX, /etc/hosts exists and is readable, but unprivileged chmod fails (EPERM)
	// and its permissions (typically 0644) cannot be secured to 0600.
	if _, err := os.Stat("/etc/hosts"); err == nil {
		tok, err := LoadOrCreateToken("/etc/hosts")
		require.Error(t, err, "expected error when chmod or permissions cannot be secured")
		require.Empty(t, tok)
	}
}

func TestLoadOrCreateToken_DirectoryError(t *testing.T) {
	dir := t.TempDir()
	tok, err := LoadOrCreateToken(dir)
	require.Error(t, err)
	require.Empty(t, tok)
}

func TestTokensEqual(t *testing.T) {
	require.True(t, tokensEqual("abc", "abc"))
	require.False(t, tokensEqual("abc", "def"))
	require.False(t, tokensEqual("", "abc"))
	require.False(t, tokensEqual("abc", ""))
	require.False(t, tokensEqual("", ""))
}

func TestBearerToken(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "/", nil)
	require.Empty(t, bearerToken(req))

	req.Header.Set("Authorization", "Bearer my-token-123")
	require.Equal(t, "my-token-123", bearerToken(req))

	req.Header.Set("Authorization", "bearer   my-token-123  ")
	require.Equal(t, "my-token-123", bearerToken(req))

	req.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
	require.Empty(t, bearerToken(req))
}

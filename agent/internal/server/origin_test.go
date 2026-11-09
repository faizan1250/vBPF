package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"

	"github.com/faizan1250/vBPF/agent/internal/parser"
)

// startOriginServer starts a server with one live run for stream tests.
func startOriginServer(t *testing.T, cfg Config) (*Server, *httptest.Server, string) {
	t.Helper()
	cfg.RunFn = fakeRunner(20, 5*time.Millisecond)
	s := testServer(t, cfg)
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts, createRun(t, s, "BEGIN { @x = count(); }", 10)
}

func dialStream(ctx context.Context, ts *httptest.Server, token, id, origin string) (*websocket.Conn, *http.Response, error) {
	wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/v1/runs/" + id + "/stream"
	hdr := http.Header{}
	if token != "" {
		hdr.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		hdr.Set("Origin", origin)
	}
	return websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: hdr})
}

func readOneEvent(t *testing.T, ctx context.Context, conn *websocket.Conn, id string) {
	t.Helper()
	_, raw, err := conn.Read(ctx)
	require.NoError(t, err)
	var ev parser.Event
	require.NoError(t, json.Unmarshal(raw, &ev))
	require.Equal(t, id, ev.RunID)
}

func TestStreamRejectsBrowserOrigin(t *testing.T) {
	s, ts, id := startOriginServer(t, Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, resp, err := dialStream(ctx, ts, s.Token(), id, "https://evil.example")
	if conn != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}
	require.Error(t, err)
	require.NotNil(t, resp)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestStreamNoOriginWithToken(t *testing.T) {
	s, ts, id := startOriginServer(t, Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := dialStream(ctx, ts, s.Token(), id, "")
	require.NoError(t, err)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()
	readOneEvent(t, ctx, conn, id)
}

func TestStreamAllowlistedOrigin(t *testing.T) {
	s, ts, id := startOriginServer(t, Config{AllowedOrigins: []string{"https://app.example"}})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := dialStream(ctx, ts, s.Token(), id, "https://app.example")
	require.NoError(t, err)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()
	readOneEvent(t, ctx, conn, id)

	_, resp, err := dialStream(ctx, ts, s.Token(), id, "https://other.example")
	require.Error(t, err)
	require.NotNil(t, resp)
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestStreamRejectsBadToken(t *testing.T) {
	_, ts, id := startOriginServer(t, Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, resp, err := dialStream(ctx, ts, "wrong", id, "")
	if conn != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}
	require.Error(t, err)
	require.NotNil(t, resp)
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestSplitOrigins(t *testing.T) {
	require.Empty(t, SplitOrigins(""))
	require.Empty(t, SplitOrigins("  , "))
	require.Equal(t, []string{"https://a.example", "http://b:3000"},
		SplitOrigins(" https://a.example ,, http://b:3000 "))
}

func TestAllowedOriginsFromEnv(t *testing.T) {
	t.Setenv(AllowedOriginsEnv, "https://a.example, https://b.example")
	require.Equal(t, []string{"https://a.example", "https://b.example"}, AllowedOriginsFromEnv())
	t.Setenv(AllowedOriginsEnv, "")
	require.Empty(t, AllowedOriginsFromEnv())
}

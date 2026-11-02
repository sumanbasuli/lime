package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestChromeStartupDoesNotDisableSandbox(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable fixture")
	}
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	chrome := filepath.Join(dir, "chromium-browser")
	if err := os.WriteFile(chrome, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$LIME_CHROME_ARGV_PATH\"\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("LIME_CHROME_ARGV_PATH", argsPath)
	if err := verifyChromeStartup(); err == nil {
		t.Fatal("a browser that never starts passed the startup probe")
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, arg := range strings.Split(string(args), "\n") {
		if arg == "--no-sandbox" || strings.HasPrefix(arg, "--no-sandbox=") {
			t.Fatalf("browser sandbox disabled: %q", arg)
		}
	}
}

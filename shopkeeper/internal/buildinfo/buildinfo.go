package buildinfo

// Version is the application version injected at build time via -ldflags.
// It falls back to "dev" when building without ldflags (e.g. `go run`).
var Version = "dev"

// Commit is the git commit SHA injected at build time via -ldflags.
var Commit = ""

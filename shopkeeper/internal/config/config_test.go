package config

import (
	"os"
	"testing"
)

func TestLoadDoesNotUsePublishedDatabaseCredential(t *testing.T) {
	previous, present := os.LookupEnv("DATABASE_URL")
	if err := os.Unsetenv("DATABASE_URL"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if present {
			_ = os.Setenv("DATABASE_URL", previous)
		} else {
			_ = os.Unsetenv("DATABASE_URL")
		}
	})
	if got := Load().DatabaseURL; got != "" {
		t.Fatal("DATABASE_URL must be explicitly configured")
	}
}

func TestLoadPreservesConfiguredDatabaseURL(t *testing.T) {
	const url = "postgresql://lime:configured@localhost:5432/lime_db?sslmode=disable"
	t.Setenv("DATABASE_URL", url)
	if got := Load().DatabaseURL; got != url {
		t.Fatal("Load did not preserve the configured DATABASE_URL")
	}
}

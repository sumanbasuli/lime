package config

import "os"

// Config holds application configuration loaded from environment variables.
type Config struct {
	DatabaseURL   string
	Port          string
	ReportBaseURL string
}

// Load reads configuration from environment variables. A database URL is
// required; silently using a published development credential is unsafe.
func Load() *Config {
	return &Config{
		DatabaseURL:   getEnv("DATABASE_URL", ""),
		Port:          getEnv("SHOPKEEPER_PORT", "8080"),
		ReportBaseURL: getEnv("REPORT_BASE_URL", "http://localhost:3000"),
	}
}

func getEnv(key, fallback string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return fallback
}

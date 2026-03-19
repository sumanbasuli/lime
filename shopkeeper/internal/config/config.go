package config

import "os"

// Config holds application configuration loaded from environment variables.
type Config struct {
	DatabaseURL string
	Port        string
}

// Load reads configuration from environment variables with sensible defaults.
func Load() *Config {
	return &Config{
		DatabaseURL: getEnv("DATABASE_URL", "postgresql://lime:lime_dev_password@localhost:5432/lime_db?sslmode=disable"),
		Port:        getEnv("SHOPKEEPER_PORT", "8080"),
	}
}

func getEnv(key, fallback string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return fallback
}

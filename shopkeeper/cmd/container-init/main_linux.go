//go:build linux

package main

import (
	"log"
	"os"

	containerinit "github.com/sumanbasuli/lime/shopkeeper/internal/containerinit"
)

func main() {
	if err := containerinit.ContainerExec(os.Args[1:]); err != nil {
		log.Fatalf("container initialization failed: %v", err)
	}
}

package main

import (
	"fmt"
	"os"

	"github.com/wkn00/k3s-dash/internal/cli"
)

func main() {
	if err := cli.Run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "k3s-dash:", err)
		os.Exit(1)
	}
}

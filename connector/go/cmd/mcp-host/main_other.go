//go:build !windows

package main

import "os"

func main() { os.Stderr.WriteString("MCP_HOST_PLATFORM_UNSUPPORTED\n"); os.Exit(1) }

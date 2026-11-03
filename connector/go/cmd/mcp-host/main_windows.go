//go:build windows

package main

import (
	"context"
	"example.com/ai-database-workspace/connector/internal/mcphost"
	"flag"
	"os"
	"os/signal"
	"time"
)

func main() {
	var o mcphost.Options
	var prepareDirectory string
	var freshDirectory bool
	flag.BoolVar(&freshDirectory, "new-directory", false, "")
	flag.StringVar(&prepareDirectory, "prepare-directory", "", "")
	flag.StringVar(&o.Manifest, "manifest", "", "")
	flag.StringVar(&o.Digest, "digest", "", "")
	flag.StringVar(&o.Node, "node", "", "")
	flag.StringVar(&o.NodeDigest, "node-digest", "", "")
	flag.StringVar(&o.RunDirectory, "run-directory", "", "")
	flag.StringVar(&o.JobName,"job-name","","")
	o.Lifetime = 5 * time.Minute
	flag.Parse()
	if prepareDirectory != "" {
		if flag.NArg() != 0 || o.Manifest != "" || o.Node != "" || o.JobName!="" {
			os.Stderr.WriteString("MCP_HOST_DIRECTORY_FAILED\n")
			os.Exit(1)
		}
		if err := mcphost.ProtectDirectory(prepareDirectory, freshDirectory); err != nil {
			os.Stderr.WriteString(err.Error() + "\n")
			os.Exit(1)
		}
		return
	}
	if flag.NArg() != 0 {
		os.Stderr.WriteString("MCP_HOST_CONFIG_FAILED\n")
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	if err := mcphost.Run(ctx, o); err != nil {
		os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
}

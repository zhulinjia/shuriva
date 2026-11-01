//go:build !windows

package g2

import "os/exec"

func journalHideChildWindow(_ *exec.Cmd) {}

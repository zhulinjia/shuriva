//go:build windows

package g2

import (
	"os/exec"
	"syscall"
)

func journalHideChildWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

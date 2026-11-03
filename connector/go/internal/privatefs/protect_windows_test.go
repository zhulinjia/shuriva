//go:build windows

package privatefs

import (
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"testing"
)

func TestOwnerOnlyDirectory(t *testing.T) {
	path := t.TempDir()
	if err := Protect(path, true); err != nil {
		t.Fatalf("directory protection: %v", err)
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if dacl.AceCount != 1 {
		t.Fatal("directory has additional access grants")
	}
}
func TestWorkspaceDirectory(t *testing.T) {
	base, err := filepath.Abs("../../.cache")
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(base, "g4-acl-")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if filepath.Dir(root) != base {
			t.Error("cleanup rejected")
			return
		}
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	}()
	current, _ := windows.GetCurrentProcessToken().GetTokenUser()
	sd, err := windows.GetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		t.Fatal(err)
	}
	t.Log("owner is current user", owner.Equals(current.User.Sid), "owner is administrators", owner.IsWellKnown(windows.WinBuiltinAdministratorsSid), "owner is system", owner.IsWellKnown(windows.WinLocalSystemSid))
	if err := Protect(root, true); err != nil {
		t.Fatalf("workspace directory protection: %v", err)
	}
}

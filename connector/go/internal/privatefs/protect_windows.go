//go:build windows

package privatefs

import (
	"errors"
	"golang.org/x/sys/windows"
	"unsafe"
)

func descriptor(directory bool) (*windows.SECURITY_DESCRIPTOR, *windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, nil, err
	}
	flags := ""
	if directory {
		flags = "OICI"
	}
	sd, err := windows.SecurityDescriptorFromString("O:" + user.User.Sid.String() + "D:P(A;" + flags + ";FA;;;" + user.User.Sid.String() + ")")
	return sd, user.User.Sid, err
}

func OwnerOnlyDescriptor() (*windows.SECURITY_DESCRIPTOR,error) {sd,_,err:=descriptor(false);return sd,err}

// Protect preserves the existing mutation-file behavior. Runtime directories
// use atomic creation plus verification instead of repairing inherited access.
func Protect(path string, directory bool) error {
	sd, sid, err := descriptor(directory)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if directory {
		current, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
		if err != nil {
			return err
		}
		owner, _, err := current.Owner()
		if err != nil || !owner.Equals(sid) {
			return errors.New("PRIVATE_DIRECTORY_OWNER_MISMATCH")
		}
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}
func VerifyDirectory(path string) error {
	expected, sid, err := descriptor(true)
	if err != nil {
		return err
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil || !owner.Equals(sid) {
		return errors.New("PRIVATE_DIRECTORY_OWNER_MISMATCH")
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return errors.New("PRIVATE_DIRECTORY_ACCESS_INVALID")
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 1 {
		return errors.New("PRIVATE_DIRECTORY_ACCESS_INVALID")
	}
	wanted, _, err := expected.DACL()
	if err != nil {
		return err
	}
	var actual, required *windows.ACCESS_ALLOWED_ACE
	if windows.GetAce(dacl, 0, &actual) != nil || windows.GetAce(wanted, 0, &required) != nil {
		return errors.New("PRIVATE_DIRECTORY_ACCESS_INVALID")
	}
	if actual.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || actual.Header.AceFlags != required.Header.AceFlags || actual.Mask != required.Mask || !(*windows.SID)(unsafe.Pointer(&actual.SidStart)).Equals(sid) {
		return errors.New("PRIVATE_DIRECTORY_ACCESS_INVALID")
	}
	return nil
}
func CreateDirectory(path string, fresh bool) error {
	sd, _, err := descriptor(true)
	if err != nil {
		return err
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	err = windows.CreateDirectory(p, &sa)
	if err != nil && (err != windows.ERROR_ALREADY_EXISTS || fresh) {
		return err
	}
	return VerifyDirectory(path)
}

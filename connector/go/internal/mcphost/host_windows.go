//go:build windows

package mcphost

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"example.com/ai-database-workspace/connector/internal/privatefs"
	"golang.org/x/sys/windows"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"
)

type File struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type Manifest struct {
	Version           int      `json:"version"`
	Name              string   `json:"name"`
	Entry             string   `json:"entry"`
	Files             []File   `json:"files"`
	SecretEnvironment []string `json:"secretEnvironment"`
}
type Options struct {
	Manifest, Digest, Node, NodeDigest, RunDirectory string
	JobName                                          string
	Lifetime                                         time.Duration
}

func reject() error { return errors.New("MCP_HOST_REJECTED") }

//go:embed loader.mjs
var loaderSource string

func ProtectDirectory(path string, fresh bool) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return reject()
	}
	if _, err = safePath(filepath.Dir(absolute)); err != nil {
		return errors.New("MCP_HOST_DIRECTORY_PATH_FAILED")
	}
	if privatefs.CreateDirectory(absolute, fresh) != nil {
		return errors.New("MCP_HOST_DIRECTORY_ACL_FAILED")
	}
	if _, err = safePath(absolute); err != nil {
		return err
	}
	return nil
}
func safePath(raw string) (string, error) {
	p, e := filepath.Abs(raw)
	if e != nil || strings.HasPrefix(p, `\\`) {
		return "", reject()
	}
	for q := p; ; q = filepath.Dir(q) {
		u, e := windows.UTF16PtrFromString(q)
		if e != nil {
			return "", reject()
		}
		a, e := windows.GetFileAttributes(u)
		if e != nil || a&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return "", reject()
		}
		if filepath.Dir(q) == q {
			break
		}
	}
	return p, nil
}
func pin(raw, digest string, size int64) (*os.File, error) {
	p, e := safePath(raw)
	if e != nil {
		return nil, e
	}
	u, e := windows.UTF16PtrFromString(p)
	if e != nil {
		return nil, e
	}
	h, e := windows.CreateFile(u, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(h), p)
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Size() != size {
		f.Close()
		return nil, reject()
	}
	hash := sha256.New()
	if _, e = io.Copy(hash, f); e != nil || hex.EncodeToString(hash.Sum(nil)) != digest {
		f.Close()
		return nil, reject()
	}
	return f, nil
}
func pipe() (windows.Handle, windows.Handle, error) {
	var r, w windows.Handle
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), InheritHandle: 1}
	e := windows.CreatePipe(&r, &w, &sa, 0)
	return r, w, e
}
func validFrame(raw []byte) bool {
	if len(raw) > 1048576 || !utf8.Valid(raw) {
		return false
	}
	quoted, escaped := false, false
	depth, nodes := 0, 0
	for _, b := range raw {
		if quoted {
			if escaped {
				escaped = false
			} else if b == '\\' {
				escaped = true
			} else if b == '"' {
				quoted = false
			}
			continue
		}
		switch b {
		case '"':
			quoted = true
		case '[', '{':
			depth++
			nodes++
		case ']', '}':
			depth--
		case ',', ':':
			nodes++
		}
		if depth > 24 || depth < 0 || nodes > 12000 {
			return false
		}
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	var members func(any) bool
	members = func(v any) bool {
		switch x := v.(type) {
		case map[string]any:
			if len(x) > 256 {
				return false
			}
			for _, child := range x {
				if !members(child) {
					return false
				}
			}
		case []any:
			if len(x) > 256 {
				return false
			}
			for _, child := range x {
				if !members(child) {
					return false
				}
			}
		}
		return true
	}
	return members(value)
}
func Run(ctx context.Context, o Options) (err error) {
	stage := "CONFIG"
	defer func() {
		if err != nil {
			err = errors.New("MCP_HOST_" + stage + "_FAILED")
		}
	}()
	if ctx.Err() != nil {
		return reject()
	}
	if o.Lifetime < time.Second || o.Lifetime > 10*time.Minute {
		return reject()
	}
	if p, e := safePath(o.RunDirectory); e != nil || p != o.RunDirectory {
		return reject()
	}
	if ProtectDirectory(o.RunDirectory, false) != nil {
		return reject()
	}
	created := false
	defer func() {
		if !created {
			_ = acknowledgeCleanup(o.RunDirectory)
		}
	}()
	parentID := os.Getppid()
	if parentID <= 0 {
		return reject()
	}
	parent, e := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(parentID))
	if e != nil {
		return reject()
	}
	defer windows.CloseHandle(parent)
	var parentCreated, hostCreated, exitTime, kernelTime, userTime windows.Filetime
	if windows.GetProcessTimes(parent, &parentCreated, &exitTime, &kernelTime, &userTime) != nil || windows.GetProcessTimes(windows.CurrentProcess(), &hostCreated, &exitTime, &kernelTime, &userTime) != nil {
		return reject()
	}
	stamp := func(f windows.Filetime) uint64 { return uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime) }
	if stamp(parentCreated) > stamp(hostCreated) {
		return reject()
	}
	parentAlive := func() bool {
		state, err := windows.WaitForSingleObject(parent, 0)
		return err == nil && state == uint32(windows.WAIT_TIMEOUT)
	}
	if !parentAlive() {
		return reject()
	}
	if !regexp.MustCompile(`^Local\\Shuriva-MCP-[a-f0-9-]{36}$`).MatchString(o.JobName) {
		return reject()
	}
	stage = "MANIFEST"
	root, e := safePath(filepath.Dir(o.Manifest))
	if e != nil {
		return e
	}
	raw, e := os.ReadFile(o.Manifest)
	if e != nil || len(raw) > 1048576 {
		return reject()
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != o.Digest {
		return reject()
	}
	var m Manifest
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&m) != nil || m.Version != 1 || len(m.Files) == 0 || len(m.Files) > 5000 || m.Entry == "" {
		return reject()
	}
	stage = "PACKAGE_INTEGRITY"
	pinned := []*os.File{}
	defer func() {
		for _, f := range pinned {
			f.Close()
		}
	}()
	manifestFile, e := pin(o.Manifest, o.Digest, int64(len(raw)))
	if e != nil {
		return e
	}
	pinned = append(pinned, manifestFile)
	seen := map[string]bool{}
	found := false
	var total int64
	for _, item := range m.Files {
		p := filepath.Clean(filepath.FromSlash(item.Path))
		if filepath.IsAbs(p) || filepath.VolumeName(p) != "" || strings.Contains(p, ":") || p == ".." || strings.HasPrefix(p, ".."+string(filepath.Separator)) || seen[strings.ToLower(p)] || item.Size < 0 {
			return reject()
		}
		seen[strings.ToLower(p)] = true
		total += item.Size
		if total > 64*1024*1024 {
			return reject()
		}
		f, e := pin(filepath.Join(root, p), item.SHA256, item.Size)
		if e != nil {
			return e
		}
		pinned = append(pinned, f)
		if filepath.ToSlash(p) == m.Entry {
			found = true
		}
	}
	if !found {
		return reject()
	}
	if !seen["package.json"] {
		return reject()
	}
	pkgInfo, e := os.Stat(filepath.Join(root, "package.json"))
	if e != nil || pkgInfo.Size() > 16384 {
		return reject()
	}
	pkgRaw, e := os.ReadFile(filepath.Join(root, "package.json"))
	if e != nil {
		return e
	}
	var pkg struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(pkgRaw, &pkg) != nil || (pkg.Type != "module" && pkg.Type != "commonjs") {
		return reject()
	}
	actualFiles := 0
	if err := filepath.WalkDir(root, func(path string, item os.DirEntry, err error) error {
		if err != nil {
			return reject()
		}
		if _, err = safePath(path); err != nil {
			return err
		}
		if item.IsDir() {
			return nil
		}
		if path == o.Manifest {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil || !seen[strings.ToLower(rel)] {
			return reject()
		}
		actualFiles++
		if actualFiles > 5000 {
			return reject()
		}
		return nil
	}); err != nil || actualFiles != len(seen) {
		return reject()
	}
	stage = "RUNTIME_INTEGRITY"
	nodeInfo, e := os.Stat(o.Node)
	if e != nil || nodeInfo.Size() > 256*1024*1024 {
		return reject()
	}
	f, e := pin(o.Node, o.NodeDigest, nodeInfo.Size())
	if e != nil {
		return e
	}
	pinned = append(pinned, f)
	stage = "ENVIRONMENT"
	envSecret := os.Getenv("SHURIVA_MCP_ENV")
	systemRoot := os.Getenv("SystemRoot")
	if len(envSecret) > 32768 || systemRoot == "" {
		return reject()
	}
	var secrets map[string]string
	if envSecret != "" && json.Unmarshal([]byte(envSecret), &secrets) != nil {
		return reject()
	}
	allowed := map[string]bool{}
	for _, k := range m.SecretEnvironment {
		if k == "" || strings.ContainsAny(k, "=\x00") || strings.HasPrefix(k, "NODE_") || strings.EqualFold(k, "PATH") || strings.EqualFold(k, "SYSTEMROOT") || strings.EqualFold(k, "TEMP") || strings.EqualFold(k, "TMP") || strings.HasPrefix(k, "SHURIVA_") {
			return reject()
		}
		allowed[k] = true
	}
	env := []string{"SystemRoot=" + systemRoot, "TEMP=" + o.RunDirectory, "TMP=" + o.RunDirectory}
	for k, v := range secrets {
		if !allowed[k] || strings.ContainsRune(v, 0) {
			return reject()
		}
		env = append(env, k+"="+v)
	}
	os.Clearenv()
	stage = "OWNERSHIP"
	sd, e := privatefs.OwnerOnlyDescriptor()
	if e != nil {
		return e
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	jobName, e := windows.UTF16PtrFromString(o.JobName)
	if e != nil {
		return e
	}
	createJob := windows.NewLazySystemDLL("kernel32.dll").NewProc("CreateJobObjectW")
	r, _, jobErr := createJob.Call(uintptr(unsafe.Pointer(&sa)), uintptr(unsafe.Pointer(jobName)))
	runtime.KeepAlive(sd)
	runtime.KeepAlive(jobName)
	if r == 0 {
		return jobErr
	}
	job := windows.Handle(r)
	if jobErr == windows.ERROR_ALREADY_EXISTS {
		windows.CloseHandle(job)
		return reject()
	}
	var once sync.Once
	stop := func() { once.Do(func() { windows.TerminateJobObject(job, 1) }) }
	defer windows.CloseHandle(job)
	cleanupChecked, cleanupProven := false, false
	defer func() {
		stop()
		if created && !cleanupChecked {
			cleanupProven = jobEmpty(job)
		}
		if created && cleanupProven {
			if e := acknowledgeCleanup(o.RunDirectory); e != nil && err == nil {
				err = e
			}
		}
	}()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS | windows.JOB_OBJECT_LIMIT_JOB_MEMORY
	limits.BasicLimitInformation.ActiveProcessLimit = 8
	limits.JobMemoryLimit = 512 * 1024 * 1024
	if _, e = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); e != nil {
		return e
	}
	stage = "PIPES"
	inR, inW, e := pipe()
	if e != nil {
		return e
	}
	outR, outW, e := pipe()
	if e != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		return e
	}
	errR, errW, e := pipe()
	if e != nil {
		for _, h := range []windows.Handle{inR, inW, outR, outW} {
			if h != 0 {
				windows.CloseHandle(h)
			}
		}
		return e
	}
	defer func() {
		for _, h := range []windows.Handle{inR, outW, errW} {
			windows.CloseHandle(h)
		}
	}()
	input := os.NewFile(uintptr(inW), "child-input")
	output := os.NewFile(uintptr(outR), "child-output")
	stderr := os.NewFile(uintptr(errR), "child-stderr")
	defer input.Close()
	defer output.Close()
	defer stderr.Close()
	for _, h := range []windows.Handle{inW, outR, errR} {
		if e = windows.SetHandleInformation(h, windows.HANDLE_FLAG_INHERIT, 0); e != nil {
			return e
		}
	}
	attrs, e := windows.NewProcThreadAttributeList(2)
	if e != nil {
		return e
	}
	defer attrs.Delete()
	// JOB_LIST assigns ownership atomically during CreateProcess (Windows 10+).
	jobs := []windows.Handle{job}
	defer runtime.KeepAlive(jobs)
	if e = attrs.Update(0x0002000D, unsafe.Pointer(&jobs[0]), unsafe.Sizeof(jobs[0])); e != nil {
		return e
	}
	handles := []windows.Handle{inR, outW, errW}
	defer runtime.KeepAlive(handles)
	if e = attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]), uintptr(len(handles))*unsafe.Sizeof(handles[0])); e != nil {
		return e
	}
	si := windows.StartupInfoEx{StartupInfo: windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfoEx{})), Flags: windows.STARTF_USESTDHANDLES, StdInput: inR, StdOutput: outW, StdErr: errW}, ProcThreadAttributeList: attrs.List()}
	pi := windows.ProcessInformation{}
	exe, _ := windows.UTF16PtrFromString(o.Node)
	rootJSON, _ := json.Marshal(root)
	loaderContent := loaderSource + "\nguardPackage(" + string(rootJSON) + ");\n"
	loader := filepath.Join(o.RunDirectory, "platform-loader.mjs")
	lf, e := os.OpenFile(loader, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = lf.WriteString(loaderContent)
	closeErr := lf.Close()
	if e != nil || closeErr != nil {
		return reject()
	}
	loaderHash := sha256.Sum256([]byte(loaderContent))
	loaderFile, e := pin(loader, hex.EncodeToString(loaderHash[:]), int64(len(loaderContent)))
	if e != nil {
		return e
	}
	pinned = append(pinned, loaderFile)
	loaderURL := (&url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(loader)}).String()
	cmd, e := windows.UTF16PtrFromString(windows.ComposeCommandLine([]string{o.Node, "--import", loaderURL, "--", filepath.Join(root, filepath.FromSlash(m.Entry))}))
	if e != nil {
		return e
	}
	cwd, _ := windows.UTF16PtrFromString(o.RunDirectory)
	envBlock := utf16.Encode([]rune(strings.Join(env, "\x00") + "\x00\x00"))
	stage = "PROCESS_CREATE"
	if e = windows.CreateProcess(exe, cmd, nil, nil, true, windows.CREATE_SUSPENDED|windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT|windows.EXTENDED_STARTUPINFO_PRESENT, &envBlock[0], cwd, &si.StartupInfo, &pi); e != nil {
		return e
	}
	created = true
	defer windows.CloseHandle(pi.Process)
	defer windows.CloseHandle(pi.Thread)
	for _, h := range []windows.Handle{inR, outW, errW} {
		windows.CloseHandle(h)
	}
	inR, outW, errW = 0, 0, 0
	// Parent authorizes the actual resume while holding the database admission
	// lease. Hashing/spawning alone must not consume that authorization early.
	readyAt := time.Now()
	if e = os.WriteFile(filepath.Join(o.RunDirectory, "ready"), []byte("MCP_HOST_READY"), 0600); e != nil {
		stop()
		return e
	}
	permitUntil := readyAt.Add(5 * time.Second)
	var permit struct {
		MaxElapsedMs int64 `json:"maxElapsedMs"`
		ExpiresAt    int64 `json:"expiresAt"`
	}
	for {
		if !parentAlive() {
			stop()
			return reject()
		}
		if ctx.Err() != nil {
			stop()
			return reject()
		}
		if b, err := os.ReadFile(filepath.Join(o.RunDirectory, "permit")); err == nil {
			if len(b) > 256 || json.Unmarshal(b, &permit) != nil || permit.MaxElapsedMs < 50 || permit.MaxElapsedMs > 1000 {
				stop()
				return reject()
			}
			break
		}
		if time.Now().After(permitUntil) {
			stop()
			return reject()
		}
		if _, err := os.Stat(filepath.Join(o.RunDirectory, "stop")); err == nil {
			stop()
			return reject()
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !parentAlive() || time.Since(readyAt) >= time.Duration(permit.MaxElapsedMs)*time.Millisecond || time.Now().UnixMilli() >= permit.ExpiresAt {
		stop()
		return reject()
	}
	if _, e = windows.ResumeThread(pi.Thread); e != nil {
		stop()
		return e
	}
	if e = os.WriteFile(filepath.Join(o.RunDirectory, "started"), []byte("MCP_HOST_STARTED"), 0600); e != nil {
		stop()
		return e
	}
	deadline := time.AfterFunc(o.Lifetime, stop)
	defer deadline.Stop()
	// Reading the parent pipe must never wait for a child that stops reading.
	// A small bounded queue fails closed; EOF still owns prompt job teardown.
	incoming := make(chan []byte, 4)
	go func() {
		defer stop()
		defer close(incoming)
		r := bufio.NewReader(os.Stdin)
		for {
			line := []byte{}
			for {
				part, e := r.ReadSlice('\n')
				line = append(line, part...)
				if len(line) > 65536 {
					return
				}
				if e == nil {
					break
				}
				if e != bufio.ErrBufferFull {
					return
				}
			}
			if !validFrame(line) {
				return
			}
			select {
			case incoming <- line:
			default:
				return
			}
		}
	}()
	go func() {
		var sequence uint64
		for line := range incoming {
			sequence++
			var permit struct {
				Nonce     string `json:"nonce"`
				ExpiresAt int64  `json:"expiresAt"`
			}
			permitPath := filepath.Join(o.RunDirectory, "send-"+strconv.FormatUint(sequence, 10)+".json")
			b, err := os.ReadFile(permitPath)
			if err != nil || len(b) > 256 || json.Unmarshal(b, &permit) != nil || len(permit.Nonce) != 36 {
				stop()
				return
			}
			remaining := time.Until(time.UnixMilli(permit.ExpiresAt))
			if remaining <= 0 || remaining > 4500*time.Millisecond {
				stop()
				return
			}
			// A blocked child write may never outlive its held authorization lease.
			deadline := time.AfterFunc(remaining, stop)
			if _, e := input.Write(line); e != nil {
				deadline.Stop()
				stop()
				return
			}
			deadline.Stop()
			if time.Now().UnixMilli() >= permit.ExpiresAt {
				stop()
				return
			}
			ack := filepath.Join(o.RunDirectory, "sent-"+strconv.FormatUint(sequence, 10))
			f, err := os.OpenFile(ack, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				stop()
				return
			}
			_, err = f.WriteString(permit.Nonce)
			closeErr := f.Close()
			if err != nil || closeErr != nil {
				stop()
				return
			}
		}
		input.Close()
	}()
	go func() {
		n, _ := io.CopyN(io.Discard, stderr, 65537)
		if n > 65536 {
			stop()
		}
	}()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			stop()
		case <-done:
		}
	}()
	go func() {
		t := time.NewTicker(100 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if _, e := os.Lstat(filepath.Join(o.RunDirectory, "stop")); e == nil {
					stop()
					return
				}
			}
		}
	}()
	frames := make(chan error, 1)
	go func() {
		reader := bufio.NewReader(output)
		total := 0
		for {
			first, e := reader.ReadByte()
			if e != nil {
				frames <- e
				return
			}
			frameTimer := time.AfterFunc(5*time.Second, stop)
			line := []byte{first}
			for line[len(line)-1] != '\n' {
				part, e := reader.ReadSlice('\n')
				line = append(line, part...)
				if len(line) > 1048576 {
					frameTimer.Stop()
					frames <- reject()
					stop()
					return
				}
				if e == nil {
					break
				}
				if e != bufio.ErrBufferFull {
					frameTimer.Stop()
					frames <- e
					return
				}
			}
			frameTimer.Stop()
			total += len(line)
			if total > 4194304 || !validFrame(line) {
				frames <- reject()
				stop()
				return
			}
			if _, e = os.Stdout.Write(line); e != nil {
				frames <- e
				stop()
				return
			}
		}
	}()
	result, e := windows.WaitForSingleObject(pi.Process, windows.INFINITE)
	stop()
	if e != nil || result != windows.WAIT_OBJECT_0 {
		return reject()
	}
	// Keep the job handle until accounting proves all ordinary descendants ended.
	type accounting struct {
		User, Kernel, PeriodUser, PeriodKernel int64
		Faults, Total, Active, Terminated      uint32
	}
	cleanupChecked = true
	ended := false
	for i := 0; i < 100; i++ {
		a := accounting{}
		if windows.QueryInformationJobObject(job, 1, uintptr(unsafe.Pointer(&a)), uint32(unsafe.Sizeof(a)), nil) != nil {
			return reject()
		}
		if a.Active == 0 {
			ended = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	cleanupProven = ended
	if !ended {
		return reject()
	}
	var protocolErr error
	select {
	case err := <-frames:
		if err != nil && !errors.Is(err, io.EOF) {
			protocolErr = err
		}
	case <-time.After(time.Second):
		return reject()
	}
	if _, e = safePath(o.RunDirectory); e != nil {
		return e
	}
	return protocolErr
}

func jobEmpty(job windows.Handle) bool {
	type accounting struct {
		User, Kernel, PeriodUser, PeriodKernel int64
		Faults, Total, Active, Terminated      uint32
	}
	for i := 0; i < 100; i++ {
		a := accounting{}
		if windows.QueryInformationJobObject(job, 1, uintptr(unsafe.Pointer(&a)), uint32(unsafe.Sizeof(a)), nil) != nil {
			return false
		}
		if a.Active == 0 {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func acknowledgeCleanup(run string) error {
	ack, e := os.OpenFile(filepath.Join(run, "closed"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = ack.WriteString("MCP_HOST_CLEANED")
	ackCloseErr := ack.Close()
	if e != nil {
		return e
	}
	return ackCloseErr
}

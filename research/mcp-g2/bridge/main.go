// A private-pipe runtime proof, not a Connector product command or SQL executor.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
	"unicode/utf8"
)

type acknowledgment struct {
	Nonce  string `json:"nonce"`
	PID    int    `json:"pid"`
	Parent int    `json:"parent"`
	Leaked bool   `json:"leaked"`
}

func exchange(ctx context.Context, node, script, mode string) (host int, failure error) {
	if !filepath.IsAbs(node) || !filepath.IsAbs(script) {
		return 0, errors.New("G2_IPC_PATH_REJECTED")
	}
	cmd := exec.CommandContext(ctx, node, script, mode)
	cmd.Env = []string{"SystemRoot=" + os.Getenv("SystemRoot"), "TEMP=" + os.Getenv("TEMP")}
	cmd.Dir = filepath.Dir(script)
	cmd.Stderr = io.Discard // diagnostics never echo an untrusted child's raw text
	cmd.WaitDelay = time.Second
	input, err := cmd.StdinPipe()
	if err != nil {
		return 0, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		_ = input.Close()
		return 0, err
	}
	if err = cmd.Start(); err != nil {
		_ = input.Close()
		_ = output.Close()
		return 0, err
	}
	waited := false
	defer func() {
		_ = input.Close()
		if !waited {
			killErr := cmd.Process.Kill() // only this exact owned Process handle
			if killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
				failure = errors.Join(failure, killErr)
			}
			waitErr := cmd.Wait()
			if failure == nil {
				failure = waitErr
			}
		}
	}()
	var entropy [32]byte
	if _, err = rand.Read(entropy[:]); err != nil {
		return 0, err
	}
	nonce := hex.EncodeToString(entropy[:])
	if err = json.NewEncoder(input).Encode(map[string]string{"operation": "ping", "nonce": nonce}); err != nil {
		return 0, err
	}
	// ReadSlice bounds allocation even if the child never emits a frame boundary.
	frame, err := bufio.NewReaderSize(output, 65536).ReadSlice('\n')
	if err != nil || len(frame) > 65536 || !utf8.Valid(frame) {
		return 0, errors.New("G2_IPC_FRAME_REJECTED")
	}
	decoder := json.NewDecoder(bytes.NewReader(frame))
	decoder.DisallowUnknownFields()
	var ack acknowledgment
	if err = decoder.Decode(&ack); err != nil {
		return 0, errors.New("G2_IPC_FRAME_REJECTED")
	}
	var trailing any
	if err = decoder.Decode(&trailing); err != io.EOF {
		return 0, errors.New("G2_IPC_FRAME_REJECTED")
	}
	if ack.Nonce != nonce || ack.PID != cmd.Process.Pid || ack.Parent != os.Getpid() || ack.Leaked {
		return 0, errors.New("G2_IPC_PEER_REJECTED")
	}
	if err = input.Close(); err != nil {
		return 0, err
	}
	err = cmd.Wait()
	waited = true
	if err != nil {
		return 0, err
	}
	return ack.PID, nil
}

func main() {
	node := flag.String("node", "", "trusted absolute Node runtime")
	script := flag.String("script", "", "owned fixed fixture")
	mode := flag.String("mode", "echo", "echo, hang, crash or oversized")
	flag.Parse()
	if *mode != "echo" && *mode != "hang" && *mode != "crash" && *mode != "oversized" {
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	host, err := exchange(ctx, *node, *script, *mode)
	if err != nil {
		fmt.Println(`{"ok":false,"code":"G2_IPC_FAILED"}`)
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "hostPid": host, "privatePipe": true})
}

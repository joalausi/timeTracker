package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"
)

const Max = 1024 * 1024

func readMsg(r io.Reader) ([]byte, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(lenBuf[:])
	if n == 0 || n > Max {
		return nil, fmt.Errorf("bad length: %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func writeMsg(w io.Writer, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(b)))
	if _, err := w.Write(lenBuf[:]); err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

func main() {
	for {
		msg, err := readMsg(os.Stdin)
		if err != nil {
			//EOF = Chrome закрыл порт
			fmt.Fprintln(os.Stderr, "read:", err)
			return
		}
		fmt.Fprintln(os.Stderr, "got:", string(msg))

		_ = writeMsg(os.Stdout, map[string]any{
			"ok":  true,
			"ts":  time.Now().Format(time.RFC3339Nano),
			"echo": json.RawMessage(msg),
		})
	}
}
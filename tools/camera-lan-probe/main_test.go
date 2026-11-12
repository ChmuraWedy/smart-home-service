package main

import "testing"

func TestHandshakeOrIsolatedPacketsDoNotProveStreaming(t *testing.T) {
	for _, value := range []measurement{
		{},
		{Packets: 10, Frames: 5, Width: 1280, Height: 720},
		{Packets: 10, Frames: 5, Seconds: 10},
		{Packets: 10, Frames: 1, Width: 1280, Height: 720, Seconds: 10},
	} {
		if value.passed() {
			t.Fatal("incomplete or short video measurement was accepted")
		}
	}
	value := measurement{Packets: 100, Frames: 20, Width: 1280, Height: 720, Seconds: 10}
	if !value.passed() {
		t.Fatal("sustained video was rejected")
	}
}

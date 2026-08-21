package ring

import (
	"sync"
	"testing"
	"time"
)

func p(v float64) *float64 { return &v }

func TestBufferKeepsOnlyTheWindowOldestFirst(t *testing.T) {
	b := New(3)
	now := time.Now()
	for idx := 1; idx <= 5; idx++ {
		b.Add(now.Add(time.Duration(idx)*time.Second), p(float64(idx)))
	}
	got := b.Values()
	want := []float64{3, 4, 5}
	if len(got) != len(want) {
		t.Fatalf("len(Values()) = %d, want %d", len(got), len(want))
	}
	for idx := range want {
		if got[idx] == nil || *got[idx] != want[idx] {
			t.Errorf("Values()[%d] = %v, want %v", idx, got[idx], want[idx])
		}
	}
}

func TestBufferIsNotPaddedBeforeItFills(t *testing.T) {
	b := New(10)
	b.Add(time.Now(), p(1))
	b.Add(time.Now(), p(2))
	if got := len(b.Values()); got != 2 {
		t.Errorf("len(Values()) = %d, want 2 — a partly filled buffer must not report phantom points", got)
	}
}

// A failed sample is a hole in the data, not the absence of a sample. It
// is stored so the chart shows a break instead of drawing a straight
// line across time when nothing was known.
func TestBufferStoresGaps(t *testing.T) {
	b := New(3)
	b.Add(time.Now(), p(1))
	b.Add(time.Now(), nil)
	b.Add(time.Now(), p(3))
	got := b.Values()
	if len(got) != 3 {
		t.Fatalf("len(Values()) = %d, want 3", len(got))
	}
	if got[1] != nil {
		t.Errorf("Values()[1] = %v, want nil (a stored gap)", *got[1])
	}
}

func TestBufferCapacityFloor(t *testing.T) {
	b := New(0)
	b.Add(time.Now(), p(7))
	if got := len(b.Values()); got != 1 {
		t.Errorf("len(Values()) = %d, want 1 — capacity must floor at 1, not panic", got)
	}
}

func TestSetKeepsNodesAndMetricsApart(t *testing.T) {
	s := NewSet(5)
	now := time.Now()
	s.Add("wk1", "cpuPercent", now, p(10))
	s.Add("wk1", "tempC", now, p(50))
	s.Add("wk2", "cpuPercent", now, p(20))

	got := s.Series("wk1", []string{"cpuPercent", "tempC", "batteryPercent"})
	if len(got["cpuPercent"]) != 1 || *got["cpuPercent"][0] != 10 {
		t.Errorf("wk1 cpuPercent = %v, want [10]", got["cpuPercent"])
	}
	if len(got["tempC"]) != 1 || *got["tempC"][0] != 50 {
		t.Errorf("wk1 tempC = %v, want [50]", got["tempC"])
	}
	if got["batteryPercent"] == nil {
		t.Error("batteryPercent = nil, want an empty slice: the UI must not have to nil-check every series")
	}
	if len(got["batteryPercent"]) != 0 {
		t.Errorf("batteryPercent = %v, want empty", got["batteryPercent"])
	}
}

// The sample loop writes while HTTP handlers read. Run with -race.
func TestSetIsSafeForConcurrentUse(t *testing.T) {
	s := NewSet(64)
	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for idx := 0; idx < 200; idx++ {
				s.Add("wk1", "cpuPercent", time.Now(), p(float64(idx)))
			}
		}()
		go func() {
			defer wg.Done()
			for idx := 0; idx < 200; idx++ {
				_ = s.Series("wk1", []string{"cpuPercent"})
			}
		}()
	}
	wg.Wait()
}

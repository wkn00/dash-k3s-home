// Package ring holds a fixed-length window of samples. The dashboard's
// history is deliberately in memory and deliberately small: two hours is
// enough to answer "is this climbing?", and nothing here is worth a
// volume, a retention job, or a second replica's worth of divergence.
package ring

import (
	"sync"
	"time"
)

type point struct {
	at    time.Time
	value *float64
}

type Buffer struct {
	mu     sync.RWMutex
	points []point
	next   int
	filled bool
}

func New(capacity int) *Buffer {
	if capacity < 1 {
		capacity = 1
	}
	return &Buffer{points: make([]point, capacity)}
}

// Add records one sample. A nil value is stored rather than dropped, so a
// failed collection renders as a break in the line instead of silently
// joining the two readings either side of it.
func (b *Buffer) Add(at time.Time, value *float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.points[b.next] = point{at: at, value: value}
	b.next = (b.next + 1) % len(b.points)
	if b.next == 0 {
		b.filled = true
	}
}

// Values returns the window oldest-first. The slice is freshly allocated,
// so callers may hold it while the buffer keeps being written.
func (b *Buffer) Values() []*float64 {
	b.mu.RLock()
	defer b.mu.RUnlock()
	out := make([]*float64, 0, len(b.points))
	if b.filled {
		for idx := b.next; idx < len(b.points); idx++ {
			out = append(out, b.points[idx].value)
		}
	}
	for idx := 0; idx < b.next; idx++ {
		out = append(out, b.points[idx].value)
	}
	return out
}

// Set is the per-node, per-metric collection of buffers. Buffers are
// created on first write, so a node joining the cluster needs no setup.
type Set struct {
	mu       sync.Mutex
	capacity int
	buffers  map[string]*Buffer
}

func NewSet(capacity int) *Set {
	return &Set{capacity: capacity, buffers: map[string]*Buffer{}}
}

func (s *Set) buffer(node, metric string) *Buffer {
	key := node + "\x00" + metric
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.buffers[key]
	if !ok {
		b = New(s.capacity)
		s.buffers[key] = b
	}
	return b
}

func (s *Set) Add(node, metric string, at time.Time, value *float64) {
	s.buffer(node, metric).Add(at, value)
}

// Series returns one slice per requested metric, always non-nil, so the
// page never has to distinguish "no history yet" from "no such metric".
func (s *Set) Series(node string, metrics []string) map[string][]*float64 {
	out := make(map[string][]*float64, len(metrics))
	for _, metric := range metrics {
		out[metric] = s.buffer(node, metric).Values()
	}
	return out
}

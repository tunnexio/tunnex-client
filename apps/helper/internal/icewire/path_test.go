package icewire

import (
	"github.com/pion/ice/v4"
	"testing"
)

func TestCandidatePath(t *testing.T) {
	tests := []struct {
		local, remote ice.CandidateType
		want          string
	}{
		{ice.CandidateTypeHost, ice.CandidateTypeHost, "direct"},
		{ice.CandidateTypeServerReflexive, ice.CandidateTypeHost, "direct"},
		{ice.CandidateTypeRelay, ice.CandidateTypeHost, "relay"},
		{ice.CandidateTypeHost, ice.CandidateTypeRelay, "relay"},
		{ice.CandidateTypeRelay, ice.CandidateTypePeerReflexive, "relay"},
		{ice.CandidateTypeHost, ice.CandidateTypePeerReflexive, "unknown"},
		{ice.CandidateTypePeerReflexive, ice.CandidateTypeHost, "unknown"},
		{ice.CandidateType(0), ice.CandidateTypeHost, "unknown"},
	}
	for _, tt := range tests {
		if got := candidatePath(tt.local, tt.remote); got != tt.want {
			t.Errorf("%v/%v: got %s want %s", tt.local, tt.remote, got, tt.want)
		}
	}
}

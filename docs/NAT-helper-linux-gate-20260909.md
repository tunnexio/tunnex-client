# Linux helper gate correction

PR #6 CI found `relay.go: undefined: uapiConfig` on Linux. The shared relay
serializer calls a pure formatter that was confined to a Darwin/Windows file.
Move only that formatter and its base64-to-hex utility to an untagged file,
unchanged. Keep runtime platform refusal and all tests unchanged; do not add
a Linux backend or skip its gate. Verify Linux vet/tests, native Mac tests and
Windows/Darwin cross-compilation before publishing the correction.

Results: Linux vet/full helper tests PASS; native Mac full helper tests PASS;
Darwin amd64/arm64 and Windows amd64 builds PASS. Existing platform refusal
and serializer tests run unchanged. Function bodies were moved unchanged; no
runtime, protocol, tests or workflow weakening. GitHub must rerun on the new
head; the initial helper job failure is not counted as green.

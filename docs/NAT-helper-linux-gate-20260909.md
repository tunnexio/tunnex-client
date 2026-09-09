# Linux helper gate correction

PR #6 CI found `relay.go: undefined: uapiConfig` on Linux. The shared relay
serializer calls a pure formatter that was confined to a Darwin/Windows file.
Move only that formatter and its base64-to-hex utility to an untagged file,
unchanged. Keep runtime platform refusal and all tests unchanged; do not add
a Linux backend or skip its gate. Verify Linux vet/tests, native Mac tests and
Windows/Darwin cross-compilation before publishing the correction.

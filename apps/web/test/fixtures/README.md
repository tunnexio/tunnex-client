These snapshots let the extracted desktop renderer test its control-plane API
edition registry and design census without nonexistent monorepo files. They
contain operation metadata and design banner names, not a substitute server spec
or invented design. Each records its original committed core revision, source
path and SHA-256. The generator reads Git objects, never working-tree changes or
the renderer expectations under test.

Refresh deliberately when updating the supported core contract:

```
node apps/web/test/support/refresh-core-contracts.mjs /path/to/tunnex-core
```

Review snapshot and registry/disposition changes together, then run the complete
renderer suite. This snapshot checks the supported contract; it does not monitor
future remote API or design changes automatically.

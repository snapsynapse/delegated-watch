---
name: Bug report
about: Something behaves differently from what the documentation or the data contract says
title: ''
labels: bug
assignees: ''
---

## What happened

## What you expected instead

## Which command

The exact command, including flags.

```
```

## Dataset

- [ ] The synthetic demonstration dataset shipped with the repository
- [ ] My own record, imported from my own receipts

If the numbers themselves look wrong, say which gate you believe misfired. `DATA_CONTRACT.md`
describes the cutoff, no-decrease, settled-entry, exclusion, and reconciliation gates, and a
blocked import is often a gate doing its job rather than a defect.

## Environment

- Node version (`node --version`):
- OS and version:
- Repository commit (`git rev-parse --short HEAD`):

## Anything the record could not see

If this is about a missing source rather than a wrong number, name the provider or surface
and how you read its counters. A source that reports nothing is expected to read as
unavailable, never as a measured zero; if it read as zero, that is the bug.

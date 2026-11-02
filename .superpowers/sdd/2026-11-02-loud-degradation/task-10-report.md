# Task 10 report
Status: DONE. setTranscriptTrust now writes transcript_trust_at only on level change (P19); getTranscriptTrustSince added; /status (gateway.ts carryLine, after Self-check) shows the verbatim line for untrusted/hostile only, time via localOf.
Tests: store trust_at case + tests/gateway/status-carry.test.ts (a-d). Mutations run and caught: always-now trust_at (store case fails), show line for clean (case b fails).
Full: typecheck clean; npm test 445 files / 6141 tests passed.
Note: tests were written together with the impl in one pass, so a literal red run was not shown; the mutations stand in for it.

-- How the official databases answered us, per source and UTC day
-- (src/sources/shared/limits.ts): counts only, written once a minute by the
-- web process, shown on Správa → Systém to tune the per-source concurrency
-- limits. No query text, no URL, no user — nothing about who asked what.
CREATE TABLE IF NOT EXISTS upstream_daily (
  day          date    NOT NULL,
  source       text    NOT NULL CHECK (length(source) BETWEEN 1 AND 80),
  requests     integer NOT NULL DEFAULT 0,
  ok           integer NOT NULL DEFAULT 0,
  http429      integer NOT NULL DEFAULT 0,
  http403      integer NOT NULL DEFAULT 0,
  http4xx      integer NOT NULL DEFAULT 0,
  http5xx      integer NOT NULL DEFAULT 0,
  timeouts     integer NOT NULL DEFAULT 0,
  network      integer NOT NULL DEFAULT 0,
  busy         integer NOT NULL DEFAULT 0,  -- refused by our own limiter, never sent
  latency_ms   bigint  NOT NULL DEFAULT 0,  -- sum over the sent requests
  lat_250      integer NOT NULL DEFAULT 0,  -- latency buckets: < 250 ms
  lat_1000     integer NOT NULL DEFAULT 0,  -- < 1 s
  lat_3000     integer NOT NULL DEFAULT 0,  -- < 3 s
  lat_10000    integer NOT NULL DEFAULT 0,  -- < 10 s
  lat_slow     integer NOT NULL DEFAULT 0,  -- 10 s and more
  queued       integer NOT NULL DEFAULT 0,  -- had to wait for a slot
  queue_ms     bigint  NOT NULL DEFAULT 0,
  max_inflight integer NOT NULL DEFAULT 0,
  max_queue    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON upstream_daily TO dawmain_app;

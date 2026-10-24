-- Consecutive failed vendor polls per job: the job engine gives up after a few in a row.
ALTER TABLE jobs ADD COLUMN poll_errors INTEGER NOT NULL DEFAULT 0;

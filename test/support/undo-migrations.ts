/**
 * What later migrations added, undone, for a test that takes a database back to before an earlier migration and lets
 * the application upgrade it again (migration-N.test.ts). Its tables rebuilt by 18 keep their shape when 18 runs again.
 * Migration 17 (ticket 18) is written to run again as it is (IF NOT EXISTS), so it needs no undoing.
 */
export const UNDO_SINCE_18 = `
  DROP VIEW IF EXISTS engine_subjects;
  DROP TRIGGER IF EXISTS track_progress_destination_detail_id_known_insert;
  DROP TRIGGER IF EXISTS track_progress_destination_detail_id_known_update;
  DROP TRIGGER IF EXISTS attempts_destination_detail_id_known_insert;
  DROP TRIGGER IF EXISTS attempts_destination_detail_id_known_update;
  DROP TRIGGER IF EXISTS call_attempts_number_detail_id_known_insert;
  DROP TRIGGER IF EXISTS call_attempts_number_detail_id_known_update;
  DROP TABLE IF EXISTS test_runs;
  ALTER TABLE campaigns DROP COLUMN test_email;
  ALTER TABLE campaigns DROP COLUMN test_mobile;
  ALTER TABLE campaigns DROP COLUMN edit_version;
  DELETE FROM schema_migrations WHERE version >= 18;
`;

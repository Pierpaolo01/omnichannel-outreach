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

/**
 * Migration 22 undone (ticket 24, ADR 0004): the columns and tables it added, dropped. The four tables it rebuilt need no
 * undoing: a later run of 22 rebuilds them from the columns it names. Run first by every undo that goes back past 22.
 */
export const UNDO_22 = `
  ALTER TABLE track_progress DROP COLUMN connection;
  ALTER TABLE track_progress DROP COLUMN connected_at;
  ALTER TABLE track_progress DROP COLUMN connected_wall;
  ALTER TABLE track_progress DROP COLUMN accepted_wall;
  ALTER TABLE track_progress DROP COLUMN accept_by;
  ALTER TABLE track_progress DROP COLUMN accept_by_wall;
  ALTER TABLE track_progress DROP COLUMN accept_by_zone;
  ALTER TABLE track_progress DROP COLUMN accept_by_days;
  ALTER TABLE track_progress DROP COLUMN invite_withdrawal;
  ALTER TABLE track_progress DROP COLUMN invite_withdrawal_last_wall;
  ALTER TABLE track_progress DROP COLUMN invite_withdrawal_unknowns;
  ALTER TABLE track_progress DROP COLUMN invite_pending_seen_wall;
  ALTER TABLE track_progress DROP COLUMN invite_pending_checked_wall;
  ALTER TABLE provider_work DROP COLUMN kind;
  ALTER TABLE provider_work DROP COLUMN note;
  ALTER TABLE attempts DROP COLUMN action;
  ALTER TABLE campaigns DROP COLUMN test_linkedin;
  DROP TABLE social_allowances;
  DROP TABLE linkedin_profile_marks;
  DELETE FROM schema_migrations WHERE version >= 22;
`;

/**
 * Migration 21 undone (question Q7 answered): a skip's cause and the unsent mark, dropped. Run first by a test that takes
 * a database back to before an earlier migration, so that migration and every one after it, 21 included, apply again.
 */
export const UNDO_21 = `${UNDO_22}
  ALTER TABLE track_progress DROP COLUMN conversation_owners;
  ALTER TABLE sms_bindings DROP COLUMN unsent;
  DELETE FROM schema_migrations WHERE version >= 21;
`;

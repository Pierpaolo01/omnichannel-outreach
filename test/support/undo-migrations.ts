/**
 * What later migrations added, undone, for a test that takes a database back to before an earlier migration and lets
 * the application upgrade it again (migration-N.test.ts). Its tables rebuilt by 17 keep their shape when 17 runs again.
 */
export const UNDO_SINCE_17 = `
  DROP VIEW IF EXISTS engine_subjects;
  DROP TABLE IF EXISTS test_runs;
  ALTER TABLE campaigns DROP COLUMN test_email;
  ALTER TABLE campaigns DROP COLUMN test_mobile;
  DELETE FROM schema_migrations WHERE version >= 17;
`;

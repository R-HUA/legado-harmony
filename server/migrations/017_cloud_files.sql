BEGIN;
CREATE TABLE IF NOT EXISTS cloud_files (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  request_id varchar(100) NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('BOOK','FONT','SOURCE')),
  name varchar(200) NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0 AND bytes <= 1073741824),
  state varchar(16) NOT NULL DEFAULT 'UPLOADING' CHECK (state IN ('UPLOADING','READY','DELETING')),
  manifest_hash varchar(64),
  expected_manifest_hash varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id)
);
ALTER TABLE cloud_files ADD COLUMN IF NOT EXISTS expected_manifest_hash varchar(64);
CREATE INDEX IF NOT EXISTS cloud_files_owner ON cloud_files(user_id,state,id);
CREATE INDEX IF NOT EXISTS cloud_files_content ON cloud_files(user_id,kind,manifest_hash,bytes) WHERE state='READY';
CREATE TABLE IF NOT EXISTS cloud_chunks (
  file_id uuid NOT NULL REFERENCES cloud_files(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 1024),
  bytes integer NOT NULL CHECK (bytes > 0 AND bytes <= 1048576),
  sha256 varchar(64) NOT NULL,
  object_key text NOT NULL UNIQUE,
  ready boolean NOT NULL DEFAULT false,
  PRIMARY KEY(file_id,chunk_index)
);
CREATE TABLE IF NOT EXISTS cloud_download_usage (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  period_id uuid NOT NULL REFERENCES membership_periods(id),
  cycle_index integer NOT NULL,
  bytes bigint NOT NULL DEFAULT 0 CHECK(bytes >= 0 AND bytes <= 1073741824),
  PRIMARY KEY(user_id,period_id,cycle_index)
);
COMMIT;

CREATE TABLE IF NOT EXISTS domain_revision (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO domain_revision(singleton, revision) VALUES (1, 0) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS batches_name_unique ON batches(lower(name));

CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  legacy_min_per_week INTEGER CHECK (legacy_min_per_week IS NULL OR legacy_min_per_week BETWEEN 1 AND 25),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS subjects_name_unique ON subjects(lower(name));

CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  user_id UUID UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS teachers_name_unique ON teachers(lower(name));

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_name_unique ON rooms(lower(name));

CREATE TABLE IF NOT EXISTS batch_requirements (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  weekly_sessions SMALLINT NOT NULL CHECK (weekly_sessions BETWEEN 1 AND 25),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(batch_id, subject_id)
);
CREATE INDEX IF NOT EXISTS batch_requirements_subject_idx ON batch_requirements(subject_id);

CREATE TABLE IF NOT EXISTS teacher_subjects (
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  PRIMARY KEY (teacher_id, subject_id)
);

CREATE TABLE IF NOT EXISTS batch_availability (
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  day TEXT NOT NULL CHECK (day IN ('Mon','Tue','Wed','Thu','Fri')),
  slot TEXT NOT NULL CHECK (slot IN ('9-10','10-11','11-12','2-3','3-4')),
  PRIMARY KEY (batch_id, day, slot)
);
CREATE TABLE IF NOT EXISTS teacher_availability (
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
  day TEXT NOT NULL CHECK (day IN ('Mon','Tue','Wed','Thu','Fri')),
  slot TEXT NOT NULL CHECK (slot IN ('9-10','10-11','11-12','2-3','3-4')),
  PRIMARY KEY (teacher_id, day, slot)
);
CREATE TABLE IF NOT EXISTS room_availability (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  day TEXT NOT NULL CHECK (day IN ('Mon','Tue','Wed','Thu','Fri')),
  slot TEXT NOT NULL CHECK (slot IN ('9-10','10-11','11-12','2-3','3-4')),
  PRIMARY KEY (room_id, day, slot)
);

CREATE TABLE IF NOT EXISTS student_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS student_profiles_batch_idx ON student_profiles(batch_id);

CREATE TABLE IF NOT EXISTS confirmed_constraints (
  id UUID PRIMARY KEY,
  rule JSONB NOT NULL CHECK (jsonb_typeof(rule) = 'object'),
  confirmed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_revision BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS confirmed_constraints_author_idx ON confirmed_constraints(confirmed_by);

CREATE TABLE IF NOT EXISTS timetable_versions (
  id UUID PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('candidate','approved','superseded','stale','rejected')),
  source_revision BIGINT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at TIMESTAMPTZ NOT NULL,
  validation JSONB NOT NULL,
  diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  rejected_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  rejected_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS timetable_single_publication ON timetable_versions(status) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS timetable_versions_status_idx ON timetable_versions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS timetable_versions_revision_idx ON timetable_versions(source_revision);

CREATE TABLE IF NOT EXISTS timetable_entries (
  version_id UUID NOT NULL REFERENCES timetable_versions(id) ON DELETE RESTRICT,
  id TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  -- Immutable identifier snapshot; requirements may change while this historical row is retained.
  requirement_id TEXT NOT NULL,
  day TEXT NOT NULL CHECK (day IN ('Mon','Tue','Wed','Thu','Fri')),
  slot TEXT NOT NULL CHECK (slot IN ('9-10','10-11','11-12','2-3','3-4')),
  batch_name TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  teacher_name TEXT NOT NULL,
  room_name TEXT NOT NULL,
  PRIMARY KEY(version_id, id),
  UNIQUE(version_id, batch_id, day, slot),
  UNIQUE(version_id, teacher_id, day, slot),
  UNIQUE(version_id, room_id, day, slot)
);
CREATE INDEX IF NOT EXISTS timetable_entries_teacher_idx ON timetable_entries(version_id, teacher_id);
CREATE INDEX IF NOT EXISTS timetable_entries_batch_idx ON timetable_entries(version_id, batch_id);

CREATE TABLE IF NOT EXISTS approval_events (
  id UUID PRIMARY KEY,
  version_id UUID NOT NULL REFERENCES timetable_versions(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('approved','rejected','stale','approval_revalidation_failed')),
  source_revision BIGINT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_events_version_idx ON approval_events(version_id, created_at);

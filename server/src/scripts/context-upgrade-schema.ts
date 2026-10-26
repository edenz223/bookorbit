export const contextSchemaQuery =
  "SELECT kind, name, definition FROM (\nSELECT 'column' AS kind, table_name || '.' || column_name AS name,\ndata_type || ':' || coalesce(character_maximum_length::text,'') || ':' || is_nullable || ':' || coalesce(column_default,'') AS definition\nFROM information_schema.columns WHERE table_schema='public' AND table_name IN ('annotation_contexts','annotation_context_files','annotation_context_maintenance')\nUNION ALL\nSELECT 'constraint', c.relname || '.' || con.conname, pg_get_constraintdef(con.oid)\nFROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace\nWHERE n.nspname='public' AND c.relname IN ('annotation_contexts','annotation_context_files','annotation_context_maintenance')\nUNION ALL\nSELECT 'index', tablename || '.' || indexname, indexdef FROM pg_indexes\nWHERE schemaname='public' AND tablename IN ('annotation_contexts','annotation_context_files','annotation_context_maintenance')\n) s ORDER BY kind, name";

export const legacyContextSchema = [
  {
    kind: 'column',
    name: 'annotation_context_files.annotation_cursor',
    definition: 'integer::NO:0',
  },
  {
    kind: 'column',
    name: 'annotation_context_files.book_file_id',
    definition: 'integer::NO:',
  },
  {
    kind: 'column',
    name: 'annotation_context_files.checked_at',
    definition: 'timestamp with time zone::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_context_files.fingerprint',
    definition: 'character varying:64:YES:',
  },
  {
    kind: 'column',
    name: 'annotation_context_files.invalidation_pending',
    definition: 'boolean::NO:false',
  },
  {
    kind: 'column',
    name: 'annotation_context_files.lease_expires_at',
    definition: 'timestamp with time zone::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_context_files.lease_token',
    definition: 'uuid::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_context_files.next_check_at',
    definition: 'timestamp with time zone::NO:now()',
  },
  {
    kind: 'column',
    name: 'annotation_context_maintenance.algorithm_version',
    definition: 'integer::NO:1',
  },
  {
    kind: 'column',
    name: 'annotation_context_maintenance.completed_at',
    definition: 'timestamp with time zone::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_context_maintenance.cursor',
    definition: 'integer::NO:0',
  },
  {
    kind: 'column',
    name: 'annotation_context_maintenance.lease_expires_at',
    definition: 'timestamp with time zone::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_context_maintenance.lease_token',
    definition: 'uuid::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_context_maintenance.name',
    definition: 'character varying:32:NO:',
  },
  {
    kind: 'column',
    name: 'annotation_context_maintenance.upper_bound',
    definition: 'integer::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.after',
    definition: 'text::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.algorithm_version',
    definition: 'integer::NO:1',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.annotation_id',
    definition: 'integer::NO:',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.attempt_count',
    definition: 'integer::NO:0',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.available_at',
    definition: 'timestamp with time zone::YES:now()',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.before',
    definition: 'text::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.book_file_id',
    definition: 'integer::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.generated_at',
    definition: 'timestamp with time zone::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.generation',
    definition: 'integer::NO:1',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.input_fingerprint',
    definition: 'character varying:32:YES:',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.lease_expires_at',
    definition: 'timestamp with time zone::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.lease_token',
    definition: 'uuid::YES:',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.priority',
    definition: 'integer::NO:50',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.reason',
    definition: 'character varying:64:YES:',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.status',
    definition: "character varying:16:NO:'pending'::character varying",
  },
  {
    kind: 'column',
    name: 'annotation_contexts.updated_at',
    definition: 'timestamp with time zone::NO:now()',
  },
  {
    kind: 'column',
    name: 'annotation_contexts.user_id',
    definition: 'integer::NO:',
  },
  {
    kind: 'constraint',
    name: 'annotation_context_files.annotation_context_files_annotation_cursor_not_null',
    definition: 'NOT NULL annotation_cursor',
  },
  {
    kind: 'constraint',
    name: 'annotation_context_files.annotation_context_files_book_file_id_book_files_id_fk',
    definition: 'FOREIGN KEY (book_file_id) REFERENCES book_files(id) ON DELETE CASCADE',
  },
  {
    kind: 'constraint',
    name: 'annotation_context_files.annotation_context_files_book_file_id_not_null',
    definition: 'NOT NULL book_file_id',
  },
  {
    kind: 'constraint',
    name: 'annotation_context_files.annotation_context_files_invalidation_pending_not_null',
    definition: 'NOT NULL invalidation_pending',
  },
  {
    kind: 'constraint',
    name: 'annotation_context_files.annotation_context_files_next_check_at_not_null',
    definition: 'NOT NULL next_check_at',
  },
  {
    kind: 'constraint',
    name: 'annotation_context_files.annotation_context_files_pkey',
    definition: 'PRIMARY KEY (book_file_id)',
  },
  {
    kind: 'constraint',
    name: 'annotation_context_maintenance.annotation_context_maintenance_algorithm_version_not_null',
    definition: 'NOT NULL algorithm_version',
  },
  {
    kind: 'constraint',
    name: 'annotation_context_maintenance.annotation_context_maintenance_cursor_not_null',
    definition: 'NOT NULL cursor',
  },
  {
    kind: 'constraint',
    name: 'annotation_context_maintenance.annotation_context_maintenance_name_not_null',
    definition: 'NOT NULL name',
  },
  {
    kind: 'constraint',
    name: 'annotation_context_maintenance.annotation_context_maintenance_pkey',
    definition: 'PRIMARY KEY (name)',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_algorithm_version_not_null',
    definition: 'NOT NULL algorithm_version',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_annotation_id_annotations_id_fk',
    definition: 'FOREIGN KEY (annotation_id) REFERENCES annotations(id) ON DELETE CASCADE',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_annotation_id_not_null',
    definition: 'NOT NULL annotation_id',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_attempt_count_not_null',
    definition: 'NOT NULL attempt_count',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_book_file_id_book_files_id_fk',
    definition: 'FOREIGN KEY (book_file_id) REFERENCES book_files(id) ON DELETE SET NULL',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_generation_not_null',
    definition: 'NOT NULL generation',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_pkey',
    definition: 'PRIMARY KEY (annotation_id)',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_priority_not_null',
    definition: 'NOT NULL priority',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_status_chk',
    definition:
      "CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'ready'::character varying, 'unavailable'::character varying, 'failed'::character varying])::text[])))",
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_status_not_null',
    definition: 'NOT NULL status',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_updated_at_not_null',
    definition: 'NOT NULL updated_at',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_user_id_not_null',
    definition: 'NOT NULL user_id',
  },
  {
    kind: 'constraint',
    name: 'annotation_contexts.annotation_contexts_user_id_users_id_fk',
    definition: 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
  },
  {
    kind: 'index',
    name: 'annotation_context_files.annotation_context_files_due_idx',
    definition: 'CREATE INDEX annotation_context_files_due_idx ON public.annotation_context_files USING btree (next_check_at, book_file_id)',
  },
  {
    kind: 'index',
    name: 'annotation_context_files.annotation_context_files_pkey',
    definition: 'CREATE UNIQUE INDEX annotation_context_files_pkey ON public.annotation_context_files USING btree (book_file_id)',
  },
  {
    kind: 'index',
    name: 'annotation_context_maintenance.annotation_context_maintenance_pkey',
    definition: 'CREATE UNIQUE INDEX annotation_context_maintenance_pkey ON public.annotation_context_maintenance USING btree (name)',
  },
  {
    kind: 'index',
    name: 'annotation_contexts.annotation_contexts_file_idx',
    definition: 'CREATE INDEX annotation_contexts_file_idx ON public.annotation_contexts USING btree (book_file_id, annotation_id)',
  },
  {
    kind: 'index',
    name: 'annotation_contexts.annotation_contexts_lease_idx',
    definition:
      "CREATE INDEX annotation_contexts_lease_idx ON public.annotation_contexts USING btree (lease_expires_at) WHERE ((status)::text = 'processing'::text)",
  },
  {
    kind: 'index',
    name: 'annotation_contexts.annotation_contexts_pending_idx',
    definition:
      "CREATE INDEX annotation_contexts_pending_idx ON public.annotation_contexts USING btree (priority DESC NULLS LAST, available_at, annotation_id) WHERE (((status)::text = ANY ((ARRAY['pending'::character varying, 'failed'::character varying])::text[])) AND (available_at IS NOT NULL))",
  },
  {
    kind: 'index',
    name: 'annotation_contexts.annotation_contexts_pkey',
    definition: 'CREATE UNIQUE INDEX annotation_contexts_pkey ON public.annotation_contexts USING btree (annotation_id)',
  },
  {
    kind: 'index',
    name: 'annotation_contexts.annotation_contexts_user_page_idx',
    definition: 'CREATE INDEX annotation_contexts_user_page_idx ON public.annotation_contexts USING btree (user_id, annotation_id)',
  },
];

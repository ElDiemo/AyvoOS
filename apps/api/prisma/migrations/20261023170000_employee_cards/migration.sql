CREATE FUNCTION employee_card_fields_valid(data jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(data) = 'object'
    AND data ?& ARRAY['name','role','company','tagline','phone','email','website','linkedin','photoId']
    AND data - ARRAY['name','role','company','tagline','phone','email','website','linkedin','photoId'] = '{}'::jsonb
    AND length(btrim(data->>'name')) > 0
    AND (SELECT bool_and(jsonb_typeof(data->key) = 'string'
      AND length(data->>key) <= maximum AND (data->>key) !~ '[[:cntrl:]]')
      FROM (VALUES ('name',120),('role',120),('company',120),('tagline',300),('phone',40),('email',254),('website',500),('linkedin',500)) AS limits(key,maximum))
    AND (data->'photoId' = 'null'::jsonb OR (jsonb_typeof(data->'photoId') = 'string'
      AND (data->>'photoId') ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')),
    false);
$$;

CREATE TABLE employee_cards (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 80),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  draft jsonb NOT NULL CHECK (employee_card_fields_valid(draft)),
  published jsonb CHECK (published IS NULL OR employee_card_fields_valid(published)),
  published_version integer,
  published_at timestamptz(3),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT employee_cards_publication_complete CHECK (
    (published IS NULL AND published_version IS NULL AND published_at IS NULL)
    OR (published IS NOT NULL AND published_version IS NOT NULL AND published_version > 0 AND published_version <= version AND published_at IS NOT NULL)
  )
);
CREATE TABLE employee_card_photos (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  storage_key text NOT NULL UNIQUE,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE FUNCTION guard_employee_card() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE status_text text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'employee card addresses are never deleted or reassigned'; END IF;
  IF TG_OP = 'INSERT' AND NEW.version <> 1 THEN RAISE EXCEPTION 'employee card version starts at one'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.slug <> OLD.slug OR NEW.version <> OLD.version + 1) THEN
    RAISE EXCEPTION 'employee card identity is immutable; version must advance by one';
  END IF;
  IF NEW.published IS NOT NULL THEN
    SELECT status::text INTO status_text FROM users WHERE id = NEW.user_id FOR SHARE;
    IF status_text IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'inactive user cannot publish an employee card'; END IF;
    IF TG_OP = 'INSERT' OR NEW.published IS DISTINCT FROM OLD.published
       OR NEW.published_version IS DISTINCT FROM OLD.published_version
       OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      IF NEW.published IS DISTINCT FROM NEW.draft OR NEW.published_version IS DISTINCT FROM NEW.version THEN
        RAISE EXCEPTION 'publication must snapshot the current draft and revision';
      END IF;
    END IF;
  END IF;
  IF (NEW.draft->>'photoId') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM employee_card_photos WHERE id = (NEW.draft->>'photoId')::uuid AND user_id = NEW.user_id
  ) THEN RAISE EXCEPTION 'draft photo does not belong to the employee'; END IF;
  IF NEW.published IS NOT NULL AND (NEW.published->>'photoId') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM employee_card_photos WHERE id = (NEW.published->>'photoId')::uuid AND user_id = NEW.user_id
  ) THEN RAISE EXCEPTION 'published photo does not belong to the employee'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_cards_guard BEFORE INSERT OR UPDATE OR DELETE ON employee_cards
FOR EACH ROW EXECUTE FUNCTION guard_employee_card();

CREATE FUNCTION hide_employee_card_on_deactivation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status::text <> 'ACTIVE' THEN
    UPDATE employee_cards SET published = NULL, published_version = NULL, published_at = NULL,
      version = version + 1, updated_at = clock_timestamp()
      WHERE user_id = NEW.id AND published IS NOT NULL;
    IF FOUND THEN
      INSERT INTO audit_events(type, actor_user_id, target_user_id, reason, payload)
      VALUES ('EMPLOYEE_CARD_HIDDEN', NEW.deactivated_by, NEW.id,
        'Automaticky skryto při deaktivaci účtu', '{"source":"USER_DEACTIVATED"}'::jsonb);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_card_hide_on_deactivation AFTER UPDATE OF status ON users
FOR EACH ROW EXECUTE FUNCTION hide_employee_card_on_deactivation();

CREATE FUNCTION guard_employee_card_photo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'employee card photos are immutable'; END $$;
CREATE TRIGGER employee_card_photos_immutable BEFORE UPDATE OR DELETE ON employee_card_photos
FOR EACH ROW EXECUTE FUNCTION guard_employee_card_photo();
